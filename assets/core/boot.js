import queries from "@core/queries.js";
import panes from "@core/panes.js";

import "@panes/document/welcome.js"
import "@panes/checklist/checklist.js"
import "@panes/settings/settings.js"
import "@panes/graph/graph.js"
import "@panes/layers/layers.js"
import "@panes/model/model.js"
import "@panes/editor/editor.js"
import "@panes/table/table.js"
import "@panes/document/document.js"
import "@panes/converter/converter.js"
import "@panes/audio/audio.js"
import "@panes/code/code.js"
import "@panes/terminal/terminal.js"
import "@panes/chat/chat.js"

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
