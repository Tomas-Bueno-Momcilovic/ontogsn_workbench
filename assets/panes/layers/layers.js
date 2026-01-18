import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7/+esm";
import app from "@core/queries.js";
//import panes from "@core/panes.js";
import {
  ensureCss,
  repoHref,
  fetchRepoText,
  resolveEl,
  uid,
  bindingsToRows,
  shortenIri,
  labelWidthPx,
  inferGsnKind,
} from "@core/utils.js";
import { bus } from "@core/events.js";

ensureCss(repoHref("panes/graph/graph.css", { from: import.meta.url, upLevels: 2 }));

const NODE_H = 26;

// ============================================================================
// Pure renderer (controller-style) — safe to call repeatedly
// ============================================================================

export function visualizeLayers(
  rows,
  {
    mount = ".gsn-host",
    width = null,
    height = 520,
    label = shortenIri,
    laneLabels = null,
    laneCount = null,
    assignLayer = null,
    allowEmptyLanes = true,
  } = {}
) {
  // --- Helpers ---------------------------------------------------------

  const val = (x) => (x && typeof x === "object" && "value" in x ? x.value : x);
  const norm = (x) => String(x ?? "").trim();

  // --- Resolve mount & bootstrap container ----------------------------

  const rootEl = typeof mount === "string" ? document.querySelector(mount) : mount;
  if (!rootEl) throw new Error(`visualizeLayers: mount "${mount}" not found`);

  rootEl.innerHTML = `
    <div class="gsn-legend">
      <span><span class="gsn-badge"></span> supported by</span>
      <span class="gsn-hint">scroll: zoom • drag: pan</span>
      <span class="gsn-controls">
        <button class="gsn-btn" data-act="fit">Fit</button>
        <button class="gsn-btn" data-act="reset">Reset</button>
      </span>
    </div>
    <svg class="gsn-svg"><g class="gsn-viewport"></g></svg>
  `;

  const svgNode = rootEl.querySelector(".gsn-svg");
  if (!svgNode) throw new Error("visualizeLayers: internal error – svg root not found");

  const rect = rootEl.getBoundingClientRect();
  const pixelWidth = width ?? Math.max(300, rect.width || 800);

  svgNode.setAttribute("width", String(pixelWidth));
  svgNode.setAttribute("height", String(height));

  const svg = d3.select(svgNode);
  const g = svg.select(".gsn-viewport");
  const defs = svg.append("defs");

  // Arrowheads
  function marker(id) {
    const m = defs
      .append("marker")
      .attr("id", id)
      .attr("viewBox", "0 0 10 10")
      .attr("refX", 9)
      .attr("refY", 5)
      .attr("markerWidth", 8)
      .attr("markerHeight", 8)
      .attr("orient", "auto-start-reverse")
      .attr("class", "gsn-marker norm");
    m.append("path").attr("d", "M0,0 L10,5 L0,10 Z").attr("fill", "currentColor");
  }

  const idArrow = uid("arrow-");
  marker(idArrow);

  // --- Build adjacency (supportedBy only) -----------------------------

  const SUP = new Set([
    "supported by",
    "gsn:supportedBy",
    "https://w3id.org/OntoGSN/ontology#supportedBy",
    "http://w3id.org/gsn#supportedBy",
  ]);

  const nodeType = new Map();
  const children = new Map(); // parent -> Set(child)
  const parents = new Map(); // child  -> Set(parent)
  const nodesAll = new Set();

  for (const r of rows) {
    if (!r) continue;

    const S = norm(val(r.s));
    const P = norm(val(r.p));
    const O = norm(val(r.o));
    if (!S || !P || !O) continue;

    const tS = val(r.typeS ?? r.type);
    const tO = val(r.typeO);

    if (tS) nodeType.set(S, norm(tS));
    if (tO) nodeType.set(O, norm(tO));

    if (!SUP.has(P)) continue;

    if (!children.has(S)) children.set(S, new Set());
    if (!parents.has(O)) parents.set(O, new Set());

    children.get(S).add(O);
    parents.get(O).add(S);
    nodesAll.add(S);
    nodesAll.add(O);
  }

  // Roots = nodes never seen as object of supportedBy
  const objects = new Set([...parents.keys()]);
  const roots = [...nodesAll].filter((n) => !objects.has(n));

  if (roots.length === 0) {
    const first = rows.find((r) => r && SUP.has(norm(val(r.p))));
    const fallback = first ? norm(val(first.s)) : null;
    if (fallback) roots.push(fallback);
  }

  // --- BFS depth per node --------------------------------------------

  const depth = new Map(); // id -> depth/layer index
  const layers = []; // Array<Array<id>>
  const seen = new Set();
  const queue = [];

  for (const r of roots) {
    depth.set(r, 0);
    queue.push(r);
    seen.add(r);
  }

  while (queue.length) {
    const u = queue.shift();
    const du = depth.get(u) ?? 0;

    if (!layers[du]) layers[du] = [];
    layers[du].push(u);

    const kids = children.get(u) ? [...children.get(u)] : [];
    for (const v of kids) {
      if (!depth.has(v)) depth.set(v, du + 1);
      if (!seen.has(v)) {
        seen.add(v);
        queue.push(v);
      }
    }
  }

  // --- Build lanes array ---------------------------------------------

  let lanesArr = layers.map((a) => [...a]);

  if (assignLayer) {
    const N = laneCount ?? (Array.isArray(laneLabels) ? laneLabels.length : layers.length);
    lanesArr = Array.from({ length: Math.max(1, N) }, () => []);

    for (const id of nodesAll) {
      const d = depth.get(id) ?? 0;
      const kRaw = assignLayer(id, d);
      const k = Math.max(0, Math.min(N - 1, Number(kRaw) || 0));
      lanesArr[k].push(id);
    }
  } else if (laneCount != null && laneCount > 0) {
    const N = laneCount;
    lanesArr =
      layers.length >= N
        ? layers.slice(0, N).map((a) => [...a])
        : layers.concat(Array.from({ length: N - layers.length }, () => []));
  }

  // ✅ Correct: filter empty lanes BEFORE layout
  if (allowEmptyLanes === false) {
    const newLanes = [];
    const newLabels = [];

    for (let i = 0; i < lanesArr.length; i++) {
      const ids = lanesArr[i] || [];
      if (!ids.length) continue;

      newLanes.push(ids);
      newLabels.push(
        Array.isArray(laneLabels)
          ? laneLabels[i] ?? `Layer ${newLanes.length}`
          : `Layer ${newLanes.length}`
      );
    }

    lanesArr = newLanes.length ? newLanes : lanesArr;
    laneLabels = newLabels.length ? newLabels : laneLabels;
  }

  // --- Layout geometry -----------------------------------------------

  const PAD = { t: 28, r: 40, b: 28, l: 40 };

  const W = svgNode.clientWidth || pixelWidth || 900;
  const H = svgNode.clientHeight || height;

  const L = Math.max(1, lanesArr.length);
  const laneW = Math.max(160, (W - PAD.l - PAD.r) / L);
  const colX = (i) => PAD.l + i * laneW + laneW / 2;
  const laneHeight = Math.max(60, H - PAD.t - PAD.b);

  // --- Swimlanes background ------------------------------------------

  const lanesG = g.append("g").attr("class", "gsn-lanes");

  for (let i = 0; i < L; i++) {
    const gx = PAD.l + i * laneW;

    const lane = lanesG.append("g").attr("transform", `translate(${gx},${PAD.t})`);

    lane
      .append("rect")
      .attr("class", "gsn-lane")
      .attr("x", 0)
      .attr("y", 0)
      .attr("width", laneW)
      .attr("height", laneHeight)
      .attr("rx", 10)
      .attr("ry", 10)
      .attr("fill-opacity", i % 2 ? 0.05 : 0.09);

    const lbl = Array.isArray(laneLabels) ? laneLabels[i] ?? `Layer ${i + 1}` : `Layer ${i + 1}`;

    lane
      .append("text")
      .attr("class", "gsn-lane-label")
      .attr("x", laneW / 2)
      .attr("y", -8)
      .attr("text-anchor", "middle")
      .text(lbl);
  }

  // --- Compute node positions ----------------------------------------

  const pos = new Map(); // id -> { x, y, label }
  for (let i = 0; i < L; i++) {
    const ids = lanesArr[i] || [];
    const step = ids.length ? laneHeight / (ids.length + 1) : laneHeight / 2;

    ids.forEach((id, idx) => {
      const x = colX(i);
      const y = PAD.t + (idx + 1) * step;
      pos.set(id, { x, y, label: label(id) });
    });
  }

  // --- Links (supportedBy only) --------------------------------------

  const linkH = d3.linkHorizontal().x((d) => d.x).y((d) => d.y);
  const links = [];

  for (const [p, kids] of children.entries()) {
    const source = pos.get(p);
    if (!source) continue;

    for (const c of kids) {
      const target = pos.get(c);
      if (!target) continue;
      links.push({ source, target });
    }
  }

  g.selectAll("path.gsn-link")
    .data(links)
    .join("path")
    .attr("class", "gsn-link")
    .attr("d", (d) =>
      linkH({
        source: { x: d.source.x + labelWidthPx(d.source.label) / 2, y: d.source.y },
        target: { x: d.target.x - labelWidthPx(d.target.label) / 2, y: d.target.y },
      })
    )
    .attr("marker-end", `url(#${idArrow})`)
    .append("title")
    .text("supported by");

  // --- Nodes ----------------------------------------------------------

  const nodes = [...pos.entries()].map(([id, v]) => {
    const lbl = v.label;
    const typeIri = nodeType.get(id) || null;

    return {
      id,
      label: lbl,
      x: v.x,
      y: v.y,
      w: labelWidthPx(lbl),
      h: NODE_H,
      kind: inferGsnKind(id, lbl, typeIri),
      typeIri,
    };
  });

  const nodeG = g
    .selectAll("g.gsn-node")
    .data(nodes, (d) => d.id)
    .join("g")
    .attr("class", (d) => `gsn-node ${d.kind}`)
    .attr("data-id", (d) => d.id)
    .attr("transform", (d) => `translate(${d.x},${d.y})`);

  const shapeG = nodeG.append("g").attr("class", "gsn-node-shape");

  shapeG.each(function (d) {
    const gShape = d3.select(this);
    const w = d.w;
    const h = d.h;
    const x = -w / 2;
    const y = -h / 2;

    if (d.kind === "solution") {
      const r = Math.max(w, h) / 2;
      gShape.append("circle").attr("cx", 0).attr("cy", 0).attr("r", r);
    } else if (d.kind === "strategy") {
      const slant = Math.min(20, w / 5);
      const points = [
        [x + slant, y],
        [x + w + slant, y],
        [x + w - slant, y + h],
        [x - slant, y + h],
      ]
        .map((p) => p.join(","))
        .join(" ");
      gShape.append("polygon").attr("points", points);
    } else if (d.kind === "assumption" || d.kind === "justification") {
      gShape.append("ellipse").attr("cx", 0).attr("cy", 0).attr("rx", w / 2).attr("ry", h / 2);
    } else {
      gShape.append("rect").attr("width", w).attr("height", h).attr("x", x).attr("y", y);
    }
  });

  nodeG
    .append("text")
    .attr("text-anchor", "middle")
    .attr("dy", "0.35em")
    .text((d) => d.label)
    .append("title")
    .text((d) => d.id);

  const ajNodes = nodeG.filter((d) => d.kind === "assumption" || d.kind === "justification");
  ajNodes
    .append("text")
    .attr("class", "gsn-node-tag")
    .attr("text-anchor", "start")
    .attr("x", (d) => d.w / 2 - 6)
    .attr("y", (d) => d.h / 2 + 8)
    .text((d) => (d.kind === "assumption" ? "A" : "J"));

  // --- Overlay layer --------------------------------------------------

  const gOverlay = g.append("g").attr("class", "gsn-overlay-collections");

  // --- Zoom / pan -----------------------------------------------------

  const zoom = d3
    .zoom()
    .scaleExtent([0.25, 3])
    .on("zoom", (ev) => g.attr("transform", ev.transform));

  svg.call(zoom);

  // match graph.js: disable dblclick zoom
  svg.on("dblclick.zoom", null);

  function fit(pad = 40) {
    svg.interrupt();

    const gNode = g.node();
    if (!gNode) return;

    const bbox = gNode.getBBox();
    if (!bbox.width || !bbox.height) return;

    const vw = svgNode.clientWidth || svgNode.viewBox.baseVal.width || W;
    const vh = svgNode.clientHeight || svgNode.viewBox.baseVal.height || H;

    const sx = (vw - pad * 2) / bbox.width;
    const sy = (vh - pad * 2) / bbox.height;
    const s = Math.max(0.25, Math.min(2.5, Math.min(sx, sy)));

    const tx = pad - bbox.x * s + (vw - (bbox.width * s + pad * 2)) / 2;
    const ty = pad - bbox.y * s + (vh - (bbox.height * s + pad * 2)) / 2;

    const t = d3.zoomIdentity.translate(tx, ty).scale(s);
    svg.transition().duration(450).call(zoom.transform, t);
  }

  function reset() {
    svg.interrupt();
    svg.transition().duration(400).call(zoom.transform, d3.zoomIdentity);
  }

  function destroy() {
    rootEl.innerHTML = "";
  }

  function updateUndevDiamonds() {
    const svgSel = d3.select(rootEl).select("svg.gsn-svg");
    svgSel.selectAll("path.undev-diamond").remove();

    svgSel.selectAll("g.gsn-node.undev").each(function () {
      const gNode = d3.select(this);
      const shape = gNode.select("rect, circle, ellipse, polygon");
      if (!shape.node()) return;

      const box = shape.node().getBBox();
      const size = 5;
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height + size + 2;

      gNode
        .append("path")
        .attr("class", "undev-diamond")
        .attr(
          "d",
          `
          M ${cx} ${cy - size}
          L ${cx + size} ${cy}
          L ${cx} ${cy + size}
          L ${cx - size} ${cy}
          Z
        `
        );
    });
  }

  function clearAll() {
    nodeG.attr("class", (d) => `gsn-node ${d.kind}`);
    d3.select(rootEl).select("svg.gsn-svg").selectAll("path.undev-diamond").remove();
  }

  function highlightByIds(ids, klass = "overlay") {
    const S = new Set(ids.map(String));
    nodeG.classed(klass, (d) => S.has(String(d.id)));
    if (klass === "undev") updateUndevDiamonds();
  }

  function clearCollections() {
    gOverlay.selectAll("*").remove();
  }

  function addCollections(rows, opts = {}) {
    clearCollections();

    const hubDx = opts.dxHub ?? opts.dx ?? 90;
    const hubDy = opts.dyHub ?? opts.dy ?? 0;
    const arm = opts.armLen ?? 46;

    const grouped = new Map(); // ctx -> Set(items)
    for (const r of rows || []) {
      const ctx = norm(val(r.ctx));
      const item = norm(val(r.item));
      if (!ctx || !item) continue;

      let set = grouped.get(ctx);
      if (!set) {
        set = new Set();
        grouped.set(ctx, set);
      }
      set.add(item);
    }

    const hubsByCtx = new Map();

    for (const [ctx, itemsSet] of grouped.entries()) {
      const host = pos.get(ctx);
      if (!host) continue;

      const idx = hubsByCtx.get(ctx) ?? 0;
      hubsByCtx.set(ctx, idx + 1);

      const hubX = host.x + hubDx;
      const hubY = host.y + hubDy + idx * 26;

      const hub = gOverlay.append("g").attr("transform", `translate(${hubX},${hubY})`);
      hub.append("circle").attr("r", 5).attr("class", "collection-dot");

      const items = Array.from(itemsSet);

      items.forEach((itemId, i) => {
        const a = Math.PI / 6 + i * (Math.PI / 6);
        const ix = hubX + Math.cos(a) * arm;
        const iy = hubY + Math.sin(a) * arm;

        gOverlay
          .append("path")
          .attr("class", "gsn-link collection")
          .attr("d", `M${hubX},${hubY} L${ix},${iy}`);

        const lab = String(itemId);
        const w = Math.max(42, Math.min(180, labelWidthPx(lab)));
        const h = 18;

        const gi = gOverlay
          .append("g")
          .attr("class", "gsn-node collection item")
          .attr("transform", `translate(${ix},${iy})`);

        gi.append("rect").attr("width", w).attr("height", h).attr("x", -w / 2).attr("y", -h / 2);
        gi.append("text")
          .attr("text-anchor", "middle")
          .attr("dy", "0.35em")
          .text(lab)
          .append("title")
          .text(lab);
      });
    }
  }

  rootEl.querySelector('[data-act="fit"]')?.addEventListener("click", fit);
  rootEl.querySelector('[data-act="reset"]')?.addEventListener("click", reset);
  fit();

  return { fit, reset, destroy, clearAll, highlightByIds, addCollections, clearCollections, svg: svgNode };
}

