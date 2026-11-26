// Visual operation picker for the 3D Probe dialog.
//
// The hidden #probe-3d-kind select stays the single source of truth for the
// requested operation; this module only renders illustrated radio groups that
// write it, plus a top/side diagram of the selected firmware routine.
//
// Geometry follows MakeraZ1Firmware v1.1.2 ATCHandler (M480.1-.10):
// - Outside corner: probe Z on the top face at the start point, move the X/Y
//   offset outward past the edge, lower Z offset below the top, probe back
//   toward each face. Sets X, Y and Z.
// - Inside corner: probe Z on the top face at the start point, move the X/Y
//   offsets diagonally into the pocket, lower Z offset, probe back toward the
//   two walls. Sets X, Y and Z.
// - Bore/pocket: start inside below the top; search each wall up to the X/Y
//   offset and set the center. Z is not probed.
// - Boss/block: probe Z on the top face at the center, move the X/Y offset
//   outside on each side, lower Z offset, probe toward the boss. Sets the
//   center and Z.

const CORNERS = ["top_left", "top_right", "bottom_left", "bottom_right"];
const AXES = ["xy", "x", "y"];

export const PROBE_3D_CATEGORIES = [
  { id: "outside", label: "Outside corner", hint: "Corner of a block" },
  { id: "inside", label: "Inside corner", hint: "Corner of a pocket" },
  { id: "bore_pocket", label: "Bore / pocket", hint: "Center of a hole" },
  { id: "boss_block", label: "Boss / block", hint: "Center of a boss" },
];

const CORNER_LABELS = {
  top_left: "Top-left", top_right: "Top-right", bottom_left: "Bottom-left", bottom_right: "Bottom-right",
};
const AXIS_LABELS = { xy: "X + Y", x: "X only", y: "Y only" };

const isCornerCategory = (category) => category === "outside" || category === "inside";

export function probe3DKindParts(kind) {
  kind = String(kind || "");
  for (const category of ["outside", "inside"]) {
    const variant = kind.startsWith(category + "_") ? kind.slice(category.length + 1) : "";
    if (CORNERS.includes(variant)) return { category, variant };
  }
  for (const category of ["bore_pocket", "boss_block"]) {
    if (kind === category) return { category, variant: "xy" };
    if (kind === category + "_x") return { category, variant: "x" };
    if (kind === category + "_y") return { category, variant: "y" };
  }
  return { category: "outside", variant: "bottom_left" };
}

export function probe3DKindFromParts(category, variant) {
  if (isCornerCategory(category)) return `${category}_${CORNERS.includes(variant) ? variant : "bottom_left"}`;
  if (category !== "bore_pocket" && category !== "boss_block") return "outside_bottom_left";
  return variant === "x" || variant === "y" ? `${category}_${variant}` : category;
}

export function probe3DVariants(category) {
  return isCornerCategory(category)
    ? CORNERS.map((id) => ({ id, label: CORNER_LABELS[id] }))
    : AXES.map((id) => ({ id, label: AXIS_LABELS[id] }));
}

// Operator-facing placement guidance, phrased from the firmware sequence.
export function probe3DPlacement(kind, community = false) {
  const { category, variant } = probe3DKindParts(kind);
  const corner = (CORNER_LABELS[variant] || "").toLowerCase();
  const axes = variant === "x" ? "X" : (variant === "y" ? "Y" : "X/Y");
  switch (category) {
    case "outside":
      return { start: `Start a few mm above the top face, over the stock, within the X/Y offsets of the ${corner} corner.`, sets: "Sets X, Y and Z" };
    case "inside":
      return { start: `Start a few mm above the top face, just outside the ${corner} pocket corner. ${community ? "The cycle sets Z zero at the first contact, then moves diagonally into the pocket." : "The X/Y offsets move diagonally into the pocket."}`, sets: "Sets X, Y and Z" };
    case "bore_pocket":
      return { start: `Start inside the bore, below the top surface, near its center. The ${axes} offset is the search distance toward each wall.`, sets: `Sets the ${axes} center` };
    default:
      return { start: `Start a few mm above the center of the boss. The ${axes} offset must reach past the boss edge from the center.`, sets: `Sets the ${axes} center and Z` };
  }
}

