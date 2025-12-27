import queries from "./queries.js";
import { PATHS } from "./rdf/config.js";
import { bus } from "./events.js";
import panes from "./panes.js";
import { shortenIri } from "./rdf/sparql.js";

async function boot() {
  try {
    await queries.init();
    panes.initLeftTabs();
    panes.initRightTabs();
  } catch (e) {
    console.error("[boot] failed:", e);
  }
}

if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}
