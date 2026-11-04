// Screen vision for the page agent — the fallback for pages the DOM tools can't drive
// (canvas/WebGL/WASM UIs, where observe lists nothing even though controls are on screen).
//
// Two concerns, deliberately split because they fail differently:
//   SEEING  — the planner model gets the real screenshot attached to the conversation and
//             judges state natively (needs a vision-capable chat model, nothing else).
//   POINTING — turning "the 'Buy' button, top right" into coordinates. This is a separate
//             single-purpose call at temperature 0, NOT something the planner answers
//             mid-reasoning: asked for pixels inline, gemma4-12b put the mock game's Buy
//             button 260px off (outside it); asked as a detection in its OWN trained format
//             it lands within ~5px, deterministically, in 0.8s. Same model, same screenshot —
//             the format is what matters. So the grounder may simply BE the chat model
//             ("same as chat model" in Options), and a dedicated grounding model stays
//             swappable for planners that can't detect.
//
// The prompt is therefore the models' native detection phrasing ("detect X, output only
// json"), and the reply conventions are read off the KEY the model uses, never guessed:
//   box_2d  — Gemma/Gemini: [y1,x1,y2,x2], Y FIRST, normalized to a 1000x1000 grid,
//             descaled per axis (documented at ai.google.dev/gemma/docs/capabilities/vision).
//   bbox_2d — Qwen-VL: [x1,y1,x2,y2] in ABSOLUTE pixels of the image it was given.
// A box collapses to its center. Which convention was used is reported to the caller so it
// shows up in the step log rather than silently producing a transposed click.
//
// Coordinate spaces: captureVisibleTab returns the viewport at DEVICE resolution while DOM
// clicks happen in CSS pixels; the scale between them is dpr × zoom, so it is measured from
// the actual decoded image rather than assumed.

import { chatOnce } from "./gateway.js";

// Capture the agent tab's visible viewport as a PNG data URL (PNG keeps small UI text crisp
// for the grounding model's OCR), plus both coordinate spaces for mapping points back.
export async function captureViewport(tabId) {
  const tab = await browser.tabs.get(tabId);
  // captureVisibleTab shoots the window's ACTIVE tab — if the user tabbed away mid-run we'd
  // silently screenshot (and click!) the wrong page, so refuse instead.
  if (!tab.active) throw new Error("the task's tab is no longer the active tab — switch back to it");
  const res = await browser.tabs.executeScript(tabId, { code: "({ w: innerWidth, h: innerHeight })" });
  const vp = (res && res[0]) || {};
  if (!vp.w || !vp.h) throw new Error("couldn't measure the page's viewport");
  const dataUrl = await browser.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  const img = await imageSize(dataUrl);
  return { dataUrl, imgW: img.w, imgH: img.h, cssW: vp.w, cssH: vp.h };
}

// The persistent background page has a DOM, so the capture's true size is one <img> load.
function imageSize(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => reject(new Error("couldn't decode the screenshot"));
    img.src = dataUrl;
  });
}

// One grounding call: screenshot + verbal target in → { found:false, reason } or
// { found:true, x, y (CSS px, ready for clickAt), imgX, imgY }. One user turn, image first,
// instruction after — the shape grounding models are tuned on; no system message. Gateway/
// HTTP errors throw (GatewayError); an unusable ANSWER is returned as found:false so the
// planner can rephrase instead of the whole turn dying.
export async function groundTarget({ gatewayUrl, gatewayKey, model, shot, target, signal }) {
  const messages = [
    {
      role: "user",
      content: [
        { type: "image_url", image_url: { url: shot.dataUrl } },
        { type: "text", text: groundPrompt(target) },
      ],
    },
  ];
  const reply = await chatOnce({ gatewayUrl, gatewayKey, model, messages, signal, temperature: 0 });
  const p = parseGroundReply(reply);
  if (!p) return { found: false, reason: "the model answered unusably: " + String(reply || "(empty)").slice(0, 200) };
  if (!p.found) return p;
  // { x, y } always (the click point) plus { w, h } when the model returned a box.
  return { found: true, space: p.space, ...toCss(p, shot) };
}

// The models' OWN detection phrasing — this exact form is what they are trained on, and it is
// worth far more than any wording of ours: the same model asked for pixels in prose missed by
// hundreds of them. The target text is passed through verbatim (a quoted label plus a position
// hint reads fine as a detection query), and the image size is not stated because the answer
// is in the model's own coordinate convention, not ours.
function groundPrompt(target) {
  return `detect ${target}, output only \`\`\`json`;
}

