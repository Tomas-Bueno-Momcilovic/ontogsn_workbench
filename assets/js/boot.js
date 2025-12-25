import queries from "./queries.js";
import { createGraphApp } from "./graph.js";
import { PATHS } from "./rdf/config.js";
import { bus } from "./events.js";
import panes from "./panes.js";
import { shortenIri } from "./rdf/sparql.js";

async function boot() {
  try {
    await queries.init(); // store + queryService only (no DOM listeners)

    const graph = createGraphApp({
      panes,
      bus,
      qs: queries.qs,     // query service
      paths: PATHS,
      labelFn: shortenIri,
    });

    await graph.init();                 // wires graph UI + bus handlers
    await graph.run(PATHS.q.visualize); // initial graph render
  } catch (e) {
    console.error("[boot] failed:", e);
  }
}

if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}
