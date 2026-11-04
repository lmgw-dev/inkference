// Right-click "Ask LLM" menu. The click is a user gesture, so the handler may call
// sidebarAction.open(). Action dispatch is delegated to the background orchestrator.
//
// Everything hangs off ONE top-level item: as soon as an extension registers a second
// top-level menu entry, Firefox buries them all in a submenu named after the extension,
// which would push the existing actions a click deeper. So "Read aloud" joins the same
// parent, below a separator.

import { CONTEXT_ACTIONS } from "../common/prompts.js";

const PARENT_ID = "rsd-root";
const TTS_READ_ID = "rsd-tts-read";
const TTS_PANEL_ID = "rsd-tts-panel";
const TTS_STOP_ID = "rsd-tts-stop";

// Returns the promise that resolves once the menus exist, so callers that register their
// own menus afterwards (e.g. the dark-mode toolbar menu) don't race our removeAll().
export function registerMenus({ onAction, onTts }) {
  const ready = browser.menus.removeAll().then(() => {
    browser.menus.create({
      id: PARENT_ID,
      title: "Ask LLM",
      contexts: ["selection", "page"],
    });
    for (const a of CONTEXT_ACTIONS) {
      browser.menus.create({
        id: "rsd-" + a.id,
        parentId: PARENT_ID,
        title: a.title,
        contexts: ["selection", "page"],
      });
    }
    // Speech items. "Read aloud" needs a selection; "Stop reading" appears in any context
    // (you shouldn't have to re-select the text to shut it up) but only while it is talking.
    browser.menus.create({ id: "rsd-tts-sep", parentId: PARENT_ID, type: "separator", contexts: ["selection"] });
    browser.menus.create({
      id: TTS_READ_ID,
      parentId: PARENT_ID,
      title: "Read aloud",
      contexts: ["selection"],
    });
    browser.menus.create({
      id: TTS_PANEL_ID,
      parentId: PARENT_ID,
      title: "Read aloud in sidebar…",
      contexts: ["selection"],
    });
    browser.menus.create({
      id: TTS_STOP_ID,
      parentId: PARENT_ID,
      title: "Stop reading",
      contexts: ["selection", "page"],
      visible: false,
    });
  });

  browser.menus.onClicked.addListener((info, tab) => {
    const id = String(info.menuItemId);
    const ttsKind = { [TTS_READ_ID]: "read", [TTS_PANEL_ID]: "panel", [TTS_STOP_ID]: "stop" }[id];
    if (ttsKind) {
      onTts(ttsKind, info, tab);
      return;
    }
    if (!id.startsWith("rsd-") || id === PARENT_ID) return;
    const action = CONTEXT_ACTIONS.find((a) => "rsd-" + a.id === id);
    if (action) onAction(action, info, tab);
  });

  return ready;
}

// Show "Stop reading" only while something is being read. refresh() redraws a menu that is
// already open (harmless otherwise), so the item appears/disappears even mid-playback.
export function setMenuSpeaking(speaking) {
  browser.menus
    .update(TTS_STOP_ID, { visible: !!speaking })
    .then(() => browser.menus.refresh())
    .catch(() => {
      /* menus not created yet, or no menu open */
    });
}
