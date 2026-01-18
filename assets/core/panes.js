import { bus } from "@core/events.js";
import { firstEl, resolveEl, safeInvoke } from "@core/utils.js";

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

    this.ctx = {};
    this._paneDefs = { left: new Map(), right: new Map() };        // paneId -> { loader, cache }
    this._paneState = { left: new Map(), right: new Map() };       // paneId -> { mod, cleanup, mounted }
    this._activePaneId = { left: null, right: null };
    this._activateSeq = 0; // guards against async race on fast clicks
  }

  setContext(ctx) {
    this.ctx = { ...(this.ctx || {}), ...(ctx || {}) };
  }

  registerPane(slot, paneId, loader, { cache = true } = {}) {
    this._paneDefs[slot]?.set(paneId, { loader, cache });
  }

  async _deactivatePane(slot, paneId) {
    if (!paneId) return;

    const state = this._paneState[slot].get(paneId);
    if (!state) return;

    // Prefer explicit suspend/unmount, then fallback to cleanup function
    try {
      if (state.mod?.suspend) await state.mod.suspend({ ...this.ctx, bus: this.bus, panes: this, slot, paneId });
      if (state.mod?.unmount) await state.mod.unmount({ ...this.ctx, bus: this.bus, panes: this, slot, paneId });
      if (typeof state.cleanup === "function") state.cleanup();
    } catch (e) {
      console.warn(`[PaneManager] deactivate failed for ${slot}:${paneId}`, e);
    }

    state.cleanup = null;
    state.mounted = false;

    const def = this._paneDefs[slot].get(paneId);
    if (def && def.cache === false) {
      // free memory / force re-import next time
      this._paneState[slot].delete(paneId);
    } else {
      this._paneState[slot].set(paneId, state);
    }
  }

  async _activatePane(slot, paneId, payload) {
    if (!paneId) return;

    const seq = ++this._activateSeq;

    // no-op if already active
    if (this._activePaneId[slot] === paneId) {
      const state = this._paneState[slot].get(paneId);
      if (state?.mod?.resume) {
        try { await state.mod.resume({ ...this.ctx, bus: this.bus, panes: this, slot, paneId, payload }); } catch {}
      }
      return;
    }

    // deactivate previous
    const prev = this._activePaneId[slot];
    this._activePaneId[slot] = paneId;
    await this._deactivatePane(slot, prev);

    // if user clicked again quickly, abandon this activation
    if (seq !== this._activateSeq) return;

    // load module (lazy)
    const def = this._paneDefs[slot].get(paneId);
    if (!def?.loader) return; // static pane => only hide/show is enough

    let state = this._paneState[slot].get(paneId) || { mod: null, cleanup: null, mounted: false };

    if (!state.mod) {
      state.mod = await def.loader();
    }

    // mount/resume
    const root = document.getElementById(paneId);
    if (!root) {
      console.warn(`[PaneManager] pane root #${paneId} not found`);
      return;
    }

    try {
      if (!state.mounted && state.mod?.mount) {
        const cleanup = await state.mod.mount({ ...this.ctx, bus: this.bus, panes: this, slot, paneId, root, payload });
        state.cleanup = (typeof cleanup === "function") ? cleanup : null;
        state.mounted = true;
      } else if (state.mod?.resume) {
        await state.mod.resume({ ...this.ctx, bus: this.bus, panes: this, slot, paneId, root, payload });
      }
    } catch (e) {
      console.error(`[PaneManager] mount failed for ${slot}:${paneId}`, e);
    }

    this._paneState[slot].set(paneId, state);
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

    return firstEl(tryIds, { root }) ?? root;

  }

  setBus(bus) { this.bus = bus || null; }
  getRightController() { return this.currentRight?.controller ?? null; }

  // --- Shared tab wiring --------------------------------------------------
  _initTabGroup({
    groupName,                 // e.g. "left-main"
    slot,                      // "left" | "right"
    paneDefaultSelector = null
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

      const payload = emitPayload(b, paneId);

      safeInvoke(this.bus, "emit", `${slot}:tab`, payload);
      safeInvoke(this.bus, "emit", "pane:tab", payload);

      Promise.resolve(this._activatePane(slot, paneId, payload))
        .catch((e) => console.error(`[PaneManager] activatePane failed ${slot}:${paneId}`, e));

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
