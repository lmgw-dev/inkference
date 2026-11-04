// Mock "locked-down device" for exercising the page agent's unlock → verify → patch loop
// (there's no real gated router to test against). Serves mock/public/ over HTTP — the agent
// refuses non-http(s) tabs and webRequest needs real requests, so a file:// page won't do — and
// simulates a device backend at /api/save/* so `last_request` gets a real 2xx/4xx verdict.
//
//   node mock/server.mjs            # or: npm run mock   (PORT env overrides the default)
//
// Each endpoint models a different lock depth the agent has to handle:
//   /api/save/lan  — accepts anything (the lock was purely the disabled field in the page).
//   /api/save/dhcp — accepts anything (the page STRIPPED the field; patch_request must re-add it).
//   /api/save/wan  — ENFORCES mtu<=1500 → 400 (a limit real on the device, not just hidden).
//
// Every request is logged so you can watch exactly what the page sent (and whether the agent's
// value actually arrived) alongside the sidebar's own step log.
//
// /game.html is a separate fixture: a pure-<canvas> "game" with zero DOM controls, for the
// screen-vision tools (screenshot/click_screen) — it draws its own click crosshair + hit/miss
// log so a grounding model's aim can be eyeballed directly on the page.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize } from "node:path";

const PORT = Number(process.env.PORT) || 8088;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "public");

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });
}

// Parse whatever the page sent — JSON or form-urlencoded — into a flat object for logging/enforcing.
function parseBody(raw, contentType) {
  if (/json/i.test(contentType || "")) {
    try { return JSON.parse(raw || "{}"); } catch { return { _unparsed: raw }; }
  }
  const out = {};
  for (const [k, v] of new URLSearchParams(raw)) out[k] = v;
  return out;
}

function json(res, code, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(s) });
  res.end(s);
}

async function handleSave(which, req, res) {
  const raw = await readBody(req);
  const body = parseBody(raw, req.headers["content-type"]);
  console.log(`\n[device] POST /api/save/${which}  ${req.headers["content-type"] || "?"}`);
  console.log(`[device] received: ${JSON.stringify(body)}`);

  if (which === "wan") {
    const mtu = Number(body.mtu);
    if (Number.isFinite(mtu) && mtu > 1500) {
      console.log(`[device] REJECT: mtu ${mtu} > 1500 (enforced on the device)`);
      return json(res, 400, { ok: false, error: `MTU ${mtu} exceeds this device's maximum of 1500` });
    }
  }
  console.log(`[device] ACCEPT (200)`);
  return json(res, 200, { ok: true, saved: body });
}

async function serveStatic(pathname, res) {
  const rel = normalize(pathname === "/" ? "/router.html" : pathname).replace(/^(\.\.[/\\])+/, "");
  const file = join(ROOT, rel);
  if (!file.startsWith(ROOT)) return json(res, 403, { error: "forbidden" });
  try {
    const buf = await readFile(file);
    const ext = file.slice(file.lastIndexOf("."));
    res.writeHead(200, { "Content-Type": TYPES[ext] || "application/octet-stream" });
    res.end(buf);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  }
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const m = url.pathname.match(/^\/api\/save\/(lan|dhcp|wan)$/);
  if (m && req.method === "POST") return handleSave(m[1], req, res);
  if (req.method === "GET") return serveStatic(url.pathname, res);
  json(res, 405, { error: "method not allowed" });
}).listen(PORT, () => {
  console.log(`\nMock locked-down device → http://localhost:${PORT}/\n`);
  console.log("Open that in the `npm run dev` Firefox, open the rsd sidebar, tick “Use page”, then try:");
  console.log('  LAN  (cosmetic lock)   "Change the LAN IP range start to 10.0.0.1 — it\'s greyed out, unlock it and save."');
  console.log('  DHCP (page strips it)  "Set the DHCP pool end to 192.168.1.250 and make sure it actually saves."');
  console.log('  WAN  (device-enforced) "Set the WAN MTU to 9000 and save it."   → device should reject it (400)\n');
  console.log("Watch this terminal to see exactly what each save request carried.\n");
});
