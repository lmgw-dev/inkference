// Drive a headless Firefox over WebDriver BiDi — no geckodriver, no Playwright: Firefox
// speaks BiDi itself behind --remote-debugging-port, and Node ≥ 22 has a WebSocket client.
// Enough of the protocol for the tools here: navigate, evaluate JSON out of the page,
// screenshot, set the viewport. A throwaway profile, so it never touches the user's.
//
//   const ff = await launchFirefox({ width: 1280, height: 900 });
//   await ff.navigate(url);
//   const seam = await ff.evaluate("document.title");   // any expression; JSON round-trip
//   await ff.screenshot("/tmp/shot.png");
//   await ff.close();
//
// Extra knobs for tools that drive the extension itself (script-e2e): `prefs` go into the
// profile's user.js, `args` onto the command line (e.g. --remote-allow-system-access, which
// lets BiDi evaluate in the chrome window — the only way to open a moz-extension: page in a
// tab), and `onOutput` receives Firefox's stdout/stderr after the BiDi banner.

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function launchFirefox({ width = 1280, height = 900, binary = process.env.FIREFOX || "firefox", bannerTimeout = 30000, prefs = {}, args = [], onOutput = null, userCss = null } = {}) {
  const profile = await mkdtemp(join(tmpdir(), "rsd-bidi-"));
  const base = { "remote.active-protocols": 1, "browser.shell.checkDefaultBrowser": false, "datareporting.policy.dataSubmissionEnabled": false };
  // `userCss` is loaded as chrome/userContent.css, i.e. at USER ORIGIN — the only way to
  // reproduce what the extension does, since `tabs.insertCSS({cssOrigin:"user"})` beats every
  // author rule including a more specific one carrying `!important`, and a <style> element
  // cannot. It has to be on disk BEFORE Firefox starts and the pref has to be on, which is why
  // this is a launch option and not something a running browser can be told.
  if (userCss) {
    await mkdir(join(profile, "chrome"), { recursive: true });
    await writeFile(join(profile, "chrome", "userContent.css"), userCss);
    base["toolkit.legacyUserProfileCustomizations.stylesheets"] = true;
  }
  const userJs = Object.entries({ ...base, ...prefs }).map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`);
  await writeFile(join(profile, "user.js"), userJs.join("\n") + "\n");
  const proc = spawn(binary, ["--headless", "--no-remote", "--profile", profile, "--remote-debugging-port", "0", ...args, "about:blank"], { stdio: ["ignore", "pipe", "pipe"] });
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = "";
    let announced = false;
    const onData = (d) => {
      if (announced) {
        if (onOutput) onOutput(String(d));
        return;
      }
      buf += d;
      const m = buf.match(/WebDriver BiDi listening on (ws:\/\/\S+)/);
      if (m) {
        announced = true;
        resolve(m[1]);
      }
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);
    proc.on("exit", (code) => reject(new Error(`firefox exited (${code}) before announcing BiDi\n${buf}`)));
    setTimeout(() => reject(new Error(`no "WebDriver BiDi listening" banner within ${bannerTimeout}ms\n${buf}`)), bannerTimeout).unref();
  });

  const sock = new WebSocket(wsUrl + "/session");
  await new Promise((resolve, reject) => {
    sock.onopen = resolve;
    sock.onerror = () => reject(new Error("websocket to " + wsUrl + " failed"));
  });
  let nextId = 0;
  const pending = new Map();
  sock.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (!m.id || !pending.has(m.id)) return;
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    if (m.type === "error") reject(new Error(`${m.error}: ${m.message}`));
    else resolve(m.result);
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      sock.send(JSON.stringify({ id, method, params }));
    });

  await send("session.new", { capabilities: {} });
  const tree = await send("browsingContext.getTree");
  const context = tree.contexts[0].context;
  await send("browsingContext.setViewport", { context, viewport: { width, height } });

  return {
    context,
    send,
    navigate: (url, { wait = "complete" } = {}) => send("browsingContext.navigate", { context, url, wait }),
    // Evaluate an expression in the page and return its value through JSON.stringify — the
    // BiDi serializer truncates nested objects, JSON does not.
    async evaluate(expression) {
      const r = await send("script.evaluate", { expression: "JSON.stringify((" + expression + "))", target: { context }, awaitPromise: true });
      if (r.type !== "success") throw new Error("evaluate failed: " + JSON.stringify(r.exceptionDetails || r).slice(0, 800));
      const v = r.result && r.result.value;
      return v == null ? undefined : JSON.parse(v);
    },
    async screenshot(path) {
      const r = await send("browsingContext.captureScreenshot", { context, origin: "viewport" });
      await writeFile(path, Buffer.from(r.data, "base64"));
    },
    async close() {
      try {
        await send("session.end");
      } catch {
        /* already gone */
      }
      try {
        sock.close();
      } catch {
        /* ignore */
      }
      proc.kill();
      await rm(profile, { recursive: true, force: true });
    },
  };
}
