// HOW TO USE (minimal example):
// ----------------------------------------------------------
// <input type="file" id="xml-input" accept=".axml,.xml" />
// <input type="file" id="asce-input" accept=".ttl" />
// <input type="file" id="mapping-input" accept=".ttl" />
// <input type="file" id="ontogsn-input" accept=".ttl" />
// <button id="convert-btn">Convert to kettle.ttl</button>
//
// <script src="converter.js"></script>
// <script>
//   setupKettleConverter({
//     xmlInputId: "xml-input",
//     asceTtlInputId: "asce-input",
//     mappingTtlInputId: "mapping-input",
//     ontogsnTtlInputId: "ontogsn-input",
//     convertButtonId: "convert-btn"
//   });
// </script>
// ----------------------------------------------------------
//
// NOTE: The XML → TTL mapping is *schema-dependent*.
// I've provided a reasonable default based on a typical ASCE-like
// structure, but you will likely want to adjust `xmlToAsceTurtle`
// to match your actual ASCE XML schema (element/attribute names,
// IRIs, etc.).

(function () {
  "use strict";

  // --- Utility: read File objects to string -----------------------

  function fileToText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error);
      reader.onload = () => resolve(String(reader.result || ""));
      reader.readAsText(file);
    });
  }

  // --- Utility: trigger download of a text file -------------------

  function downloadText(filename, text) {
    const blob = new Blob([text], { type: "text/turtle;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

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
      "@prefix asce_m: <https://fortiss.github.io/OntoGSN/ontology/asce_m#> .",
      "@prefix gsn:  <https://w3id.org/OntoGSN/ontology#> .",
      ""
    ].join("\n");

    let body = "";

    // --- Map nodes ------------------------------------------------
    const nodeElements = Array.from(xmlDoc.querySelectorAll(nodeSelector));
    nodeElements.forEach((el) => {
      const id = el.getAttribute("id");
      if (!id) return;

      const type = el.getAttribute("type"); // e.g. "1" = Goal, "2" = Strategy, etc. (your mapping!)
      const statement =
        el.getAttribute("statement") ||
        el.getAttribute("description") ||
        el.textContent.trim();

      // Individual IRI for this node
      const nodeIri = `<${baseIri}node/${encodeURIComponent(id)}>`;
      const asceNodeClass = "asce:Node"; // TODO: adapt to your actual classes

      const lines = [];

      // Basic typing in ASCE ontology
      lines.push(`${nodeIri} a ${asceNodeClass}`);

      // Store the ASCE "type" as a data property (you probably have a better property name for this)
      if (type != null && type !== "") {
        lines.push(`  ; asce:nodeType "${escapeLiteral(type)}"`);
      }

      // Store the human-readable statement/description
      if (statement) {
        lines.push(`  ; asce:statement """${escapeMultilineLiteral(statement)}"""`);
      }

      // You can add more attribute mappings here as needed

      lines.push("  .");
      body += lines.join("\n") + "\n\n";
    });

    // --- Map links ------------------------------------------------
    const linkElements = Array.from(xmlDoc.querySelectorAll(linkSelector));
    linkElements.forEach((el) => {
      const id = el.getAttribute("id");
      const source = el.getAttribute("source");
      const target = el.getAttribute("target");
      const type = el.getAttribute("type"); // e.g. "1" = supportedBy, "2" = inContextOf, etc.

      if (!source || !target) return;

      const srcIri = `<${baseIri}node/${encodeURIComponent(source)}>`;
      const tgtIri = `<${baseIri}node/${encodeURIComponent(target)}>`;
      const linkIri = id
        ? `<${baseIri}link/${encodeURIComponent(id)}>`
        : null;

      // You probably have specific link classes/properties in ASCE:
      //    '1': (ASCE.Link,  GSN.supportedBy),
      //    '2': (ASCE.Link,  GSN.inContextOf),
      // etc.
      //
      // For now, we just encode them generically and also as data on the link.

      const linkClass = "asce:Link"; // TODO: adapt

      if (linkIri) {
        const lines = [];
        lines.push(`${linkIri} a ${linkClass}`);
        lines.push(`  ; asce:source ${srcIri}`);
        lines.push(`  ; asce:target ${tgtIri}`);
        if (type != null && type !== "") {
          lines.push(`  ; asce:linkType "${escapeLiteral(type)}"`);
        }
        lines.push("  .");
        body += lines.join("\n") + "\n\n";
      } else {
        // If no link ID, at least assert a relation directly between nodes:
        body += `${srcIri} asce:relatedTo ${tgtIri} .\n\n`;
      }
    });

    return header + body;
  }

  // --- Helpers for literals in Turtle -----------------------------

  function escapeLiteral(str) {
    return String(str).replace(/(["\\])/g, "\\$1").replace(/\n/g, "\\n");
  }

  function escapeMultilineLiteral(str) {
    // For """...""" literals: escape """ inside
    return String(str).replace(/"""/g, '\\"""');
  }

  // --- Step 2 & 3: Build combined graph --------------------------
  //
  // For now we interpret "populate the graph according to X TTL schema"
  // as: include those TTL *schemas/mappings* in the output file, next to
  // the instance data. You can then run an OWL reasoner on kettle.ttl
  // to materialize all OntoGSN-level statements.
  //
  // If you want *in-browser* materialization (apply owl:equivalentClass,
  // rdfs:subClassOf, etc.), you can extend this script with a small
  // OWL/RDFS rule engine later.

  /**
   * Merge:
   *  - asce.ttl (schema)
   *  - asce_ontogsn_mapping.ttl (mappings)
   *  - ontogsn.ttl (OntoGSN ontology)
   *  - instanceTtl (generated from kettle.axml)
   *
   * into a single Turtle document.
   *
   * @param {string} asceTtl
   * @param {string} mappingTtl
   * @param {string} ontogsnTtl
   * @param {string} instanceTtl
   * @param {object} options
   * @param {boolean} [options.embedSchemas=true] - if true, include the full content of the TTL schema files
   * @returns {string}
   */
  function buildCombinedKettleTurtle(
    asceTtl,
    mappingTtl,
    ontogsnTtl,
    instanceTtl,
    options = {}
  ) {
    const embedSchemas =
      options.embedSchemas === undefined ? true : !!options.embedSchemas;

    // Extract all @prefix lines from the three TTL ontologies, de-duplicate them
    const prefixLines = new Set();
    [asceTtl, mappingTtl, ontogsnTtl].forEach((ttl) => {
      ttl
        .split(/\r?\n/)
        .filter((line) => line.trim().startsWith("@prefix"))
        .forEach((line) => prefixLines.add(line.trim()));
    });

    // Also add a few core prefixes if not already present
    const ensurePrefix = (pfx, iri) => {
      const pattern = new RegExp(
        "^@prefix\\s+" + pfx.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&") + ":"
      );
      const exists = Array.from(prefixLines).some((l) => pattern.test(l));
      if (!exists) {
        prefixLines.add(`@prefix ${pfx}: <${iri}> .`);
      }
    };

    ensurePrefix("rdf", "http://www.w3.org/1999/02/22-rdf-syntax-ns#");
    ensurePrefix("rdfs", "http://www.w3.org/2000/01/rdf-schema#");
    ensurePrefix("xsd", "http://www.w3.org/2001/XMLSchema#");

    const header = Array.from(prefixLines).sort().join("\n") + "\n\n";

    let result = header;

    if (embedSchemas) {
      result += "# --- ASCE ontology (asce.ttl) ---\n\n";
      result += stripPrefixLines(asceTtl) + "\n\n";

      result += "# --- ASCE-OntoGSN mapping ontology (asce_ontogsn_mapping.ttl) ---\n\n";
      result += stripPrefixLines(mappingTtl) + "\n\n";

      result += "# --- OntoGSN ontology (ontogsn.ttl) ---\n\n";
      result += stripPrefixLines(ontogsnTtl) + "\n\n";
    }

    result += "# --- Instance data converted from kettle.axml ---\n\n";
    result += stripPrefixLines(instanceTtl) + "\n";

    return result;
  }

  function stripPrefixLines(ttl) {
    return ttl
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith("@prefix"))
      .join("\n")
      .trim();
  }

  // --- High-level pipeline function -------------------------------

  /**
   * Full pipeline:
   *  0. Take user-uploaded kettle.axml (ASCE XML).
   *  1. Convert to ASCE instance Turtle (xmlToAsceTurtle).
   *  2. Merge with asce.ttl (schema).
   *  3. Merge with asce_ontogsn_mapping.ttl (mapping).
   *  4. Merge with ontogsn.ttl (OntoGSN schema).
   *  5. Allow user to download kettle.ttl.
   *
   * @param {object} opts
   * @param {File}   opts.xmlFile              - kettle.axml
   * @param {File}   opts.asceTtlFile         - asce.ttl
   * @param {File}   opts.mappingTtlFile      - asce_ontogsn_mapping.ttl
   * @param {File}   opts.ontogsnTtlFile      - ontogsn.ttl
   * @param {string} [opts.baseIri]           - base IRI for instances
   * @param {string} [opts.outputFileName]    - default "kettle.ttl"
   * @param {boolean} [opts.embedSchemas]     - whether to embed the schema TTLs in the output
   */
  async function convertKettle(opts) {
    const {
      xmlFile,
      asceTtlFile,
      mappingTtlFile,
      ontogsnTtlFile,
      baseIri,
      outputFileName,
      embedSchemas
    } = opts;

    if (!xmlFile || !asceTtlFile || !mappingTtlFile || !ontogsnTtlFile) {
      throw new Error(
        "Missing file(s). Need xmlFile, asceTtlFile, mappingTtlFile, ontogsnTtlFile."
      );
    }

    // Read all files in parallel
    const [xmlText, asceTtl, mappingTtl, ontogsnTtl] = await Promise.all([
      fileToText(xmlFile),
      fileToText(asceTtlFile),
      fileToText(mappingTtlFile),
      fileToText(ontogsnTtlFile)
    ]);

    // Step 1: XML → ASCE instance TTL
    const instanceTtl = xmlToAsceTurtle(xmlText, { baseIri });

    // Steps 2–3: Combine ontology/mappings + instance data
    const combinedTtl = buildCombinedKettleTurtle(
      asceTtl,
      mappingTtl,
      ontogsnTtl,
      instanceTtl,
      { embedSchemas }
    );

    // Step 4: Download kettle.ttl
    downloadText(outputFileName || "kettle.ttl", combinedTtl);
  }

  // --- Optional: attach to a simple HTML UI -----------------------

  /**
   * Convenience wiring for a basic HTML UI with 4 <input type="file">
   * and one <button>.
   *
   * @param {object} config
   * @param {string} config.xmlInputId
   * @param {string} config.asceTtlInputId
   * @param {string} config.mappingTtlInputId
   * @param {string} config.ontogsnTtlInputId
   * @param {string} config.convertButtonId
   * @param {string} [config.baseIri]
   * @param {string} [config.outputFileName]
   * @param {boolean} [config.embedSchemas]
   */
  function setupKettleConverter(config) {
    const xmlInput = document.getElementById(config.xmlInputId);
    const asceInput = document.getElementById(config.asceTtlInputId);
    const mappingInput = document.getElementById(config.mappingTtlInputId);
    const ontogsnInput = document.getElementById(config.ontogsnTtlInputId);
    const button = document.getElementById(config.convertButtonId);

    if (!xmlInput || !asceInput || !mappingInput || !ontogsnInput || !button) {
      console.warn(
        "[converter.js] setupKettleConverter: One or more elements not found."
      );
      return;
    }

    button.addEventListener("click", async () => {
      try {
        const xmlFile = xmlInput.files[0];
        const asceTtlFile = asceInput.files[0];
        const mappingTtlFile = mappingInput.files[0];
        const ontogsnTtlFile = ontogsnInput.files[0];

        await convertKettle({
          xmlFile,
          asceTtlFile,
          mappingTtlFile,
          ontogsnTtlFile,
          baseIri: config.baseIri,
          outputFileName: config.outputFileName,
          embedSchemas:
            config.embedSchemas === undefined ? true : !!config.embedSchemas
        });
      } catch (err) {
        console.error("[converter.js] Conversion failed:", err);
        alert("Conversion failed: " + err.message);
      }
    });
  }

  // Expose main functions to the global scope
  window.convertKettle = convertKettle;
  window.setupKettleConverter = setupKettleConverter;
})();
