import { bus } from "./events.js";

class PaneManager {
  constructor() {
    /** @type {HTMLElement|null} */
    this.leftPane = null;
    /** @type {HTMLElement|null} */
    this.rightPane = null;

    /** @type {{id:string, controller:any}|null} */
    this.currentRight = null;

    /** @type {((ev:UIEvent)=>void)|null} */
    this._resizeHandler = null;

    /** @type {{ on:Function, emit:Function } | null} */
    this.bus = null;

    // --- left-side tabs/panes --------------------------------------------
    this._leftTabsInit = false;
    /** @type {HTMLButtonElement[]} */
    this._leftTabs = [];
    /** @type {HTMLElement[]} */
    this._leftPanes = [];
    /** @type {Record<string,string>} tab-id → pane-id */
    this._tabToPane = {
      "tab-welcome":    "welcome-root",
      "tab-table":      "results",
      "tab-editor":     "editor-root",
      "tab-doc":        "doc-root",
      "tab-code":       "code-root",
      "tab-converter":  "converter-root",
      "tab-chat":       "chat-root"
    };
  }

  // --- DOM helpers -------------------------------------------------------
  getLeftPane() {
    if (this.leftPane && document.body.contains(this.leftPane)) {
      return this.leftPane;
    }
    this.leftPane = document.getElementById("leftPane");
    if (!this.leftPane) {
      console.warn("[PaneManager] #leftPane not found");
    }
    return this.leftPane;
  }

  getRightPane() {
    if (this.rightPane && document.body.contains(this.rightPane)) {
      return this.rightPane;
    }
    this.rightPane =
      document.getElementById("rightPane") ||
      // fallback for older markup
      document.getElementById("graph") ||
      document.querySelector(".gsn-host");

    if (!this.rightPane) {
      console.warn("[PaneManager] #rightPane / .gsn-host not found");
    }
    return this.rightPane;
  }

  setBus(bus) {
    this.bus = bus || null;
  }

  getRightController() {
    return this.currentRight?.controller ?? null;
  }

  // --- Left pane: tabs + content ----------------------------------------

  /**
   * Initialise left-side tab behaviour (Table / Editor / Document / Code / Converter).
   * Safe to call multiple times; later calls are ignored.
   */
  initLeftTabs() {
    if (this._leftTabsInit) return;
    this._leftTabsInit = true;

    // Use the tab group (avoids duplicate IDs entirely)
    const leftButtons = document.querySelector('[data-tab-group="left-main"]');

    const tabs = leftButtons
      ? Array.from(leftButtons.querySelectorAll('button.tab[data-pane]'))
      : [];

    if (!tabs.length) {
      console.warn("[PaneManager] No left tab buttons found.");
      return;
    }

    this._leftTabs = tabs;

    // Build mapping from data-pane
    this._tabToPane = Object.fromEntries(
      tabs.map(btn => [btn.id, btn.dataset.pane])
    );

    // Collect panes that exist
    this._leftPanes = Object.values(this._tabToPane)
      .map(id => document.getElementById(id))
      .filter(Boolean);

    const activate = (tabId) => {
      const fallback = tabs[0]?.id;        // first tab becomes fallback
      if (!tabId || !this._tabToPane[tabId]) tabId = fallback;

      this._leftTabs.forEach(btn => {
        btn.classList.toggle("active", btn.id === tabId);
      });

      const targetPaneId = this._tabToPane[tabId];
      this._leftPanes.forEach(p => {
        p.style.display = (p.id === targetPaneId ? "" : "none");
      });
    };

    this._activateLeftTab = activate;

    this._leftTabs.forEach(btn => {
      btn.addEventListener("click", () => this.activateLeftTab(btn.id));
    });

    const initiallyActive =
      tabs.find(b => b.classList.contains("active"))?.id || tabs[0]?.id;

    activate(initiallyActive);
  }


  /**
   * Public helper for other modules: activate a given left tab
   * (and therefore hide all other left panes).
   */
  activateLeftTab(tabId) {
    if (!this._leftTabsInit) {
      this.initLeftTabs();
    }
    if (typeof this._activateLeftTab === "function") {
      this._activateLeftTab(tabId);
    }
  }

  // --- Right pane controller lifecycle -----------------------------------
  setRightController(id, controller) {
    // Tear down any existing controller first
    this._teardownRight();

    this.currentRight = { id, controller };

    this.bus?.emit?.("right:controllerChanged", { id, controller });
    if (id === "graph" || id === "gsn-graph") {
      this.bus?.emit?.("graph:ready", { controller });
    }

    // Wire up auto-resize if the controller supports it
    if (controller && typeof controller.fit === "function") {
      this._resizeHandler = () => {
        try {
          controller.fit();
        } catch (e) {
          console.warn("[PaneManager] controller.fit() failed:", e);
        }
      };
      window.addEventListener("resize", this._resizeHandler);
    }
  }

  clearRightPane() {
    this._teardownRight();
  }

  _teardownRight() {
    const current = this.currentRight;
    this.currentRight = null;

    this.bus?.emit?.("right:controllerChanged", { id: null, controller: null });

    if (this._resizeHandler) {
      window.removeEventListener("resize", this._resizeHandler);
      this._resizeHandler = null;
    }

    if (current && current.controller && typeof current.controller.destroy === "function") {
      try {
        current.controller.destroy();
      } catch (e) {
        console.warn("[PaneManager] controller.destroy() failed:", e);
      }
    }
  }
}

window.addEventListener("DOMContentLoaded", () => {
  panes.initLeftTabs();
});

export const panes = new PaneManager();
panes.setBus(bus);
export default panes;
