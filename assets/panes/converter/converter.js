import panes from "@core/panes.js";
import { mountTemplate, downloadText, resolveEl, readFileText, turtleEscapeLiteral, turtleEscapeMultilineLiteral } from "@core/utils.js";

// module-relative URLs (works on localhost + GH Pages)
const HTML = new URL("./converter.html", import.meta.url);
const CSS  = new URL("./converter.css",  import.meta.url);

// --- XML → ASCE instance Turtle -------------------------------------

function xmlToAsceTurtle(xmlText, options = {}) {
  const baseIri = options.baseIri || "https://example.org/kettle#";

  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(xmlText, "application/xml");

  // Quick error check
  const parserError = xmlDoc.getElementsByTagName("parsererror")[0];
  if (parserError) {
    throw new Error("XML parsing error: " + parserError.textContent);
  }

  const nodeSelector = "Node, node";
  const linkSelector = "Link, link";

  const header = [
    "@prefix rdf:  <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .",
    "@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .",
    "@prefix xsd:  <http://www.w3.org/2001/XMLSchema#> .",
    "@prefix asce: <https://fortiss.github.io/OntoGSN/ontology/asce#> .",
    "@prefix asce_m: <https://fortiss.github.io/OntoGSN/ontology/asce_mappings#> .",
    "@prefix gsn:  <https://w3id.org/OntoGSN/ontology#> .",
    ""
  ].join("\n");

  let body = "";

  // Helper to get trimmed text of a child element if present
  const getChildText = (el, tag) => {
    const child = el.querySelector(tag);
    return child ? child.textContent.trim() : null;
  };

  // --- Map nodes ----------------------------------------------------
  const nodeElements = Array.from(xmlDoc.querySelectorAll(nodeSelector));
  nodeElements.forEach((el) => {
    // Try several ways to get a stable node identifier
    const id =
      el.getAttribute("id") ||
      el.getAttribute("reference") ||
      getChildText(el, "reference");

    if (!id) return; // skip nodes we can't identify

    const typeStr =
      el.getAttribute("type") ||
      getChildText(el, "type");

    const userId =
      el.getAttribute("user-id") ||
      getChildText(el, "user-id");

    const rawUserTitle =
      el.getAttribute("user-title") ||
      getChildText(el, "user-title");

    let statement = null;

    // Prefer an explicit user-title if it has content
    if (rawUserTitle && rawUserTitle.trim() !== "") {
      statement = rawUserTitle.trim();
    } else {
      // very simple fallback: look for generic text/text-like children
      statement =
        getChildText(el, "Text") ||
        getChildText(el, "text") ||
        null;
    }

    const nodeIri = `<${baseIri}node/${encodeURIComponent(id)}>`;
    const lines = [];

    // Class
    lines.push(`${nodeIri} a asce:Node`);

    // Optional: userId
    if (userId) {
      lines.push(`  ; asce:userId "${turtleEscapeLiteral(userId)}"`);
    }

    // Node type as asce:type (aligned with asce.ttl)
    if (typeStr != null && typeStr !== "") {
      const n = Number(typeStr);
      if (Number.isInteger(n) && n >= 0) {
        lines.push(`  ; asce:type "${n}"^^xsd:nonNegativeInteger`);
      } else {
        // fallback if the XML has non-numeric type values
        lines.push(`  ; asce:type "${turtleEscapeLiteral(typeStr)}"`);
      }
    }

    // Node label / statement as asce:userTitle (subproperty of gsn:statement)
    if (statement) {
      lines.push(
        `  ; asce:userTitle """${turtleEscapeMultilineLiteral(statement)}"""`
      );
    }

    lines.push("  .");
    body += lines.join("\n") + "\n\n";
  });

  // --- Map links ----------------------------------------------------
  const linkElements = Array.from(xmlDoc.querySelectorAll(linkSelector));
  linkElements.forEach((el) => {
    // Source/target: support both attribute form and ASCE child element form
    const source =
      el.getAttribute("source") ||
      getChildText(el, "source-reference");

    const target =
      el.getAttribute("target") ||
      getChildText(el, "destination-reference");

    if (!source || !target) return;

    const typeStr =
      el.getAttribute("type") ||
      getChildText(el, "type");

    // Link ID: use id/reference/reference child, or generate one
    let linkId =
      el.getAttribute("id") ||
      el.getAttribute("reference") ||
      getChildText(el, "reference");

    if (!linkId) {
      linkId = `auto-${source}-${target}`;
    }

    const srcIri  = `<${baseIri}node/${encodeURIComponent(source)}>`;
    const tgtIri  = `<${baseIri}node/${encodeURIComponent(target)}>`;
    const linkIri = `<${baseIri}link/${encodeURIComponent(linkId)}>`;
    const lines   = [];

    // Reified link: also mark as gsn:Relationship for convenience
    lines.push(`${linkIri} a asce:Link, gsn:Relationship`);
    lines.push(`  ; asce:startReference ${srcIri}`);
    lines.push(`  ; asce:endReference ${tgtIri}`);

    let typeNum = null;
    if (typeStr != null && typeStr !== "") {
      const n = Number(typeStr);
      if (Number.isInteger(n) && n >= 0) {
        typeNum = n;
        lines.push(`  ; asce:type "${n}"^^xsd:nonNegativeInteger`);
      } else {
        lines.push(`  ; asce:type "${turtleEscapeLiteral(typeStr)}"`);
      }
    }

    lines.push("  .");
    body += lines.join("\n") + "\n\n";

    // --- Materialize direct GSN edges between nodes -----------------
    // Interpretation:
    //   source-reference     = supporting/child node
    //   destination-reference = supported/parent node

    if (typeNum === 1) {
      // Supported-by link: parent supportedBy child
      body += `${tgtIri} gsn:supportedBy ${srcIri} .\n\n`;
    } else if (typeNum === 2) {
      // Context link: parent inContextOf context
      body += `${tgtIri} gsn:inContextOf ${srcIri} .\n\n`;
    }
  });

  return header + body;
}

