param(
  [int]$Port = 8000,
  [string]$Root = (Get-Location).Path
)

$Root = (Resolve-Path $Root).Path.TrimEnd('\') + '\'
$prefix = "http://localhost:$Port/"

$mime = @{
  ".html"="text/html; charset=utf-8"
  ".htm" ="text/html; charset=utf-8"
  ".css" ="text/css; charset=utf-8"
  ".js"  ="text/javascript; charset=utf-8"
  ".mjs" ="text/javascript; charset=utf-8"
  ".json"="application/json; charset=utf-8"
  ".svg" ="image/svg+xml"
  ".png" ="image/png"
  ".jpg" ="image/jpeg"
  ".jpeg"="image/jpeg"
  ".gif" ="image/gif"
  ".ico" ="image/x-icon"
  ".txt" ="text/plain; charset=utf-8"
  ".md"  ="text/markdown; charset=utf-8"
  ".ttl" ="text/turtle; charset=utf-8"
  ".rdf" ="application/rdf+xml; charset=utf-8"
  ".xml" ="application/xml; charset=utf-8"
  ".sparql"="application/sparql-query; charset=utf-8"
  ".axml"="application/xml; charset=utf-8"
}

# --- Denylist -------------------------------------------------------------
# Block sensitive files / folders from being served
$DeniedExtensions = @(
  ".ps1", ".psm1", ".exe", ".dll",
  ".env", ".pem", ".key", ".pfx",
  ".cer", ".crt",
  ".config", ".ini"
)

$DeniedNames = @(
  ".git", ".gitignore", ".gitattributes",
  ".vscode", ".idea",
  "node_modules",
  "launch_server.ps1"
)

function Is-DeniedPath([string]$fullPath) {
  $name = [IO.Path]::GetFileName($fullPath)
  $ext  = [IO.Path]::GetExtension($fullPath).ToLowerInvariant()

  if ($DeniedExtensions -contains $ext) { return $true }
  if ($DeniedNames -contains $name)     { return $true }

  # Block hidden dot-directories anywhere in the path (e.g. .git/objects)
  foreach ($part in $fullPath.Split([IO.Path]::DirectorySeparatorChar)) {
    if ($part.StartsWith(".")) { return $true }
  }

  return $false
}

function Send-Text($resp, [int]$code, [string]$text) {
  $bytes = [Text.Encoding]::UTF8.GetBytes($text)
  $resp.StatusCode = $code
  $resp.ContentType = "text/plain; charset=utf-8"
  $resp.ContentLength64 = $bytes.Length
  $resp.OutputStream.Write($bytes, 0, $bytes.Length)
  $resp.OutputStream.Close()
}

$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add($prefix)

try {
  $listener.Start()
  Write-Host "Serving $Root"
  Write-Host "Listening on $prefix  (Ctrl+C to stop)"

  while ($listener.IsListening) {
    $ctx  = $listener.GetContext()
    $req  = $ctx.Request
    $resp = $ctx.Response

    try {
      $path = [Uri]::UnescapeDataString($req.Url.AbsolutePath).TrimStart('/')
      if ([string]::IsNullOrWhiteSpace($path)) { $path = "index.html" }

      # Prevent path traversal
      $candidate = [IO.Path]::GetFullPath([IO.Path]::Combine($Root, $path))
      if (-not $candidate.StartsWith($Root, [StringComparison]::OrdinalIgnoreCase)) {
        Send-Text $resp 400 "Bad request"
        continue
      }

      if (Test-Path -LiteralPath $candidate -PathType Container) {
        $index = Join-Path $candidate "index.html"
        if (Test-Path -LiteralPath $index -PathType Leaf) {
          $candidate = $index
        } else {
          # Simple directory listing (optional)
          $items = Get-ChildItem -LiteralPath $candidate | ForEach-Object {
            $n = $_.Name + ($(if ($_.PSIsContainer) { "/" } else { "" }))
            "<li><a href=""$n"">$n</a></li>"
          }
          $html = "<!doctype html><meta charset=utf-8><h1>Index of /$path</h1><ul>$($items -join '')</ul>"
          $bytes = [Text.Encoding]::UTF8.GetBytes($html)
          $resp.StatusCode = 200
          $resp.ContentType = "text/html; charset=utf-8"
          $resp.ContentLength64 = $bytes.Length
          $resp.OutputStream.Write($bytes, 0, $bytes.Length)
          $resp.OutputStream.Close()
          continue
        }
      }

      if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
        Send-Text $resp 404 "Not found"
        continue
      }

      if (Is-DeniedPath $candidate) {
        Send-Text $resp 403 "Forbidden"
        continue
      }

      $ext = [IO.Path]::GetExtension($candidate).ToLowerInvariant()
      $resp.ContentType = $(if ($mime.ContainsKey($ext)) { $mime[$ext] } else { "application/octet-stream" })
      $resp.AddHeader("Cache-Control", "no-cache")

      $bytes = [IO.File]::ReadAllBytes($candidate)
      $resp.StatusCode = 200
      $resp.ContentLength64 = $bytes.Length
      $resp.OutputStream.Write($bytes, 0, $bytes.Length)
      $resp.OutputStream.Close()
    }
    catch {
      try { Send-Text $resp 500 ("Server error: " + $_.Exception.Message) } catch {}
    }
  }
}
catch {
  Write-Error $_

  Write-Host "`nIf you get an access/ACL error, run ONE of these (as Administrator):"
  Write-Host "  netsh http add urlacl url=$prefix user=$env:USERNAME"
  Write-Host "or pick another port (e.g. 8080)."
}
finally {
  if ($listener.IsListening) { $listener.Stop() }
  $listener.Close()
}
