import { bus } from "./events.js";
import { firstEl, resolveEl, safeInvoke } from "./utils.js";

class PaneManager {
  constructor() {
    this.leftPane = null;
    this.rightPane = null;

    this.currentRight = null;
    this._resizeHandler = null;
    this.bus = null;

    this._leftTabsInit = false;
    this._rightTabsInit = false;

    this._leftTabs = [];
    this._rightTabs = [];
    this._leftPanes = [];
    this._rightPanes = [];

    this._activateLeftTab = null;
    this._activateRightTab = null;
  }

  // --- DOM helpers -------------------------------------------------------
  getLeftPane() {
    if (this.leftPane && document.body.contains(this.leftPane)) return this.leftPane;
    this.leftPane = resolveEl("#leftPane", { required: false, name: "PaneManager leftPane" });
    if (!this.leftPane) console.warn("[PaneManager] #leftPane not found");
    return this.leftPane;
  }

  getRightPane(viewOrPaneId = null) {
    const root =
      (this.rightPane && document.body.contains(this.rightPane))
        ? this.rightPane
        : (this.rightPane = firstEl(["#rightPane", "#graph", ".gsn-host"]));

    if (!root) {
      console.warn("[PaneManager] #rightPane / .gsn-host not found");
      return null;
    }

    if (!viewOrPaneId) return root;

    // Try common conventions: `${view}-root` or direct id
    const tryIds = [
      `#${viewOrPaneId}`,
      `#${viewOrPaneId}-root`,
    ];

    return firstEl(tryIds, root) ?? root;
  }

  setBus(bus) { this.bus = bus || null; }
  getRightController() { return this.currentRight?.controller ?? null; }

  // --- Shared tab wiring --------------------------------------------------
  _initTabGroup({
    groupName,                 // e.g. "left-main"
    slot,                      // "left" | "right"
    paneDefaultSelector = null // optional fallback if no data-pane
  }) {
    const groupEl = document.querySelector(`[data-tab-group="${groupName}"]`);
    const tabs = groupEl ? Array.from(groupEl.querySelectorAll("button.tab")) : [];

    if (!tabs.length) {
      console.warn(`[PaneManager] No ${slot} tab buttons found.`);
      return { tabs: [], panes: [], activate: () => {} };
    }

    const paneIdOf = (btn) =>
      btn.dataset.pane || btn.dataset.view || (paneDefaultSelector ? paneDefaultSelector(btn) : null);

    // Collect panes that exist (if you have data-pane on the buttons)
    const paneIds = tabs.map(paneIdOf).filter(Boolean);
    const panes = paneIds
      .map(id => document.getElementById(id))
      .filter(Boolean);

    const showOnlyPaneId = (targetId) => {
      if (!targetId || !panes.length) return;
      panes.forEach(p => { p.hidden = (p.id !== targetId); });
    };

    const emitPayload = (btn, paneId) => ({
      slot,
      tabId: btn.id || null,
      view: btn.dataset.view || null,
      paneId: paneId || null,
      query: btn.dataset.query || null,
      docQuery: btn.dataset.docQuery || null,
      docVar: btn.dataset.docVar || null,
    });

    const activate = (btnOrId) => {
      const btn = (typeof btnOrId === "string")
        ? tabs.find(b => b.id === btnOrId)
        : btnOrId;

      const b = btn || tabs[0];
      if (!b) return;

      tabs.forEach(x => x.classList.toggle("active", x === b));

      const paneId = paneIdOf(b);
      showOnlyPaneId(paneId);

      // Standardized emits:
      // - slot-specific (backwards/explicit)
      // - generic (future-proof)
      safeInvoke(this.bus, "emit", `${slot}:tab`, emitPayload(b, paneId));
      safeInvoke(this.bus, "emit", "pane:tab", emitPayload(b, paneId));
    };

    tabs.forEach(btn => {
      btn.addEventListener("click", (ev) => {
        ev.preventDefault();
        activate(btn);
      });
    });

    const initiallyActive = tabs.find(b => b.classList.contains("active")) || tabs[0];
    activate(initiallyActive);

    return { tabs, panes, activate };
  }

  // --- Left pane ----------------------------------------------------------
  initLeftTabs() {
    if (this._leftTabsInit) return;
    this._leftTabsInit = true;

    const { tabs, panes, activate } = this._initTabGroup({
      groupName: "left-main",
      slot: "left",
    });

    this._leftTabs = tabs;
    this._leftPanes = panes;
    this._activateLeftTab = activate;
  }

  activateLeftTab(tabId) {
    if (!this._leftTabsInit) this.initLeftTabs();
    this._activateLeftTab?.(tabId);
  }

  // --- Right pane ---------------------------------------------------------
  initRightTabs() {
    if (this._rightTabsInit) return;
    this._rightTabsInit = true;

    const { tabs, panes, activate } = this._initTabGroup({
      groupName: "right-main",
      slot: "right",
    });

    this._rightTabs = tabs;
    this._rightPanes = panes;
    this._activateRightTab = activate;
  }

  activateRightTab(tabId) {
    if (!this._rightTabsInit) this.initRightTabs();
    this._activateRightTab?.(tabId);
  }

  // --- Right pane controller lifecycle -----------------------------------
  setRightController(id, controller) {
    this._teardownRight();
    this.currentRight = { id, controller };

    safeInvoke(this.bus, "emit", "right:controllerChanged", { id, controller });
    if (id === "graph" || id === "gsn-graph") {
      safeInvoke(this.bus, "emit", "graph:ready", { controller });
    }

    if (controller && typeof controller.fit === "function") {
      this._resizeHandler = () => safeInvoke(controller, "fit");
      window.addEventListener("resize", this._resizeHandler);
    }
  }

  clearRightPane() { this._teardownRight(); }

  _teardownRight() {
    const current = this.currentRight;
    this.currentRight = null;

    safeInvoke(this.bus, "emit", "right:controllerChanged", { id: null, controller: null });

    if (this._resizeHandler) {
      window.removeEventListener("resize", this._resizeHandler);
      this._resizeHandler = null;
    }

    safeInvoke(current?.controller, "destroy");
  }
}

export const panes = new PaneManager();
panes.setBus(bus);
export default panes;