// --- high-level conversion for a single XML file -------------------

async function convertXmlFile(file, { baseIri } = {}) {
  const xmlText = await readFileText(file);
  return xmlToAsceTurtle(xmlText, { baseIri });
}

// --- Converter panel wiring ----------------------------------------

let lastConvertedTtl = null;

async function setupConverterPanel() {
  const root = resolveEl("#converter-root", { required: false });
  if (!root) return;

  await mountTemplate(root, { templateUrl: HTML, cssUrl: CSS });

  const fileInput   = root.querySelector("#kettle-axml-input");
  const convertBtn  = root.querySelector("#kettle-convert-btn");
  const downloadBtn = root.querySelector("#kettle-download-btn");
  const logEl       = root.querySelector("#kettle-log");

  const log = (msg) => { if (logEl) logEl.textContent = msg; };

  convertBtn?.addEventListener("click", async () => {
    const file = fileInput?.files?.[0];
    if (!file) { log("Please select an .axml/.xml file first."); return; }

    convertBtn.disabled  = true;
    downloadBtn.disabled = true;
    log("Converting…");

    try {
      lastConvertedTtl = await convertXmlFile(file, { baseIri: "https://example.org/kettle#" });
      log(`Conversion succeeded. TTL size: ${lastConvertedTtl.length.toLocaleString()} characters.` );
      downloadBtn.disabled = false;
    } catch (err) {
      console.error("[converter] Conversion failed:", err);
      log("Conversion failed: " + (err.message || err));
    } finally {
      convertBtn.disabled = false;
    }
  });

  downloadBtn?.addEventListener("click", () => {
    if (!lastConvertedTtl) return;
    const originalName = fileInput?.files?.[0]?.name || "kettle.axml";
    const ttlName = originalName.replace(/\.[^.]+$/, "") + ".ttl";
    downloadText(ttlName, lastConvertedTtl, { mime: "text/turtle;charset=utf-8" });
  });
}

window.addEventListener("DOMContentLoaded", () => {
  panes.initLeftTabs();
  setupConverterPanel();
});
