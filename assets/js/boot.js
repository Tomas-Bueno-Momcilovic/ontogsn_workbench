import app from "./queries.js";
import { PATHS } from "./rdf/config.js";

async function boot() {
  try {
    await app.init();                 // wires UI + prepares store/service
    await app.run(PATHS.q.visualize); // initial graph
  } catch (e) {
    console.error("[boot] failed:", e);
  }
}

// Modules are deferred, but be safe if boot.js ever gets moved earlier.
if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}
