/* =============================================================================
   app.js — interactive flowchart renderer (SVG + true camera zoom), drill-down
   navigation, detail drawer and the four document views. No dependencies.
   ========================================================================== */

const SVG_NS = "http://www.w3.org/2000/svg";
const $ = (id) => document.getElementById(id);

const el = {
  svg: $("svg"), canvas: $("canvas"), crumbs: $("crumbs"), legend: $("legend"),
  drawer: $("drawer"), drawerEmpty: $("drawer-empty"), drawerBody: $("drawer-body"),
  traceBar: $("trace-bar"), traceStep: $("trace-step"), kpis: $("kpis"),
};

/* --------------------------------------------------------------- app state */
const S = {
  graphId: "system",
  stack: ["system"],
  selected: null,
  cam: { x: 0, y: 0, k: 1 },
  target: { x: 0, y: 0, k: 1 },
  anim: null,
  trace: { on: false, i: 0 },
  view: "system",
};

/* ============================================================= tiny helpers */
function svgEl(name, attrs = {}) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== undefined && value !== null) node.setAttribute(key, value);
  }
  return node;
}

function esc(text) {
  return String(text).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const graph = () => GRAPHS[S.graphId];
const nodeById = (id) => graph().nodes.find((n) => n.id === id);

/* ================================================================== camera */
function viewport() {
  const rect = el.canvas.getBoundingClientRect();
  return { w: rect.width || 1000, h: rect.height || 700 };
}

function applyCamera() {
  const { x, y, k } = S.cam;
  el.camera.setAttribute("transform", `translate(${x} ${y}) scale(${k})`);
}

function clampScale(k) { return Math.min(3.2, Math.max(0.18, k)); }

/** Animate the camera toward a target translate/scale. */
function flyTo(x, y, k, ms = 520) {
  S.target = { x, y, k: clampScale(k) };
  if (S.anim) cancelAnimationFrame(S.anim);
  const from = { ...S.cam };
  const start = performance.now();
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

  const tick = (now) => {
    const t = Math.min(1, (now - start) / ms);
    const e = ease(t);
    S.cam.x = from.x + (S.target.x - from.x) * e;
    S.cam.y = from.y + (S.target.y - from.y) * e;
    S.cam.k = from.k + (S.target.k - from.k) * e;
    applyCamera();
    if (t < 1) S.anim = requestAnimationFrame(tick);
    else S.anim = null;
  };
  S.anim = requestAnimationFrame(tick);
}

/** Fit the whole graph in view. */
function fitGraph(animate = true) {
  const g = graph();
  const { w, h } = viewport();
  const pad = 48;
  const k = clampScale(Math.min((w - pad * 2) / g.w, (h - pad * 2) / g.h));
  const x = (w - g.w * k) / 2;
  const y = (h - g.h * k) / 2;
  if (animate) flyTo(x, y, k);
  else { S.cam = { x, y, k }; applyCamera(); }
}

/** Zoom the camera so one node fills a comfortable portion of the viewport. */
function focusNode(node, zoom = 1.55) {
  const { w, h } = viewport();
  // keep the drawer-side of the canvas clear by biasing slightly left
  const k = clampScale(Math.min(zoom, (w * 0.62) / node.w, (h * 0.6) / node.h));
  const cx = node.x + node.w / 2;
  const cy = node.y + node.h / 2;
  flyTo(w / 2 - cx * k, h / 2 - cy * k, k);
}

/* ================================================================ edge path */
function anchor(node, side, offset = 0) {
  const ox = offset * node.w;
  const oy = offset * node.h;
  switch (side) {
    case "top":    return { x: node.x + node.w / 2 + ox, y: node.y,              dir: [0, -1] };
    case "bottom": return { x: node.x + node.w / 2 + ox, y: node.y + node.h,     dir: [0, 1] };
    case "left":   return { x: node.x,                   y: node.y + node.h / 2 + oy, dir: [-1, 0] };
    default:       return { x: node.x + node.w,          y: node.y + node.h / 2 + oy, dir: [1, 0] };
  }
}

/** Orthogonal elbow router with rounded corners. */
function routePath(edge, from, to) {
  const a = anchor(from, edge.fromSide || "bottom", edge.fromOffset || 0);
  const b = anchor(to, edge.toSide || "top", edge.toOffset || 0);
  const pts = [{ x: a.x, y: a.y }];
  const fs = edge.fromSide || "bottom";
  const ts = edge.toSide || "top";
  const vertical = (s) => s === "top" || s === "bottom";

  if (vertical(fs) && vertical(ts)) {
    const bus = edge.bus !== undefined ? edge.bus : (a.y + b.y) / 2;
    pts.push({ x: a.x, y: bus }, { x: b.x, y: bus });
  } else if (!vertical(fs) && !vertical(ts)) {
    const mid = edge.midX !== undefined ? edge.midX : (a.x + b.x) / 2;
    pts.push({ x: mid, y: a.y }, { x: mid, y: b.y });
  } else if (vertical(fs)) {
    // leave vertically, arrive horizontally
    const bus = edge.bus !== undefined ? edge.bus : b.y;
    pts.push({ x: a.x, y: bus });
  } else {
    // leave horizontally, arrive vertically
    const mid = edge.midX !== undefined ? edge.midX : b.x;
    pts.push({ x: mid, y: a.y });
  }
  pts.push({ x: b.x, y: b.y });

  // stub the arrival so the arrowhead sits off the border
  const stub = 2;
  const last = pts[pts.length - 1];
  last.x -= b.dir[0] * stub;
  last.y -= b.dir[1] * stub;

  return roundedPolyline(pts, 12);
}

function roundedPolyline(pts, r) {
  // drop zero-length segments
  const p = pts.filter((point, i) => i === 0 || Math.hypot(point.x - pts[i - 1].x, point.y - pts[i - 1].y) > 0.5);
  if (p.length < 2) return "";
  let d = `M ${p[0].x} ${p[0].y}`;
  for (let i = 1; i < p.length - 1; i++) {
    const prev = p[i - 1], cur = p[i], next = p[i + 1];
    const d1 = Math.hypot(cur.x - prev.x, cur.y - prev.y);
    const d2 = Math.hypot(next.x - cur.x, next.y - cur.y);
    const rr = Math.min(r, d1 / 2, d2 / 2);
    const u1 = { x: (cur.x - prev.x) / d1, y: (cur.y - prev.y) / d1 };
    const u2 = { x: (next.x - cur.x) / d2, y: (next.y - cur.y) / d2 };
    d += ` L ${cur.x - u1.x * rr} ${cur.y - u1.y * rr}`;
    d += ` Q ${cur.x} ${cur.y} ${cur.x + u2.x * rr} ${cur.y + u2.y * rr}`;
  }
  const end = p[p.length - 1];
  d += ` L ${end.x} ${end.y}`;
  return d;
}

/** Put the label on the edge's longest straight run, not on top of a node. */
function labelPoint(edge, from, to) {
  const fs = edge.fromSide || "bottom";
  const ts = edge.toSide || "top";
  const a = anchor(from, fs, edge.fromOffset || 0);
  const b = anchor(to, ts, edge.toOffset || 0);
  const vertical = (s) => s === "top" || s === "bottom";

  if (vertical(fs) && vertical(ts)) {
    const bus = edge.bus !== undefined ? edge.bus : (a.y + b.y) / 2;
    return { x: (a.x + b.x) / 2, y: bus - 7, anchor: "middle" };
  }
  if (!vertical(fs) && !vertical(ts)) {
    // side-by-side nodes: the run is horizontal, so sit above it
    if (Math.abs(a.y - b.y) < 26) return { x: (a.x + b.x) / 2, y: a.y - 9, anchor: "middle" };
    const mid = edge.midX !== undefined ? edge.midX : (a.x + b.x) / 2;
    return { x: mid + 7, y: (a.y + b.y) / 2, anchor: "start" };
  }
  if (vertical(fs)) {
    const bus = edge.bus !== undefined ? edge.bus : b.y;
    return { x: a.x + 7, y: (a.y + bus) / 2, anchor: "start" };
  }
  const mid = edge.midX !== undefined ? edge.midX : b.x;
  return { x: (a.x + mid) / 2, y: a.y - 7, anchor: "middle" };
}

/* ============================================================ graph drawing */
const KIND_LABEL = {
  data: "data", eval: "evaluator", agent: "agent", stage: "stage", init: "init",
  ml: "neural", path: "path", artifact: "artifact", decision: "branch",
  plus: "reward", minus: "penalty", score: "score", out: "output",
  warn: "limitation", note: "insight",
};

const LEGEND = [
  ["frozen / data", "var(--slate)"],
  ["evaluator", "var(--amber)"],
  ["our pipeline", "var(--blue)"],
  ["neural stage", "var(--violet)"],
  ["output", "var(--green)"],
  ["insight / limitation", "var(--teal)"],
];

function drawGraph() {
  const g = graph();
  el.svg.innerHTML = "";

  // arrow markers
  const defs = svgEl("defs");
  for (const [id, color] of [["arrow", "#aeb6c0"], ["arrow-loop", "#c98a1a"], ["arrow-hot", "#0ca678"]]) {
    const marker = svgEl("marker", {
      id, viewBox: "0 0 10 10", refX: 8, refY: 5,
      markerWidth: 6, markerHeight: 6, orient: "auto-start-reverse",
    });
    marker.appendChild(svgEl("path", { d: "M 0 0 L 10 5 L 0 10 z", fill: color }));
    defs.appendChild(marker);
  }
  el.svg.appendChild(defs);

  el.camera = svgEl("g", { id: "camera" });
  el.svg.appendChild(el.camera);

  const layerFrames = svgEl("g");
  const layerEdges = svgEl("g");
  const layerFlow = svgEl("g", { class: "flow-layer" });
  const layerNodes = svgEl("g");
  el.camera.append(layerFrames, layerEdges, layerFlow, layerNodes);
  S.flowLayer = layerFlow;

  // frames
  for (const frame of g.frames || []) {
    layerFrames.appendChild(svgEl("rect", {
      class: "frame-rect", x: frame.x, y: frame.y, width: frame.w, height: frame.h, rx: 16,
    }));
    const text = svgEl("text", { class: "frame-label", x: frame.x + 16, y: frame.y + 22 });
    text.textContent = frame.label;
    layerFrames.appendChild(text);
  }

  // edges
  S.edgeEls = [];
  for (const edge of g.edges || []) {
    const from = nodeById(edge.from);
    const to = nodeById(edge.to);
    if (!from || !to) continue;
    const cls = edge.kind === "thin" ? "edge edge-thin"
      : edge.kind === "dashed" ? "edge edge-dashed"
      : edge.kind === "loop" ? "edge edge-loop" : "edge";
    const pathId = `flow-path-${S.edgeEls.length}`;
    const path = svgEl("path", {
      id: pathId,
      class: cls, d: routePath(edge, from, to),
      "marker-end": `url(#${edge.kind === "loop" ? "arrow-loop" : "arrow"})`,
    });
    layerEdges.appendChild(path);
    S.edgeEls.push({ edge, path, pathId });

    if (edge.label) {
      const at = labelPoint(edge, from, to);
      const text = svgEl("text", {
      class: "edge-label",
      x: edge.labelX !== undefined ? edge.labelX : at.x,
      y: edge.labelY !== undefined ? edge.labelY : at.y,
      "text-anchor": at.anchor,
    });
      text.textContent = edge.label;
      layerEdges.appendChild(text);
    }
  }

  // nodes (foreignObject so text wraps and CSS does the styling)
  for (const node of g.nodes) {
    const fo = svgEl("foreignObject", {
      class: `node-fo k-${node.kind || "stage"}`,
      x: node.x, y: node.y, width: node.w, height: node.h,
      "data-node": node.id,
    });
    const box = document.createElement("div");
    box.className = "nodebox";
    box.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
    box.innerHTML =
      `<span class="nb-kind">${esc(KIND_LABEL[node.kind] || "step")}</span>` +
      `<div class="nb-label">${esc(node.label)}</div>` +
      (node.sub ? `<div class="nb-sub">${esc(node.sub)}</div>` : "") +
      (node.drill ? `<span class="nb-drill">⤢ drill in</span>` : "");
    box.addEventListener("click", (event) => {
      event.stopPropagation();
      selectNode(node.id, { zoom: true });
    });
    box.addEventListener("dblclick", (event) => {
      event.stopPropagation();
      if (node.drill) pushGraph(node.drill);
    });
    fo.appendChild(box);
    layerNodes.appendChild(fo);
  }

  el.legend.innerHTML = LEGEND
    .map(([label, color]) => `<span><i style="background:${color}"></i>${label}</span>`)
    .join("");

  renderCrumbs();
  fitGraph(false);
}

function nodeBox(id) {
  return el.svg.querySelector(`[data-node="${id}"] .nodebox`);
}

/* ============================================================== interaction */
function selectNode(id, { zoom = false } = {}) {
  S.selected = id;
  for (const fo of el.svg.querySelectorAll(".node-fo .nodebox")) fo.classList.remove("is-selected");
  const box = nodeBox(id);
  if (box) box.classList.add("is-selected");
  const node = nodeById(id);
  if (!node) return;
  if (zoom) focusNode(node);
  renderDetail(node);
  highlightEdges(id);
  renderFlow(id);
  syncHash();
}

function highlightEdges(id) {
  for (const { edge, path } of S.edgeEls || []) {
    path.classList.toggle("is-hot", edge.from === id || edge.to === id);
    path.setAttribute(
      "marker-end",
      `url(#${edge.from === id || edge.to === id ? "arrow-hot" : edge.kind === "loop" ? "arrow-loop" : "arrow"})`,
    );
  }
}

const XLINK_NS = "http://www.w3.org/1999/xlink";

function clearFlow() {
  if (S.flowLayer) S.flowLayer.textContent = "";
}

/** Send small dots travelling along every edge touching `id`, in the
 *  direction information actually flows (path start -> path end). */
function renderFlow(id) {
  clearFlow();
  if (!S.flowLayer || !S.edgeEls) return;

  for (const { edge, pathId } of S.edgeEls) {
    if (edge.from !== id && edge.to !== id) continue;
    const incoming = edge.to === id;
    const dur = edge.kind === "loop" ? 2.2 : 1.5;
    const count = 3;

    for (let i = 0; i < count; i++) {
      const dot = svgEl("circle", {
        r: 4.2,
        class: "flow-dot" + (incoming ? " in" : " out"),
      });
      const motion = svgEl("animateMotion", {
        dur: `${dur}s`,
        // negative begin => already mid-path at t0, so no dot parks at the origin
        begin: `${-(i * dur) / count}s`,
        repeatCount: "indefinite",
        calcMode: "linear",
        rotate: "auto",
      });
      const mpath = svgEl("mpath", { href: `#${pathId}` });
      mpath.setAttributeNS(XLINK_NS, "xlink:href", `#${pathId}`);
      motion.appendChild(mpath);
      dot.appendChild(motion);
      S.flowLayer.appendChild(dot);
    }
  }
}

function pushGraph(id) {
  if (!GRAPHS[id]) return;
  S.stack.push(id);
  S.graphId = id;
  S.selected = null;
  drawGraph();
  clearDetail();
  syncHash();
}

function popGraph() {
  if (S.stack.length < 2) { fitGraph(); return; }
  const leaving = S.stack.pop();
  S.graphId = S.stack[S.stack.length - 1];
  drawGraph();
  // land on the parent box the user came from
  const parentNode = graph().nodes.find((n) => n.drill === leaving);
  if (parentNode) selectNode(parentNode.id, { zoom: false });
  else { clearDetail(); syncHash(); }
}

/** Breadcrumb trail for a graph, walking `parent` links up to the root. */
function trailFor(id) {
  const trail = [];
  for (let cursor = id; cursor; cursor = GRAPHS[cursor].parent) trail.unshift(cursor);
  return trail;
}

function goToGraph(id) {
  const index = S.stack.indexOf(id);
  if (index >= 0) S.stack = S.stack.slice(0, index + 1);
  else S.stack = trailFor(id);
  S.graphId = id;
  S.selected = null;
  drawGraph();
  clearDetail();
  syncHash();
}

function renderCrumbs() {
  el.crumbs.innerHTML = "";
  S.stack.forEach((id, index) => {
    if (index > 0) {
      const sep = document.createElement("span");
      sep.className = "crumb-sep";
      sep.textContent = "›";
      el.crumbs.appendChild(sep);
    }
    const button = document.createElement("button");
    const isLast = index === S.stack.length - 1;
    button.className = "crumb" + (isLast ? " is-last" : "");
    button.textContent = GRAPHS[id].title;
    if (!isLast) button.addEventListener("click", () => goToGraph(id));
    el.crumbs.appendChild(button);
  });
}

/* ============================================================ detail drawer */
function clearDetail() {
  el.drawerEmpty.hidden = false;
  el.drawerBody.hidden = true;
  el.drawerBody.innerHTML = "";
  clearFlow();
}

const KW = /\b(def|class|return|if|elif|else|for|while|in|not|and|or|None|True|False|import|from|try|except|raise|with|as|lambda|continue|break|yield|assert)\b/g;

/** Colour plain (non-string, non-comment) python. */
function plainPy(text) {
  return esc(text)
    .replace(KW, '<span class="c-kw">$1</span>')
    .replace(/\b(\d+\.?\d*)\b/g, '<span class="c-num">$1</span>');
}

const PY_TOKEN = /("""[\s\S]*?"""|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|#[^\n]*)/g;

function highlight(code, lang) {
  const src = String(code);

  if (lang === "json") {
    return esc(src)
      .replace(/(&quot;[^&]*?&quot;)(\s*:)/g, '<span class="c-fn">$1</span>$2')
      .replace(/:\s(&quot;[^&]*?&quot;)/g, ': <span class="c-str">$1</span>')
      .replace(/\b(\d+)\b/g, '<span class="c-num">$1</span>');
  }
  if (lang !== "python") return esc(src);

  // Tokenise strings and comments on the raw source, then colour the gaps.
  let out = "";
  let last = 0;
  let match;
  PY_TOKEN.lastIndex = 0;
  while ((match = PY_TOKEN.exec(src)) !== null) {
    out += plainPy(src.slice(last, match.index));
    const token = match[1];
    out += token.startsWith("#")
      ? `<span class="c-com">${esc(token)}</span>`
      : `<span class="c-str">${esc(token)}</span>`;
    last = match.index + token.length;
  }
  return out + plainPy(src.slice(last));
}

function renderDetail(node) {
  const d = node.detail || {};
  const parts = [];

  parts.push(
    `<div class="d-kicker" style="color:var(--nc)">${esc(KIND_LABEL[node.kind] || "step")}</div>`,
    `<div class="d-title">${esc(node.label)}</div>`,
    node.sub ? `<div class="d-sub">${esc(node.sub)}</div>` : "",
  );

  if (d.file) parts.push(`<div class="d-file">${esc(d.file)}${d.lines ? `  ·  lines ${esc(d.lines)}` : ""}</div>`);
  if (d.summary) parts.push(`<div class="d-summary">${esc(d.summary)}</div>`);

  if (d.code) {
    parts.push(`<div class="d-h">source</div><pre class="d-code">${highlight(d.code.text, d.code.lang)}</pre>`);
  }

  if (d.bullets?.length) {
    parts.push(
      `<div class="d-h">how it works</div><ul class="d-list">` +
      d.bullets.map((b) => `<li>${esc(b)}</li>`).join("") + `</ul>`,
    );
  }

  if (d.constants?.length) {
    parts.push(
      `<div class="d-h">constants that matter</div><div class="d-consts">` +
      d.constants.map(([k, v]) => `<div class="d-const"><b>${esc(k)}</b><span>${esc(v)}</span></div>`).join("") +
      `</div>`,
    );
  }

  if (d.table) {
    parts.push(
      `<div class="d-h">measured</div><table class="d-table"><thead><tr>` +
      d.table.head.map((h) => `<th>${esc(h)}</th>`).join("") + `</tr></thead><tbody>` +
      d.table.rows.map((row) => `<tr>${row.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("") +
      `</tbody></table>`,
    );
  }

  if (d.why) parts.push(`<div class="d-why"><b>why it is built this way</b>${esc(d.why)}</div>`);

  if (node.drill) {
    parts.push(`<button class="d-drill" data-drill="${esc(node.drill)}">⤢ Zoom into ${esc(GRAPHS[node.drill].title)}</button>`);
  }

  el.drawerBody.innerHTML = parts.join("");
  el.drawerBody.hidden = false;
  el.drawerEmpty.hidden = true;
  el.drawer.scrollTop = 0;

  // the kicker colour follows the node family
  const kicker = el.drawerBody.querySelector(".d-kicker");
  if (kicker) {
    const probe = nodeBox(node.id);
    if (probe) kicker.style.color = getComputedStyle(probe).getPropertyValue("--nc");
  }

  const drill = el.drawerBody.querySelector("[data-drill]");
  if (drill) drill.addEventListener("click", () => pushGraph(drill.dataset.drill));
}

/* =============================================================== pan + zoom */
(function wireCanvas() {
  let dragging = false;
  let last = { x: 0, y: 0 };
  let moved = 0;

  el.canvas.addEventListener("pointerdown", (event) => {
    if (event.target.closest(".nodebox")) return;
    dragging = true; moved = 0;
    last = { x: event.clientX, y: event.clientY };
    el.canvas.classList.add("is-panning");
    el.canvas.setPointerCapture(event.pointerId);
  });

  el.canvas.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    const dx = event.clientX - last.x;
    const dy = event.clientY - last.y;
    moved += Math.abs(dx) + Math.abs(dy);
    last = { x: event.clientX, y: event.clientY };
    if (S.anim) { cancelAnimationFrame(S.anim); S.anim = null; }
    S.cam.x += dx; S.cam.y += dy;
    applyCamera();
  });

  el.canvas.addEventListener("pointerup", () => {
    dragging = false;
    el.canvas.classList.remove("is-panning");
  });

  el.canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    if (S.anim) { cancelAnimationFrame(S.anim); S.anim = null; }
    const rect = el.canvas.getBoundingClientRect();
    const mx = event.clientX - rect.left;
    const my = event.clientY - rect.top;
    const factor = Math.exp(-event.deltaY * 0.0016);
    const k = clampScale(S.cam.k * factor);
    const ratio = k / S.cam.k;
    S.cam.x = mx - (mx - S.cam.x) * ratio;
    S.cam.y = my - (my - S.cam.y) * ratio;
    S.cam.k = k;
    applyCamera();
  }, { passive: false });

  el.canvas.addEventListener("dblclick", (event) => {
    if (event.target.closest(".nodebox")) return;
    fitGraph();
  });
})();

/* ================================================================= toolbar */
$("btn-fit").addEventListener("click", () => fitGraph());
$("btn-up").addEventListener("click", () => popGraph());
$("btn-zoom-in").addEventListener("click", () => {
  const { w, h } = viewport();
  const k = clampScale(S.cam.k * 1.35);
  const ratio = k / S.cam.k;
  flyTo(w / 2 - (w / 2 - S.cam.x) * ratio, h / 2 - (h / 2 - S.cam.y) * ratio, k, 220);
});
$("btn-zoom-out").addEventListener("click", () => {
  const { w, h } = viewport();
  const k = clampScale(S.cam.k / 1.35);
  const ratio = k / S.cam.k;
  flyTo(w / 2 - (w / 2 - S.cam.x) * ratio, h / 2 - (h / 2 - S.cam.y) * ratio, k, 220);
});

window.addEventListener("keydown", (event) => {
  if (S.view !== "system") return;
  if (event.key === "Escape") { if (S.trace.on) stopTrace(); else popGraph(); }
  if (event.key === "f" || event.key === "F") fitGraph();
  if (event.key === "ArrowRight" && S.trace.on) traceGo(1);
  if (event.key === "ArrowLeft" && S.trace.on) traceGo(-1);
});

window.addEventListener("resize", () => { if (S.view === "system") fitGraph(false); });

/* =================================================================== trace */
function startTrace() {
  S.trace = { on: true, i: 0 };
  el.traceBar.hidden = false;
  $("btn-play").classList.add("is-on");
  goToGraph("pipeline");
  renderTrace();
}

function stopTrace() {
  S.trace.on = false;
  el.traceBar.hidden = true;
  $("btn-play").classList.remove("is-on");
  for (const box of el.svg.querySelectorAll(".nodebox")) {
    box.classList.remove("is-traced", "is-dim");
  }
  highlightEdges(null);
  clearFlow();
  fitGraph();
}

function traceGo(delta) {
  const next = S.trace.i + delta;
  if (next < 0 || next >= TRACE.steps.length) return;
  S.trace.i = next;
  renderTrace();
}

function renderTrace() {
  const step = TRACE.steps[S.trace.i];
  if (S.graphId !== step.graph) goToGraph(step.graph);

  for (const box of el.svg.querySelectorAll(".nodebox")) {
    box.classList.remove("is-traced");
    box.classList.add("is-dim");
  }
  const box = nodeBox(step.node);
  if (box) { box.classList.add("is-traced"); box.classList.remove("is-dim"); }

  const node = nodeById(step.node);
  if (node) focusNode(node, 1.35);
  highlightEdges(step.node);
  renderFlow(step.node);

  el.traceStep.innerHTML =
    `<b>${S.trace.i + 1}/${TRACE.steps.length} · ${esc(step.label)}</b> — ${esc(step.text)}`;

  el.drawerBody.innerHTML =
    `<div class="d-kicker" style="color:var(--green)">trace · ${esc(TRACE.title)}</div>` +
    `<div class="d-title">${esc(step.label)}</div>` +
    `<div class="d-summary" style="margin-top:.7rem">${esc(step.text)}</div>` +
    (step.code ? `<div class="d-h">what the data looks like</div><pre class="d-code">${highlight(step.code, "python")}</pre>` : "") +
    `<div class="d-h">step</div>` +
    `<div class="d-consts">` +
    TRACE.steps.map((s, i) =>
      `<div class="d-const" style="${i === S.trace.i ? "border-color:var(--green)" : ""}">` +
      `<b>${i + 1}. ${esc(s.label)}</b><span>${i === S.trace.i ? "▶" : ""}</span></div>`,
    ).join("") +
    `</div>`;
  el.drawerBody.hidden = false;
  el.drawerEmpty.hidden = true;
  syncHash();
}

$("btn-play").addEventListener("click", () => (S.trace.on ? stopTrace() : startTrace()));
$("trace-next").addEventListener("click", () => traceGo(1));
$("trace-prev").addEventListener("click", () => traceGo(-1));
$("trace-stop").addEventListener("click", () => stopTrace());

/* ================================================================ view nav */
const STAGES = {
  system: $("stage-flow"), scoring: $("stage-scoring"),
  scenarios: $("stage-scenarios"), results: $("stage-results"), team: $("stage-team"),
};

function setView(view) {
  S.view = view;
  for (const [name, node] of Object.entries(STAGES)) node.hidden = name !== view;
  for (const button of document.querySelectorAll(".view-btn")) {
    button.classList.toggle("is-active", button.dataset.view === view);
  }
  if (view === "system") fitGraph(false);
  syncHash();
}

for (const button of document.querySelectorAll(".view-btn")) {
  button.addEventListener("click", () => setView(button.dataset.view));
}

/* ================================================================ KPI strip */
el.kpis.innerHTML = KPIS
  .map((k) => `<div class="kpi ${k.tone}"><span class="k">${esc(k.label)}</span><span class="v">${esc(k.value)}</span></div>`)
  .join("");

/* ============================================================= doc: scoring */
function bar(label, value, max, fmt = (v) => v.toFixed(3), green = false) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return `<div class="bar-row"><div><div class="bar-lab">${esc(label)}</div>` +
    `<div class="bar-track"><div class="bar-fill ${green ? "g" : ""}" style="width:${pct}%"></div></div></div>` +
    `<div class="bar-val">${esc(fmt(value))}</div></div>`;
}

$("doc-scoring").innerHTML = `
  <h2>The scoring model</h2>
  <p class="lede">One additive expression decides the order of every candidate. Seven terms reward evidence,
  four subtract it, and every weight below was set by measuring TechnicalScore on the 200-session public set.
  Nothing here is learned, which is why any regression can be traced to a single term.</p>

  <div class="formula">score_product(product, state, plan, retrieval_score) =

      retrieval_score                                   carried BM25 from the winning path
    + 1.5× (on override turns) · _phrase_score           verbatim clue inside a field
    + _snippet_coverage                                  share of each clue's tokens present
    + _token_overlap                                     field-weighted bag of words
    + _attribute_score                                   structured containment per attribute
    + _optional_score                                    profile preference tags
    + _quality_tiebreak                                  rating and review count
    − _contradiction_penalty                             rejected terms, wrong colour/material
    − _budget_penalty                                    over a ceiling / off a target price
    − _feedback_penalty                                  items the customer just rejected
    − _category_mismatch_penalty                         wrong product family</div>

  <h3>What a single match is worth</h3>
  <div class="grid g2">
    <div class="card">
      <h4>Rewards</h4>
      <div style="margin-top:.8rem">
        ${bar("verbatim clue in title", 5.0, 6, (v) => "+" + v.toFixed(1), true)}
        ${bar("fully covered clue (_COVERAGE_WEIGHT)", 6.0, 6, (v) => "+" + v.toFixed(1), true)}
        ${bar("verbatim clue in categories / features / details", 2.5, 6, (v) => "+" + v.toFixed(1), true)}
        ${bar("hard attribute contained (material, colour…)", 2.5, 6, (v) => "+" + v.toFixed(1), true)}
        ${bar("soft attribute contained", 1.5, 6, (v) => "+" + v.toFixed(1), true)}
        ${bar("verbatim clue in description", 1.0, 6, (v) => "+" + v.toFixed(1), true)}
        ${bar("attribute found in description only", 0.75, 6, (v) => "+" + v.toFixed(2), true)}
        ${bar("profile preference tag matched", 0.4, 6, (v) => "+" + v.toFixed(1), true)}
      </div>
    </div>
    <div class="card">
      <h4>Penalties</h4>
      <div class="neg" style="margin-top:.8rem">
        ${bar("budget ceiling breached", 5.0, 6, (v) => "−" + v.toFixed(1))}
        ${bar("rejected term in the title", 4.0, 6, (v) => "−" + v.toFixed(1))}
        ${bar("names a colour, but not the required one", 3.5, 6, (v) => "−" + v.toFixed(1))}
        ${bar("names a material, but not the required one", 3.5, 6, (v) => "−" + v.toFixed(1))}
        ${bar("rejected term in strong fields", 2.5, 6, (v) => "−" + v.toFixed(1))}
        ${bar("wrong product family (category hint)", 2.5, 6, (v) => "−" + v.toFixed(1))}
        ${bar("shown at rank 1, then rejected", 1.5, 6, (v) => "−" + v.toFixed(1))}
        ${bar("required material / colour / category absent", 1.5, 6, (v) => "−" + v.toFixed(1))}
      </div>
      <div class="note-box">A budget breach or a title contradiction outweighs almost any positive signal —
      that asymmetry is deliberate. Showing a product the customer explicitly ruled out is worse than
      showing a merely mediocre match.</div>
    </div>
  </div>

  <h3>Field weights — where a token was found matters</h3>
  <div class="card">
    <div class="grid g2">
      <div>
        <h4 style="margin-bottom:.7rem">Retrieval (FTS5 bm25 weights)</h4>
        ${bar("title", 8, 8, (v) => v.toFixed(1))}
        ${bar("categories", 5, 8, (v) => v.toFixed(1))}
        ${bar("features", 3, 8, (v) => v.toFixed(1))}
        ${bar("details", 3, 8, (v) => v.toFixed(1))}
        ${bar("description", 1, 8, (v) => v.toFixed(1))}
        ${bar("store", 0.5, 8, (v) => v.toFixed(1))}
      </div>
      <div>
        <h4 style="margin-bottom:.7rem">Ranking (_FIELD_WEIGHTS)</h4>
        ${bar("title", 5, 8, (v) => v.toFixed(1), true)}
        ${bar("categories", 3, 8, (v) => v.toFixed(1), true)}
        ${bar("features", 2.5, 8, (v) => v.toFixed(1), true)}
        ${bar("details", 2, 8, (v) => v.toFixed(1), true)}
        ${bar("store", 1.5, 8, (v) => v.toFixed(1), true)}
        ${bar("description", 1, 8, (v) => v.toFixed(1), true)}
      </div>
    </div>
    <div class="note-box">Both stages agree on the ordering: the title is the strongest evidence and the
    marketing description the weakest. description is excluded entirely from the cross-encoder's passage text,
    because it would consume the model's token budget without adding discriminative signal.</div>
  </div>

  <h3>Freshness weighting across turns</h3>
  <div class="grid g3">
    <div class="card"><div class="stat good"><span class="s-k">post-override clue</span><span class="s-v">1.00</span><span class="s-n">full weight — the customer's current intent</span></div></div>
    <div class="card"><div class="stat warn"><span class="s-k">pre-override clue</span><span class="s-v">0.35</span><span class="s-n">kept, not discarded — one preference changed, not the whole request</span></div></div>
    <div class="card"><div class="stat blue"><span class="s-k">override-turn boost</span><span class="s-v">1.5×</span><span class="s-n">applied to _phrase_score on the turn the change arrives</span></div></div>
  </div>

  <h3>The evaluator's formula</h3>
  <div class="formula">Efficiency     = clip((11 − MTTC) / 10, 0, 1)        # a miss counts as turn 11
TechnicalScore = 0.50·HitRate@10 + 0.30·MRR + 0.20·Efficiency

current        = 0.50·0.965 + 0.30·0.6056 + 0.20·0.8005 = 0.8243</div>
  <div class="note-box">With Hit@10 at 0.965 the hit-rate term is nearly saturated. Each additional
  0.01 of MRR is worth 0.003 TechnicalScore, and each turn shaved off MTTC is worth 0.02 —
  which is exactly why the remaining work is ordering and question policy, not recall.</div>
`;

/* =========================================================== doc: scenarios */
$("doc-scenarios").innerHTML = `
  <h2>The four scenarios</h2>
  <p class="lede">The scenario type is never passed to the agent — it has to be inferred from the text.
  Each scenario stresses a different part of the pipeline, and each one is handled by named, specific code.</p>
  ${SCENARIOS.map((s) => `
    <div class="card" style="margin-bottom:1rem">
      <div style="display:flex;align-items:baseline;gap:.7rem;flex-wrap:wrap">
        <h4 style="font-size:1.1rem">${esc(s.name)}</h4>
        <span class="pill p-${s.tone}">${esc(s.share)}</span>
        <span style="margin-left:auto;font-family:var(--mono);font-size:.74rem;color:var(--muted)">
          Hit@10 <b style="color:var(--green)">${esc(s.hit)}</b> ·
          MRR <b style="color:var(--text)">${esc(s.mrr)}</b> ·
          MTTC <b style="color:var(--text)">${esc(s.mttc)}</b>
        </span>
      </div>
      <p style="margin-top:.35rem">${esc(s.idea)}</p>
      <div class="grid g2" style="margin-top:1rem">
        <div>
          <h3 style="margin-top:0">example session</h3>
          <div class="chat">
            ${s.transcript.map(([who, text]) =>
              `<div class="msg ${who}"><span class="who">${who}</span>${esc(text)}</div>`).join("")}
          </div>
        </div>
        <div>
          <h3 style="margin-top:0">how the pipeline handles it</h3>
          <ul class="d-list">${s.handling.map((h) => `<li>${esc(h)}</li>`).join("")}</ul>
        </div>
      </div>
      <div class="note-box">${esc(s.weak)}</div>
    </div>`).join("")}
`;

/* ============================================================= doc: results */
const R = RESULTS;
$("doc-results").innerHTML = `
  <h2>Results</h2>
  <p class="lede">Full public set, 200 sessions, <code style="font-family:var(--mono);font-size:.85em">python3 -m evaluator.local_evaluator</code>.
  Numbers below are from the committed <code style="font-family:var(--mono);font-size:.85em">results.json</code> of the current default pipeline
  (cross-encoder stage enabled).</p>

  <div class="grid g4">
    <div class="card"><div class="stat good"><span class="s-k">TechnicalScore</span><span class="s-v">${R.headline.ts.toFixed(3)}</span><span class="s-n">baseline 0.107 · 7.7× the kit</span></div></div>
    <div class="card"><div class="stat good"><span class="s-k">HitRate@10</span><span class="s-v">${R.headline.hit.toFixed(3)}</span><span class="s-n">193 of 200 sessions</span></div></div>
    <div class="card"><div class="stat warn"><span class="s-k">MRR</span><span class="s-v">${R.headline.mrr.toFixed(3)}</span><span class="s-n">the remaining headroom</span></div></div>
    <div class="card"><div class="stat blue"><span class="s-k">MTTC</span><span class="s-v">${R.headline.mttc.toFixed(2)}</span><span class="s-n">Efficiency ${R.headline.efficiency.toFixed(3)}</span></div></div>
  </div>

  <h3>Per scenario</h3>
  <div class="card">
    <table class="wide">
      <thead><tr><th>Scenario</th><th class="num">n</th><th class="num">Hit@10</th><th class="num">MRR</th><th class="num">MTTC</th><th>Read</th></tr></thead>
      <tbody>
        ${R.scenarios.map((s) => `<tr>
          <td>${esc(s.name)}</td>
          <td class="num">${s.n}</td>
          <td class="num">${s.hit.toFixed(3)}</td>
          <td class="num">${s.mrr.toFixed(3)}</td>
          <td class="num">${s.mttc.toFixed(2)}</td>
          <td style="font-size:.78rem">${esc(s.note)}</td></tr>`).join("")}
      </tbody>
    </table>
  </div>

  <h3>How it got here — one change at a time</h3>
  <div class="card">
    <table class="wide">
      <thead><tr><th>Change</th><th class="num">TechScore</th><th class="num">Hit@10</th><th class="num">MRR</th><th class="num">MTTC</th><th>Note</th></tr></thead>
      <tbody>
        ${R.progression.map((p, i) => `<tr class="${i === R.progression.length - 1 ? "hi" : ""}">
          <td>${esc(p.label)}</td>
          <td class="num">${p.ts.toFixed(3)}</td>
          <td class="num">${p.hit.toFixed(3)}</td>
          <td class="num">${p.mrr.toFixed(3)}</td>
          <td class="num">${p.mttc.toFixed(2)}</td>
          <td style="font-size:.78rem">${esc(p.note)}</td></tr>`).join("")}
      </tbody>
    </table>
    <div class="note-box">Each row is a single change measured against a byte-identical rerun of the previous one.
    The two largest gains were not model changes: rewriting the question policy (+0.097) and making retrieval
    and ranking read the same verbatim customer text (+0.018 combined).</div>
  </div>

  <h3>Cost and feasibility</h3>
  <div class="card">
    <table class="wide"><tbody>
      ${R.facts.map(([k, v]) => `<tr><td style="width:190px">${esc(k)}</td><td style="font-size:.8rem">${esc(v)}</td></tr>`).join("")}
    </tbody></table>
  </div>

  <h3>Open items — stated plainly</h3>
  <div class="grid g2">
    ${R.open.map((o) => `<div class="card"><h4>${esc(o.title)}</h4><p>${esc(o.body)}</p></div>`).join("")}
  </div>
`;

/* ================================================================ doc: team */
$("doc-team").innerHTML = `
  <h2>Team &amp; design principles</h2>
  <p class="lede">Three owners, three vertical slices of the pipeline, one shared data contract in
  <code style="font-family:var(--mono);font-size:.85em">components/models.py</code>.</p>

  <h3>Ownership</h3>
  <div class="grid g3">
    ${TEAM.members.map((m) => `
      <div class="card">
        <h4>${esc(m.name)}</h4>
        <div class="pill p-browse" style="margin:.3rem 0 .6rem">${esc(m.area)}</div>
        <p>${esc(m.body)}</p>
        <div class="files">${m.files.map(esc).join(" · ")}</div>
      </div>`).join("")}
  </div>
  <div class="note-box">${esc(TEAM.shared)}</div>

  <h3>What we would tell another team</h3>
  <div class="grid g2">
    ${TEAM.principles.map(([title, body]) => `
      <div class="card"><h4>${esc(title)}</h4><p>${esc(body)}</p></div>`).join("")}
  </div>

  <h3>Running it yourself</h3>
  <div class="formula">pip install -r requirements.txt          # sentence-transformers, for the second stage
mv catalog.jsonl data/catalog.jsonl     # 50k rows, from the GitHub Release

python3 -m evaluator.local_evaluator    # full public set -> results.json
python3 -m unittest discover -s tests   # unit tests
python3 -m scripts.recall_check         # candidate-pool recall only
python3 -m scripts.cross_encoder_sweep  # top_n x weight grid

TECHJAM_CROSS_ENCODER_DISABLE=1 python3 -m evaluator.local_evaluator   # rule-only baseline</div>
`;

/* ================================================== deep links (#v=…&g=…&n=…) */
// Note: history.replaceState is blocked for file:// documents (opaque origin), so
// the hash is written directly and the resulting hashchange is ignored by echo.
let lastWrittenHash = null;

function syncHash() {
  const parts = [`v=${S.view}`];
  if (S.view === "system") {
    parts.push(`g=${S.graphId}`);
    if (S.trace.on) parts.push(`t=${S.trace.i}`);
    else if (S.selected) parts.push(`n=${S.selected}`);
  }
  const next = `#${parts.join("&")}`;
  if (location.hash === next) return;
  lastWrittenHash = next;
  location.hash = next;
}

function applyHash() {
  const raw = location.hash.replace(/^#/, "");
  if (!raw) return false;
  const q = Object.fromEntries(raw.split("&").map((pair) => pair.split("=")));
  const view = STAGES[q.v] ? q.v : "system";
  if (view === "system") {
    const target = GRAPHS[q.g] ? q.g : "system";
    S.stack = trailFor(target);
    S.graphId = target;
    drawGraph();
    if (q.n && nodeById(q.n)) selectNode(q.n, { zoom: true });
    else clearDetail();
  }
  setView(view);
  if (q.t !== undefined) {
    const step = Math.max(0, Math.min(TRACE.steps.length - 1, parseInt(q.t, 10) || 0));
    startTrace();
    S.trace.i = step;
    renderTrace();
  }
  return true;
}

window.addEventListener("hashchange", () => {
  if (location.hash === lastWrittenHash) return;   // our own write echoing back
  applyHash();
});

/* ==================================================================== boot */
drawGraph();
if (!applyHash()) {
  selectNode("agent", { zoom: false });
  setView("system");
}
