function esc(str) {
  return String(str).replace(/[&<>"']/g, c => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[c]));
}

const CODE_EXAMPLE = {
  codeLanguage: "python",
  codeUrl: "/assets/data/code_example.py"
};

function renderCodePanel() {
  const root = document.getElementById("code-root");
  if (!root) return;

  const ex = CODE_EXAMPLE;

  root.innerHTML = `<p>Loading code artefact…</p>`;

  fetch(ex.codeUrl)
    .then(resp => {
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return resp.text();
    })
    .then(codeText => {
      root.innerHTML = `
        <section class="code-panel">
          <pre class="code-block">
<code class="language-${esc(ex.codeLanguage)}">${esc(codeText)}</code>
          </pre>
        </section>
      `;

      // ✅ highlight after we’ve inserted the code
      if (window.hljs) {
        root.querySelectorAll('pre code').forEach(block => {
          window.hljs.highlightElement(block);
        });
      }
    })
    .catch(err => {
      root.innerHTML = `
        <section class="code-panel">
          <p class="code-panel-error">
            Could not load code from
            <code>${esc(ex.codeUrl)}</code>: ${esc(err.message)}
          </p>
        </section>
      `;
    });
}



function wireCodeTab() {
  const tabCode = document.getElementById("tab-code");
  if (!tabCode) return;

  const panes = {
    "tab-table": document.getElementById("results"),
    "tab-editor": document.getElementById("editor-root"),
    "tab-doc": document.getElementById("doc-root"),
    "tab-converter": document.getElementById("converter-root"),
    "tab-code": document.getElementById("code-root")
  };

  tabCode.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    ev.stopImmediatePropagation?.();

    // Toggle active class on tabs
    const allTabs = document.querySelectorAll(".tab");
    allTabs.forEach(btn => btn.classList.remove("active"));
    tabCode.classList.add("active");

    // Hide all left-pane sections, then show the code panel
    Object.values(panes).forEach(el => {
      if (!el) return;
      el.style.display = "none";
    });
    if (panes["tab-code"]) {
      panes["tab-code"].style.display = "block";
    }
  });
}

window.addEventListener("DOMContentLoaded", () => {
  renderCodePanel();
  wireCodeTab();
});
