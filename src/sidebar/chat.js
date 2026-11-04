// Transcript rendering. Assistant messages are markdown; we render with `marked` and
// sanitize with DOMPurify before inserting, since modern marked passes raw HTML through
// untouched and this sidebar is a privileged extension page. User messages are inserted as
// plain text (never as HTML).
//
// An answer must not make the browser FETCH anything either: the page agent reads pages, so a
// page can steer what the answer says, and an <img src> (or a CSS url(), an <svg><image>, a
// poster frame) in it would beacon to that page's server from here the moment it renders. So
// text and links stay; images, media, inline SVG/MathML, stylesheets and forms go, as does
// every attribute that names a resource. An image leaves its alt text behind.

import { marked } from "../vendor/marked.js";
import DOMPurifyDefault from "../vendor/dompurify.js";

// DOMPurify's ESM default auto-initializes against `window` in a browser; if it's still the
// uninitialized factory (no .sanitize), bind it to this page's window.
const DOMPurify = typeof DOMPurifyDefault.sanitize === "function" ? DOMPurifyDefault : DOMPurifyDefault(window);

marked.setOptions({ breaks: true, gfm: true });

const PURIFY = {
  FORBID_TAGS: ["img", "picture", "source", "video", "audio", "track", "style", "svg", "math", "form"],
  FORBID_ATTR: ["src", "srcset", "poster", "background", "style", "action", "formaction", "xlink:href", "ping", "data"],
};

DOMPurify.addHook("uponSanitizeElement", (node, data) => {
  if (data.tagName !== "img" || !node.parentNode) return;
  const alt = (node.getAttribute("alt") || "").trim();
  node.parentNode.insertBefore(node.ownerDocument.createTextNode(alt ? `[image: ${alt}]` : "[image]"), node);
});

function mdToHtml(text) {
  return DOMPurify.sanitize(marked.parse(text || ""), PURIFY);
}

function badge(text, kind) {
  const b = document.createElement("span");
  b.className = "badge" + (kind === "err" ? " badge-err" : "");
  b.textContent = text;
  return b;
}

export function createChat(root) {
  let messages = [];
  let lastBody = null; // body element of the in-progress assistant bubble
  let lastWrap = null; // its wrapper, so we can attach a finish badge without a full re-render
  const confirms = new Map(); // confirm id -> its open card ({ buttons, status })

  function makeBubble(m) {
    const wrap = document.createElement("div");
    wrap.className = "msg msg-" + m.role;

    const role = document.createElement("div");
    role.className = "msg-role";
    role.textContent = m.role === "user" ? "You" : "Assistant";

    const body = document.createElement("div");
    body.className = "msg-body";
    if (m.role === "assistant") body.innerHTML = mdToHtml(m.content);
    else body.textContent = m.display || m.content;

    wrap.append(role, body);
    if (m.finishReason === "length") wrap.append(badge("stopped early (length)"));
    else if (m.finishReason === "cancelled") wrap.append(badge("cancelled"));
    if (m.error) wrap.append(badge("error: " + m.error, "err"));
    return { wrap, body };
  }

  function scrollToEnd() {
    root.scrollTop = root.scrollHeight;
  }

  function fullRender() {
    root.textContent = "";
    lastBody = null;
    confirms.clear();
    for (const m of messages) {
      const { wrap, body } = makeBubble(m);
      root.append(wrap);
      if (m.role === "assistant") lastBody = m.incomplete ? body : null;
    }
    scrollToEnd();
  }

  return {
    // Replace the whole transcript (hydration). `streaming` marks the last assistant
    // message as still in progress so deltas keep appending to it.
    setMessages(next, streaming) {
      messages = (next || []).map((m) => ({ ...m }));
      if (streaming && messages.length) {
        const last = messages[messages.length - 1];
        if (last.role === "assistant") last.incomplete = true;
      }
      fullRender();
    },
    addUser(m) {
      messages.push({ ...m });
      root.append(makeBubble(m).wrap);
      scrollToEnd();
    },
    startAssistant() {
      const m = { role: "assistant", content: "", incomplete: true };
      messages.push(m);
      const { wrap, body } = makeBubble(m);
      root.append(wrap);
      lastBody = body;
      lastWrap = wrap;
      scrollToEnd();
    },
    delta(text) {
      const m = messages[messages.length - 1];
      if (!m || m.role !== "assistant") return;
      m.content += text;
      if (lastBody) lastBody.innerHTML = mdToHtml(m.content);
      scrollToEnd();
    },
    endAssistant(finishReason) {
      const m = messages[messages.length - 1];
      if (m && m.role === "assistant") {
        m.incomplete = false;
        if (finishReason) m.finishReason = finishReason;
      }
      // Attach the finish badge in place rather than re-rendering the whole transcript: a
      // page-agent turn leaves ephemeral step notes in the DOM above the answer, and a full
      // re-render (which rebuilds only from persisted messages) would wipe them.
      if (lastWrap && m) {
        if (m.finishReason === "length") lastWrap.append(badge("stopped early (length)"));
        else if (m.finishReason === "cancelled") lastWrap.append(badge("cancelled"));
        if (m.error) lastWrap.append(badge("error: " + m.error, "err"));
      }
      lastBody = null;
      lastWrap = null;
      scrollToEnd();
    },
    isEmpty() {
      return messages.length === 0;
    },

    // Agent-run output. These are ephemeral (not part of the persisted conversation) — a
    // compact line per step so a long run stays readable.
    addNote(kind, text) {
      const wrap = document.createElement("div");
      wrap.className = "agent-step agent-" + kind;
      const tag = document.createElement("span");
      tag.className = "agent-kind";
      tag.textContent = kind;
      const body = document.createElement("span");
      body.className = "agent-text";
      body.textContent = text || "";
      wrap.append(tag, body);
      root.append(wrap);
      scrollToEnd();
    },

    // A pause for the user: render Approve/Decline; the first click reports and disables both.
    // `id` is the confirm's own — the background ignores an answer for any other.
    addConfirm(text, onApprove, onDecline, id) {
      const wrap = document.createElement("div");
      wrap.className = "agent-step agent-confirm";
      const body = document.createElement("div");
      body.className = "agent-text";
      body.textContent = text || "";
      const actions = document.createElement("div");
      actions.className = "agent-confirm-actions";
      const answer = (fn) => () => {
        actions.querySelectorAll("button").forEach((b) => (b.disabled = true));
        fn();
      };
      const yes = document.createElement("button");
      yes.textContent = "Approve";
      yes.addEventListener("click", answer(onApprove));
      const no = document.createElement("button");
      no.textContent = "Decline";
      no.addEventListener("click", answer(onDecline));
      const status = document.createElement("span");
      status.className = "agent-confirm-status";
      actions.append(yes, no, status);
      wrap.append(body, actions);
      root.append(wrap);
      if (id != null) confirms.set(id, { buttons: [yes, no], status });
      scrollToEnd();
    },

    // The background settled a confirm — answered here or in another window, or the run
    // stopped. Its card (every copy, in every sidebar) goes inert; id null = every open card.
    closeConfirm(id, approved) {
      for (const [key, c] of confirms) {
        if (id != null && key !== id) continue;
        for (const b of c.buttons) b.disabled = true;
        c.status.textContent = approved === true ? "approved" : approved === false ? "declined" : "no longer waiting — the task ended";
        confirms.delete(key);
      }
    },
  };
}
