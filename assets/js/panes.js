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

  // --- Right pane controller lifecycle -----------------------------------
  setRightController(id, controller) {
    // Tear down any existing controller first
    this._teardownRight();

    this.currentRight = { id, controller };

    // Expose for console debugging, if you like
    if (controller) {
      window.graphCtl = controller;
    } else {
      window.graphCtl = null;
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

    if (window.graphCtl) {
      window.graphCtl = null;
    }
  }
}

export const panes = new PaneManager();
export default panes;
