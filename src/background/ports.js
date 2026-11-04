// Registry of connected sidebar ports. Conversation state is global (one active chat in
// v1), so we broadcast every update to all connected sidebars — multiple windows simply
// mirror the same conversation. A sidebar that reloads just re-runs HELLO and re-hydrates.
// Each port's window (from its HELLO) is kept too, for the few messages that are about one
// window only (opening the Script panel from that window's address bar).

const ports = new Set();
const windows = new Map(); // port -> windowId

export function addPort(port) {
  ports.add(port);
}

export function setPortWindow(port, windowId) {
  windows.set(port, windowId);
}

export function removePort(port) {
  ports.delete(port);
  windows.delete(port);
}

export function hasPorts() {
  return ports.size > 0;
}

export function broadcast(msg) {
  for (const p of ports) {
    try {
      p.postMessage(msg);
    } catch {
      // port died between disconnect and our send; drop it
      ports.delete(p);
    }
  }
}

// Only the sidebars of one window. False when none of them is connected.
export function sendToWindow(windowId, msg) {
  let sent = false;
  for (const p of ports) {
    if (windows.get(p) !== windowId) continue;
    try {
      p.postMessage(msg);
      sent = true;
    } catch {
      ports.delete(p);
    }
  }
  return sent;
}