// Parse a detection reply into { found, x, y, space } (or null if nothing usable). `space`
// records WHICH convention was recognized so the click can be scaled correctly and the choice
// can be shown to the user:
//   "grid1000" — box_2d, y-first, 1000x1000 grid (Gemma/Gemini)
//   "image"    — absolute pixels of the screenshot (Qwen-VL bbox_2d, bare points)
//   "fraction" — 0..1 fractions of the image (Molmo-style percentages already divided)
// An empty list or a "no detections" sentence is a real answer — the target is not on screen —
// so it maps to found:false, never to a parse failure.
export function parseGroundReply(text) {
  if (!text) return null;
  const s = String(text).trim();
  const body = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();

  for (const c of [body, (s.match(/\[[\s\S]*\]/) || [])[0], (s.match(/\{[\s\S]*\}/) || [])[0]]) {
    if (!c) continue;
    let j;
    try { j = JSON.parse(c); } catch { continue; }
    if (Array.isArray(j) && j.length === 0) return { found: false, reason: "the model found no such element on screen" };
    const hit = pointOf(j);
    if (hit) return { found: true, ...hit };
    if (j && j.found === false) return { found: false, reason: typeof j.reason === "string" ? j.reason : "" };
  }
  // Prose refusal — Gemma answers absent targets with "I did not find any bounding box
  // detections for X." rather than an empty list.
  if (/\b(did not|didn't|could not|couldn't|cannot|can't|no)\b[^.]*\b(find|detect|locate|see|present|visible|detections?)\b/i.test(s)) {
    return { found: false, reason: clipLine(s) };
  }
  const t = body.match(/\(?\s*(\d{1,5})\s*,\s*(\d{1,5})\s*\)?/);
  if (t) return { found: true, x: +t[1], y: +t[2], space: "image" };
  return null;
}

// Depth-first hunt for the first coordinate carrier, so a detection list, a single object, or
// a `{"detections":[…]}` wrapper all resolve. Key names decide the convention.
function pointOf(j, depth = 0) {
  if (!j || typeof j !== "object" || depth > 4) return null;
  if (Array.isArray(j)) {
    if (j.length === 4 && j.every(isNum)) return box(j, "image", false); // bare box: pixels, x-first
    if (j.length === 2 && j.every(isNum)) return { x: +j[0], y: +j[1], space: "image" };
    for (const el of j) { const hit = pointOf(el, depth + 1); if (hit) return hit; }
    return null;
  }
  // Gemma/Gemini: [y1,x1,y2,x2] on a 1000x1000 grid. Y FIRST — reading it as x-first
  // transposes every click, which is the whole reason `space` exists.
  if (Array.isArray(j.box_2d) && j.box_2d.length === 4 && j.box_2d.every(isNum)) return box(j.box_2d, "grid1000", true);
  // Qwen-VL: absolute pixels, x-first.
  for (const k of ["bbox_2d", "bbox", "box", "rect"]) {
    if (Array.isArray(j[k]) && j[k].length === 4 && j[k].every(isNum)) return box(j[k], "image", false);
  }
  if (isNum(j.x) && isNum(j.y)) return { x: +j.x, y: +j.y, space: "image" };
  if (isNum(j.x1) && isNum(j.y1) && isNum(j.x2) && isNum(j.y2)) return box([j.x1, j.y1, j.x2, j.y2], "image", false);
  for (const k of ["point", "point_2d", "position", "center", "coordinates", "detections", "objects", "items"]) {
    if (j[k] != null) { const hit = pointOf(j[k], depth + 1); if (hit) return hit; }
  }
  return null;
}

// Box → center PLUS its extent. The width/height are what `highlight_screen` draws its ellipse
// around, and they are free here — the detection already returned a rectangle, so throwing it
// away would mean a second call to get it back. They also make a bad answer legible: a "button"
// the size of the viewport is a miss the center point alone can't reveal.
// `yFirst` swaps the axis order for the Gemma convention.
function box(v, space, yFirst) {
  const a = v.map(Number);
  const [y1, x1, y2, x2] = yFirst ? a : [a[1], a[0], a[3], a[2]];
  return { x: (x1 + x2) / 2, y: (y1 + y2) / 2, w: Math.abs(x2 - x1), h: Math.abs(y2 - y1), space };
}

function isNum(v) {
  return typeof v === "number" ? Number.isFinite(v) : typeof v === "string" && v.trim() !== "" && Number.isFinite(+v);
}

function clipLine(s) {
  const t = String(s).replace(/\s+/g, " ").trim();
  return t.length > 160 ? t.slice(0, 159) + "…" : t;
}

// Model-space geometry → CSS pixels, by the convention the parser recognized. Each space is
// just a pair of per-axis scale factors: grid1000 divides by the square 1000-grid (the grid is
// square, the viewport is not, so the axes scale differently), image space by the measured
// capture size, fractions by 1. Coordinates in (0,1] are fractions — unambiguous, since a
// sub-pixel click point is meaningless. Width/height ride along when the model gave a box.
export function toCss(pt, shot) {
  const frac = pt.space === "fraction" || (pt.space !== "grid1000" && pt.x > 0 && pt.x <= 1 && pt.y > 0 && pt.y <= 1);
  const sx = pt.space === "grid1000" ? shot.cssW / 1000 : frac ? shot.cssW : shot.cssW / shot.imgW;
  const sy = pt.space === "grid1000" ? shot.cssH / 1000 : frac ? shot.cssH : shot.cssH / shot.imgH;
  // Clamp into the viewport: an extreme-edge coordinate would otherwise round to exactly
  // cssW/cssH, which clickAt rightly treats as outside it.
  const out = {
    x: Math.min(Math.max(Math.round(pt.x * sx), 0), shot.cssW - 1),
    y: Math.min(Math.max(Math.round(pt.y * sy), 0), shot.cssH - 1),
  };
  if (Number.isFinite(pt.w) && Number.isFinite(pt.h)) {
    out.w = Math.min(Math.round(pt.w * sx), shot.cssW);
    out.h = Math.min(Math.round(pt.h * sy), shot.cssH);
  }
  return out;
}