function fmt(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "–";
  return String(Math.round(n * 1000) / 1000);
}

// Corner direction in machine coordinates: the stock (outside) or the pocket
// (inside) lies in this direction from the corner.
function cornerDir(variant) {
  return { x: variant.endsWith("left") ? 1 : -1, y: variant.startsWith("bottom") ? 1 : -1 };
}

const ICON_OPEN = `<svg viewBox="0 0 44 38" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">`;
const SVG_OPEN = (w, h, label) => `<svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${label}" focusable="false">`;
const MARKER = (id, cls) => `<marker id="${id}" viewBox="0 0 10 10" refX="8" refY="5" markerUnits="userSpaceOnUse" markerWidth="9" markerHeight="9" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" class="${cls}"/></marker>`;
const DEFS = `<defs>${MARKER("p3d-arrow-move", "p3d-arrowhead-move")}${MARKER("p3d-arrow-dim", "p3d-arrowhead-dim")}</defs>`;

function arrow(x1, y1, x2, y2, cls = "p3d-probe-move") {
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="${cls}" marker-end="url(#p3d-arrow-move)"/>`;
}
function travel(x1, y1, x2, y2) {
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="p3d-travel"/>`;
}
function ball(x, y, ghost = false) {
  return `<circle cx="${x}" cy="${y}" r="6" class="${ghost ? "p3d-ball-ghost" : "p3d-ball"}"/>`;
}
function origin(x, y, r = 5) {
  const arm = r + 4;
  return `<g class="p3d-origin"><circle cx="${x}" cy="${y}" r="${r}"/><line x1="${x - arm}" y1="${y}" x2="${x + arm}" y2="${y}"/><line x1="${x}" y1="${y - arm}" x2="${x}" y2="${y + arm}"/></g>`;
}
function label(x, y, text, anchor = "middle", cls = "p3d-dim-label") {
  return `<text x="${x}" y="${y}" text-anchor="${anchor}" class="${cls}">${text}</text>`;
}
function dimension(x1, y1, x2, y2, text) {
  const lx = (x1 + x2) / 2;
  const ly = (y1 + y2) / 2 + 4;
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="p3d-dim" marker-start="url(#p3d-arrow-dim)" marker-end="url(#p3d-arrow-dim)"/>` + label(lx, ly, text);
}

// Top view, 200x200, machine +Y up. Returns SVG markup without the wrapper.
function topView(category, variant, values) {
  const cx = 100, cy = 100;
  const sx = (mx) => cx + mx;
  const sy = (my) => cy - my;
  let out = `<rect x="0" y="0" width="200" height="200" class="p3d-view-bg"/>`;
  if (isCornerCategory(category)) {
    const d = cornerDir(variant);
    const corner = { x: -d.x * 22, y: -d.y * 22 };
    const quadrant = (dir) => {
      const x0 = dir.x > 0 ? sx(corner.x) : 0;
      const x1 = dir.x > 0 ? 200 : sx(corner.x);
      const y0 = dir.y > 0 ? 0 : sy(corner.y);
      const y1 = dir.y > 0 ? sy(corner.y) : 200;
      return { x0, y0, w: x1 - x0, h: y1 - y0 };
    };
    if (category === "outside") {
      const q = quadrant(d);
      out += `<rect x="${q.x0}" y="${q.y0}" width="${q.w}" height="${q.h}" class="p3d-stock"/>`;
      const start = { x: corner.x + d.x * 36, y: corner.y + d.y * 36 };
      const outX = { x: corner.x - d.x * 30, y: start.y };
      const outY = { x: start.x, y: corner.y - d.y * 30 };
      out += travel(sx(start.x), sy(start.y), sx(outX.x), sy(outX.y));
      out += travel(sx(start.x), sy(start.y), sx(outY.x), sy(outY.y));
      out += ball(sx(outX.x), sy(outX.y), true) + ball(sx(outY.x), sy(outY.y), true);
      out += arrow(sx(outX.x + d.x * 7), sy(outX.y), sx(corner.x - d.x * 1), sy(outX.y));
      out += arrow(sx(outY.x), sy(outY.y + d.y * 7), sx(outY.x), sy(corner.y - d.y * 1));
      out += ball(sx(start.x), sy(start.y));
      const dimY = outY.y - d.y * 16;
      const dimX = outX.x - d.x * 16;
      out += dimension(sx(start.x), sy(dimY), sx(outX.x), sy(dimY), "X " + fmt(values.x));
      out += dimension(sx(dimX), sy(start.y), sx(dimX), sy(outY.y), "Y " + fmt(values.y));
      out += origin(sx(corner.x), sy(corner.y));
    } else {
      // Material everywhere except the pocket quadrant.
      out += `<rect x="0" y="0" width="200" height="200" class="p3d-stock"/>`;
      const q = quadrant(d);
      out += `<rect x="${q.x0}" y="${q.y0}" width="${q.w}" height="${q.h}" class="p3d-pocket"/>`;
      const start = { x: corner.x - d.x * 18, y: corner.y - d.y * 18 };
      const inside = { x: corner.x + d.x * 40, y: corner.y + d.y * 40 };
      out += travel(sx(start.x), sy(start.y), sx(inside.x), sy(inside.y));
      out += ball(sx(inside.x), sy(inside.y), true);
      out += arrow(sx(inside.x - d.x * 7), sy(inside.y), sx(corner.x + d.x * 1), sy(inside.y));
      out += arrow(sx(inside.x), sy(inside.y - d.y * 7), sx(inside.x), sy(corner.y + d.y * 1));
      out += ball(sx(start.x), sy(start.y));
      const dimY = inside.y + d.y * 20;
      const dimX = inside.x + d.x * 20;
      out += dimension(sx(start.x), sy(dimY), sx(inside.x), sy(dimY), "X " + fmt(values.x));
      out += dimension(sx(dimX), sy(start.y), sx(dimX), sy(inside.y), "Y " + fmt(values.y));
      out += origin(sx(corner.x), sy(corner.y));
    }
    return out;
  }
  const useX = variant !== "y";
  const useY = variant !== "x";
  if (category === "bore_pocket") {
    const r = 58;
    out += `<rect x="0" y="0" width="200" height="200" class="p3d-stock"/><circle cx="${cx}" cy="${cy}" r="${r}" class="p3d-pocket"/>`;
    if (useX) {
      out += arrow(cx - 7, cy, cx - r + 2, cy) + arrow(cx + 7, cy, cx + r - 2, cy);
      out += label(cx - r / 2, cy - 8, "X " + fmt(values.x));
    }
    if (useY) {
      out += arrow(cx, cy - 7, cx, cy - r + 2) + arrow(cx, cy + 7, cx, cy + r - 2);
      out += label(cx + 8, cy + r / 2 + 4, "Y " + fmt(values.y), "start");
    }
    out += ball(cx, cy) + origin(cx, cy, 10);
    return out;
  }
  // Boss / block
  const r = 40;
  out += `<circle cx="${cx}" cy="${cy}" r="${r}" class="p3d-stock"/>`;
  const reach = 66;
  if (useX) {
    for (const side of [-1, 1]) {
      out += travel(cx, cy, cx + side * reach, cy) + ball(cx + side * reach, cy, true);
      out += arrow(cx + side * (reach - 7), cy, cx + side * (r + 2), cy);
    }
    out += dimension(cx, cy - 16, cx - reach, cy - 16, "X " + fmt(values.x));
  }
  if (useY) {
    for (const side of [-1, 1]) {
      out += travel(cx, cy, cx, cy + side * reach) + ball(cx, cy + side * reach, true);
      out += arrow(cx, cy + side * (reach - 7), cx, cy + side * (r + 2));
    }
    out += dimension(cx + 16, cy, cx + 16, cy + reach, "Y " + fmt(values.y));
  }
  out += ball(cx, cy) + origin(cx, cy, 10);
  return out;
}

// Side section through the X probe, 160x200. Top face at y=80.
function sideView(category, variant, values) {
  const top = 80;
  const zDepth = 34;
  let out = `<rect x="0" y="0" width="160" height="200" class="p3d-view-bg"/>`;
  const stylus = (x, y, ghost = false) =>
    `<line x1="${x}" y1="${y - 6}" x2="${x}" y2="${y - 46}" class="${ghost ? "p3d-stylus-ghost" : "p3d-stylus"}"/>` + ball(x, y, ghost);
  const zDim = (x) => dimension(x, top, x, top + zDepth, "Z " + fmt(values.z));
  const zZero = (x0, x1) => `<line x1="${x0}" y1="${top}" x2="${x1}" y2="${top}" class="p3d-zero-line"/>` + label(x0 + 3, top - 6, "Z0", "start", "p3d-zero-label");
  const centerLabel = variant === "y" ? "Y center" : (variant === "x" ? "X center" : "X/Y center");
  if (category === "outside") {
    const dx = cornerDir(variant).x;
    const face = dx > 0 ? 60 : 100;
    const stockX = dx > 0 ? face : 0;
    out += `<rect x="${stockX}" y="${top}" width="${dx > 0 ? 160 - face : face}" height="${200 - top}" class="p3d-stock"/>`;
    const start = face + dx * 30;
    const outside = face - dx * 30;
    out += stylus(start, top - 7);
    out += arrow(start, top - 30, start, top - 9, "p3d-probe-move");
    out += travel(start, top - 52, outside, top - 52) + travel(outside, top - 52, outside, top + zDepth);
    out += stylus(outside, top + zDepth, true);
    out += arrow(outside + dx * 7, top + zDepth, face - dx * 2, top + zDepth);
    out += zDim(outside - dx * 16, dx > 0 ? "end" : "start");
    out += zZero(dx > 0 ? face : 0, dx > 0 ? 160 : face);
    return out;
  }
  if (category === "inside") {
    const dx = cornerDir(variant).x;
    const wall = dx > 0 ? 50 : 110;
    out += `<rect x="${dx > 0 ? 0 : wall}" y="${top}" width="${dx > 0 ? wall : 160 - wall}" height="${200 - top}" class="p3d-stock"/>`;
    out += `<rect x="${dx > 0 ? wall : 0}" y="${top + 70}" width="${dx > 0 ? 160 - wall : wall}" height="${200 - top - 70}" class="p3d-stock"/>`;
    const start = wall - dx * 22;
    const inside = wall + dx * 40;
    out += stylus(start, top - 7);
    out += arrow(start, top - 30, start, top - 9, "p3d-probe-move");
    out += travel(start, top - 52, inside, top - 52) + travel(inside, top - 52, inside, top + zDepth);
    out += stylus(inside, top + zDepth, true);
    out += arrow(inside - dx * 7, top + zDepth, wall + dx * 2, top + zDepth);
    out += zDim(inside + dx * 18, dx > 0 ? "start" : "end");
    out += zZero(dx > 0 ? 0 : wall, dx > 0 ? wall : 160);
    return out;
  }
  if (category === "bore_pocket") {
    out += `<rect x="0" y="${top}" width="35" height="${200 - top}" class="p3d-stock"/><rect x="125" y="${top}" width="35" height="${200 - top}" class="p3d-stock"/>`;
    out += `<rect x="35" y="${top + 90}" width="90" height="${200 - top - 90}" class="p3d-stock"/>`;
    out += stylus(80, top + 40);
    out += arrow(73, top + 40, 37, top + 40) + arrow(87, top + 40, 123, top + 40);
    out += label(80, top + 62, centerLabel, "middle", "p3d-dim-label");
    return out;
  }
  out += `<rect x="45" y="${top}" width="70" height="${200 - top}" class="p3d-stock"/>`;
  out += `<rect x="0" y="${top + 80}" width="160" height="${200 - top - 80}" class="p3d-stock"/>`;
  out += stylus(80, top - 7);
  out += arrow(80, top - 30, 80, top - 9, "p3d-probe-move");
  for (const side of [-1, 1]) {
    const x = 80 + side * 56;
    out += travel(80, top - 52, x, top - 52) + travel(x, top - 52, x, top + zDepth);
    out += stylus(x, top + zDepth, true);
    out += arrow(x - side * 7, top + zDepth, 80 + side * 37, top + zDepth);
  }
  out += zDim(152);
  out += zZero(45, 115);
  return out;
}

export function probe3DDiagramSVG(kind, values = {}) {
  const { category, variant } = probe3DKindParts(kind);
  const name = PROBE_3D_CATEGORIES.find((c) => c.id === category)?.label || "";
  const variantLabel = (isCornerCategory(category) ? CORNER_LABELS : AXIS_LABELS)[variant] || "";
  return SVG_OPEN(376, 228, `${name}, ${variantLabel}: top view and side section of the probing moves`) + DEFS +
    `<g transform="translate(0 20)">${topView(category, variant, values)}</g>` +
    `<g transform="translate(216 20)">${sideView(category, variant, values)}</g>` +
    label(0, 13, "TOP VIEW", "start", "p3d-view-title") + label(216, 13, "SIDE SECTION", "start", "p3d-view-title") +
    `</svg>`;
}

function categoryIcon(id) {
  const body = {
    outside: `<rect x="14" y="8" width="26" height="22" class="p3d-icon-stock"/><circle cx="14" cy="30" r="3.5" class="p3d-icon-mark"/>`,
    inside: `<path d="M4 4 H40 V34 H18 V14 H4 Z" class="p3d-icon-stock"/><circle cx="18" cy="14" r="3.5" class="p3d-icon-mark"/>`,
    bore_pocket: `<rect x="4" y="4" width="36" height="30" class="p3d-icon-stock"/><circle cx="22" cy="19" r="10" class="p3d-icon-hole"/><circle cx="22" cy="19" r="3" class="p3d-icon-mark"/>`,
    boss_block: `<circle cx="22" cy="19" r="12" class="p3d-icon-stock"/><circle cx="22" cy="19" r="3" class="p3d-icon-mark"/>`,
  }[id];
  return ICON_OPEN + body + `</svg>`;
}

function variantIcon(category, id) {
  let body;
  if (isCornerCategory(category)) {
    const d = cornerDir(id);
    const cx = d.x > 0 ? 10 : 34;
    const cy = d.y > 0 ? 30 : 8;
    body = category === "outside"
      ? `<rect x="${d.x > 0 ? 10 : 6}" y="${d.y > 0 ? 6 : 8}" width="28" height="24" class="p3d-icon-stock"/>`
      : `<rect x="2" y="2" width="40" height="34" class="p3d-icon-stock"/><rect x="${d.x > 0 ? 10 : 2}" y="${d.y > 0 ? 2 : 8}" width="32" height="28" class="p3d-icon-hole"/>`;
    body += `<circle cx="${cx}" cy="${cy}" r="3.5" class="p3d-icon-mark"/>`;
  } else {
    body = `<circle cx="22" cy="19" r="12" class="${category === "bore_pocket" ? "p3d-icon-hole-ring" : "p3d-icon-stock"}"/>`;
    if (id !== "y") body += `<line x1="4" y1="19" x2="40" y2="19" class="p3d-icon-axis"/>`;
    if (id !== "x") body += `<line x1="22" y1="2" x2="22" y2="36" class="p3d-icon-axis"/>`;
  }
  return ICON_OPEN + body + `</svg>`;
}

function makeOptionButton(document, { id, label, hint, icon, group }) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "p3d-option";
  button.setAttribute("role", "radio");
  button.setAttribute("aria-checked", "false");
  button.tabIndex = -1;
  button.dataset.value = id;
  button.dataset.group = group;
  button.innerHTML = `<span class="p3d-option-icon">${icon}</span><span class="p3d-option-text"><b>${label}</b>${hint ? `<small>${hint}</small>` : ""}</span>`;
  return button;
}

// createProbe3DPicker builds stable option nodes once and afterwards only
// updates their checked/disabled state, so live renders never replace nodes
// that own focus or handlers.
export function createProbe3DPicker({ documentRef = globalThis.document, onChange = () => {} } = {}) {
  const document = documentRef;
  const memory = { corner: "bottom_left", axis: "xy" };
  let built = false;
  let lastDiagram = "";

  const select = () => document.getElementById("probe-3d-kind");
  const categoryGroup = () => document.getElementById("probe-3d-categories");
  const variantGroup = () => document.getElementById("probe-3d-variants");

  function choose(kind) {
    const node = select();
    if (!node || node.disabled || node.value === kind) return;
    node.value = kind;
    onChange(kind);
  }

  function chooseCategory(category) {
    const variant = isCornerCategory(category) ? memory.corner : memory.axis;
    choose(probe3DKindFromParts(category, variant));
  }

  function chooseVariant(variant) {
    const { category } = probe3DKindParts(select()?.value);
    choose(probe3DKindFromParts(category, variant));
  }

  function bindRadioGroup(group, pick) {
    if (!group) return;
    group.addEventListener("click", (event) => {
      const button = event.target?.closest?.(".p3d-option");
      if (!button || button.disabled || !group.contains(button)) return;
      pick(button.dataset.value);
    });
    group.addEventListener("keydown", (event) => {
      const keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
      if (!(event.key in keys)) return;
      const buttons = [...group.querySelectorAll(".p3d-option:not([hidden])")];
      const index = buttons.indexOf(document.activeElement);
      if (index < 0) return;
      event.preventDefault();
      const next = buttons[(index + keys[event.key] + buttons.length) % buttons.length];
      pick(next.dataset.value);
      next.focus();
    });
  }

  function build() {
    if (built) return;
    const categories = categoryGroup();
    const variants = variantGroup();
    if (!categories || !variants) return;
    for (const category of PROBE_3D_CATEGORIES) {
      categories.appendChild(makeOptionButton(document, { ...category, icon: categoryIcon(category.id), group: "category" }));
    }
    for (const category of PROBE_3D_CATEGORIES.map((c) => c.id)) {
      for (const variant of probe3DVariants(category)) {
        const button = makeOptionButton(document, { id: variant.id, label: variant.label, icon: variantIcon(category, variant.id), group: "variant" });
        button.dataset.category = category;
        variants.appendChild(button);
      }
    }
    bindRadioGroup(categories, chooseCategory);
    bindRadioGroup(variants, chooseVariant);
    built = true;
  }

  function sync(buttons, value, disabled) {
    for (const button of buttons) {
      const checked = button.dataset.value === value;
      button.setAttribute("aria-checked", String(checked));
      button.classList.toggle("is-checked", checked);
      button.tabIndex = checked ? 0 : -1;
      button.disabled = disabled;
    }
  }

  function render({ kind, values = {}, pending = false, community = false } = {}) {
    build();
    const { category, variant } = probe3DKindParts(kind);
    if (isCornerCategory(category)) memory.corner = variant;
    else memory.axis = variant;
    const categories = categoryGroup();
    const variants = variantGroup();
    if (categories) sync([...categories.querySelectorAll(".p3d-option")], category, pending);
    if (variants) {
      const visible = [];
      for (const button of variants.querySelectorAll(".p3d-option")) {
        const show = button.dataset.category === category;
        button.hidden = !show;
        if (show) visible.push(button);
      }
      sync(visible, variant, pending);
      variants.setAttribute("aria-label", isCornerCategory(category) ? "Corner" : "Probed axes");
    }
    const diagram = document.getElementById("probe-3d-diagram");
    const svg = probe3DDiagramSVG(kind, values);
    if (diagram && svg !== lastDiagram) {
      diagram.innerHTML = svg;
      lastDiagram = svg;
    }
    const placement = probe3DPlacement(kind, community);
    const start = document.getElementById("probe-3d-placement");
    const sets = document.getElementById("probe-3d-sets");
    if (start && start.textContent !== placement.start) start.textContent = placement.start;
    if (sets && sets.textContent !== placement.sets) sets.textContent = placement.sets;
  }

  function focusSelected() {
    build();
    const checked = categoryGroup()?.querySelector('.p3d-option[aria-checked="true"]');
    if (checked) checked.focus();
    else select()?.focus();
  }

  return { render, focusSelected };
}
