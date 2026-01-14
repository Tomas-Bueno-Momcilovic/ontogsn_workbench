import queries from "./queries.js";
import panes from "./panes.js";

async function boot() {
  try {
    await queries.init();

    panes.setContext({ queries });

    panes.registerPane("left", "welcome-root",   () => import("./welcome.js"));
    panes.registerPane("left", "settings-root", () => import("./settings.js"));
    panes.registerPane("left", "editor-root",   () => import("./editor.js"));
    panes.registerPane("left", "results",       () => import("./table.js"));
    panes.registerPane("left", "doc-root",      () => import("./document.js"));
    panes.registerPane("left", "converter-root",() => import("./converter.js"));
    panes.registerPane("left", "code-root",     () => import("./code.js"));
    panes.registerPane("left", "chat-root",     () => import("./chat.js"));

    panes.registerPane("right","graph-root",    () => import("./graph.js"), { cache: false });
    panes.registerPane("right","layered-root",  () => import("./layers.js"));
    panes.registerPane("right","model-root",    () => import("./model.js"));

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
