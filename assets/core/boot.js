import queries from "@core/queries.js";
import panes from "@core/panes.js";

async function boot() {
  try {
    await queries.init();

    panes.setContext({ queries });

    panes.registerPane("left", "checklist-root",  () => import("@panes/checklist/checklist.js"));
    panes.registerPane("left", "settings-root",   () => import("@panes/settings/settings.js"));
    panes.registerPane("left", "editor-root",     () => import("@panes/editor/editor.js"));
    panes.registerPane("left", "results",         () => import("@panes/table/table.js"));
    panes.registerPane("left", "doc-root",        () => import("@panes/document/document.js"));
    panes.registerPane("left", "converter-root",  () => import("@panes/converter/converter.js"));
    panes.registerPane("left", "code-root",       () => import("@panes/code/code.js"));
    panes.registerPane("left", "terminal-root",   () => import("@panes/terminal/terminal.js"));
    panes.registerPane("left", "chat-root",       () => import("@panes/chat/chat.js"));

    panes.registerPane("right", "audio-root",      () => import("@panes/audio/audio.js"));
    panes.registerPane("right", "video-root",      () => import("@panes/video/video.js"));
    panes.registerPane("right", "graph-root",     () => import("@panes/graph/graph.js"), { cache: false });
    panes.registerPane("right", "layers-root",   () => import("@panes/layers/layers.js"));
    panes.registerPane("right", "model-root",     () => import("@panes/model/model.js"));

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