// ============================================================================
// Lazy-load PaneManager lifecycle wiring
// ============================================================================

let _root = null;
let _ctl = null;
let _offRightTab = null;
let _suspended = false;

async function fetchGraphRows(queryPath = "data/queries/visualize_graph.sparql") {
  if (!app.store) await app.init();

  const query = await fetchRepoText(queryPath, {
    from: import.meta.url,
    upLevels: 2,
    cache: "no-store",
    bust: true,
  });

  const res = app.store.query(query);
  return bindingsToRows(res);
}

let _renderSeq = 0;

async function renderIntoRoot({ queryPath = null, renderOpts = {} } = {}) {
  if (!_root) return;

  const seq = ++_renderSeq;
  const qPath = queryPath || "data/queries/visualize_graph.sparql";

  try {
    const rows = await fetchGraphRows(qPath);

    // Abort if a newer render started, or pane got unmounted
    if (seq !== _renderSeq || !_root || !_root.isConnected) return;

    try { _ctl?.destroy?.(); } catch {}
    _ctl = null;

    _ctl = visualizeLayers(rows, {
      mount: _root,
      height: 520,
      label: shortenIri,
      laneLabels: ["Upstream", "Input", "Model", "Output", "Downstream", "Learn", "xyz"],
      laneCount: 7,
      ...renderOpts,
    });

  } catch (err) {
    console.warn("[layers] render failed:", err);

    // Don’t leave the user with a blank pane
    if (_root && _root.isConnected) {
      _root.innerHTML = `
        <div style="padding:10px;font-family:ui-monospace,monospace;font-size:12px;">
          <b>Layers failed to render</b><br/>
          <pre style="white-space:pre-wrap;opacity:0.9;margin:8px 0 0;">${String(err?.message || err)}</pre>
        </div>
      `;
    }
  }
}


