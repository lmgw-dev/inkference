// Text cleanup for "Read aloud". Web text carries a lot of marks that mean something to the
// eye and nothing to the ear — reference numbers ([23]), "[citation needed]", markdown
// asterisks, raw URLs, emoji. A TTS model dutifully pronounces all of it ("bracket twenty
// three"), so the text is scrubbed before it is synthesized.
//
// This is deliberately PROGRAMMATIC, not a model pass: it is instant, predictable, and
// reversible (the reader panel keeps the original and re-derives on every toggle). Each rule
// is separately switchable, because every one of them can be wrong about some page.
//
// Nothing here drops a sentence or truncates: rules remove marks and re-join what they broke.
// Code blocks keep their content — only the fence markers go.
//
// Pure functions with no browser dependency, so both the background (the direct menu action)
// and the sidebar panel use them, and they can be checked in plain Node.

export const CLEANUP_RULES = [
  {
    id: "hyphens",
    label: "Join hyphenated line breaks",
    hint: "“infor-\\nmation” → “information”, drops soft hyphens",
    apply: joinHyphenation,
  },
  {
    id: "markdown",
    label: "Markdown & formatting",
    hint: "**bold**, `code`, # headings, bullets, tables, [text](url) → text, stray HTML tags",
    apply: stripMarkdown,
  },
  {
    id: "citations",
    label: "Citation & footnote marks",
    hint: "[23], [12–15], [a], [iv], [^1], [citation needed], [edit]",
    apply: stripCitations,
  },
  {
    // Off by default: the same characters carry meaning in units (m², cm³, xⁿ), and there is
    // no way to tell a reference mark from an exponent — so this one is the user's call.
    id: "superscripts",
    label: "Superscript reference numbers",
    hint: "strips ¹²³ — but also the ² in “12 m²”",
    defaultOn: false,
    apply: (s) => s.replace(/[\u00B2\u00B3\u00B9\u2070\u2074-\u207F]+/g, ""),
  },
  {
    id: "urls",
    label: "URLs & e-mail addresses",
    hint: "spoken character by character otherwise",
    apply: stripUrls,
  },
  {
    id: "symbols",
    label: "Emoji & symbols",
    hint: "emoji, ★ ▪ • bullets, arrows, box drawing",
    apply: stripSymbols,
  },
];

export const DEFAULT_CLEANUP = Object.fromEntries(CLEANUP_RULES.map((r) => [r.id, r.defaultOn !== false]));

// Apply the enabled rules in the order above (line-level fixes first, so the later,
// punctuation-level ones see joined words), then tidy the wreckage.
export function cleanForSpeech(text, opts) {
  let out = String(text || "").replace(/\r\n?/g, "\n");
  const on = { ...DEFAULT_CLEANUP, ...(opts || {}) };
  for (const rule of CLEANUP_RULES) if (on[rule.id]) out = rule.apply(out);
  return tidy(out);
}

// ---- rules -----------------------------------------------------------------

function joinHyphenation(s) {
  return s
    .replace(/\u00AD/g, "") // soft hyphen
    .replace(/[\u200B-\u200D\uFEFF]/g, "") // zero-width space / joiner / BOM
    .replace(/(\w)[-\u2010\u2011]\n(\w)/g, "$1$2"); // word broken across a line
}

function stripMarkdown(s) {
  return (
    s
      // fenced code: keep the code, drop the fence lines (dropping content would be a silent cut)
      .replace(/^[ \t]*(?:```|~~~)[^\n]*$/gm, "")
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // images -> alt text
      .replace(/\[([^\]]+)\]\((?:[^)]*)\)/g, "$1") // links -> label
      .replace(/^\s{0,3}#{1,6}[ \t]+/gm, "") // ATX headings
      .replace(/^\s{0,3}>[ \t]?/gm, "") // block quotes
      .replace(/^\s*([-*+]|\d+[.)])[ \t]+/gm, "") // list bullets
      .replace(/^\s*([-*_][ \t]*){3,}$/gm, "") // horizontal rules
      .replace(/^\s*\|?[\s:|-]{3,}\|?\s*$/gm, "") // table separator rows
      .replace(/[ \t]*\|[ \t]*/g, " ") // table cell pipes
      .replace(/(\*\*|__)(.+?)\1/gs, "$2") // bold
      .replace(/(?<![\w*])[*_](?=\S)(.+?)(?<=\S)[*_](?![\w*])/gs, "$1") // italics
      .replace(/`+([^`]*)`+/g, "$1") // inline code
      .replace(/<\/?[a-z][^>\n]*>/gi, "") // stray HTML tags
      .replace(/~~(.+?)~~/gs, "$1") // strikethrough
  );
}

// Reference marks, in the bracket forms the web actually uses.
function stripCitations(s) {
  return (
    s
      .replace(/\[\s*\^?\d+(?:\s*[–—,;-]\s*\d+)*\s*\]/g, "") // [1] [1,2] [1–3] [^1]
      .replace(/\[\s*\^[\w-]+\s*\]/g, "") // [^note]
      .replace(
        /\[\s*(?:citation needed|citation-needed|edit|sic|note\s*\d*|nb\s*\d*|clarification needed|verification needed|according to whom\??|who\?|when\?|why\?|update|…|\.\.\.)\s*\]/gi,
        ""
      )
      // A single letter or a roman numeral only: "[was]" and "[big]" are words, not markers.
      .replace(/\[\s*(?:[a-z]|[ivxlcdm]{2,4})\s*\]/gi, "") // [a] [iv]
  );
}

function stripUrls(s) {
  return s
    .replace(/<?\bhttps?:\/\/[^\s<>"')\]]+>?/gi, "")
    .replace(/\bwww\.[^\s<>"')\]]+/gi, "")
    .replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, "");
}

function stripSymbols(s) {
  return s
    .replace(/[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\uFE0F\u200D]/gu, "") // emoji + modifiers
    .replace(/[\u2190-\u21FF\u2500-\u257F\u25A0-\u25FF\u2600-\u26FF\u2700-\u27BF]/g, " ") // arrows, box drawing, geometric, misc symbols, dingbats
    .replace(/[\u2022\u00B7\u25AA\u25AB\u25E6\u2023\u2043\u203B\u00A7\u00B6\u2020\u2021]/g, " "); // bullets, § ¶ † ‡
}

// ---- tidy ------------------------------------------------------------------

// Close the holes the rules leave: a removed [23] strands a space before the full stop, a
// removed URL strands empty brackets, a removed heading strands a blank line.
function tidy(s) {
  return s
    .replace(/\(\s*\)|\[\s*\]|\{\s*\}/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/ ([,.;:!?%)\]}»”’])/g, "$1")
    .replace(/([(\[{«“‘]) /g, "$1")
    .replace(/(^|\n)[ \t]+/g, "$1")
    .replace(/[ \t]+(\n|$)/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// How much the cleanup removed — shown in the panel so the user can see at a glance whether a
// rule ate more than it should have.
export function cleanupDelta(original, cleaned) {
  const a = String(original || "").replace(/\s+/g, " ").trim().length;
  const b = String(cleaned || "").replace(/\s+/g, " ").trim().length;
  return { before: a, after: b, removed: Math.max(0, a - b) };
}