function onRightTab(ev) {
  const d = ev?.detail || {};
  if (d.view !== "layers") return;
  if (_suspended) return;

  // Allow the tab to override query path or rendering options
  const queryPath = d.query || null;
  const renderOpts = d.renderOpts || {};
  _suspended = false;

  renderIntoRoot({ queryPath, renderOpts }).catch((err) =>
    console.warn("[layers] render failed:", err)
  );
}

// PaneManager calls this when the layered tab becomes active
export async function mount({ root } = {}) {
  _root = root || resolveEl("#layers-root", { required: true, name: "Layers pane root" });

  // attach right:tab listener only while mounted
  if (!_offRightTab) {
    _offRightTab = bus.on("right:tab", onRightTab);
  }

  // initial render
  await renderIntoRoot();

  // return cleanup callback (PaneManager pattern)
  return () => unmount();
}

export async function resume({ root, payload } = {}) {
  _suspended = false;

  if (root) _root = root;
  // If we were destroyed (e.g. by setRightController teardown), re-render.
  const hasSvg = !!_root?.querySelector?.("svg.gsn-svg");

  if (!_ctl || !hasSvg) {
    const queryPath = payload?.query || null;
    const renderOpts = payload?.renderOpts || {};
    await renderIntoRoot({ queryPath, renderOpts });
    return;
  }

  // Otherwise just fit (fast path)
  try { _ctl?.fit?.(); } catch {}
}


export async function suspend() {
  // if you want: keep state but stop reacting to tab events
  _suspended = true;
}

export async function unmount() {
  _renderSeq++;
  // remove listener
  try {
    _offRightTab?.();
  } catch {}
  _offRightTab = null;

  // destroy controller
  try {
    _ctl?.destroy?.();
  } catch {}
  _ctl = null;

  _root = null;
}

// optional default export
export default {
  mount,
  resume,
  suspend,
  unmount,
  visualizeLayers,
};
