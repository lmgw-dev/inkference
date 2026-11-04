// Injected on demand via tabs.executeScript, AFTER vendor/readability.js (which sets the
// `Readability` global in this isolated content-script world). Returns a text view of the page
// to the background as the script's completion value.
//
// Two shapes, because pages come in two shapes:
//   - article: a single piece (news story, blog post, doc) → Readability's cleaned body.
//   - index:   a front/section/search/feed page that is a GRID OF HEADLINES with no single
//              article → a deduped digest of its headlines and links. Readability is built to
//              throw exactly this content away, so on a hub page it returns nothing useful;
//              the digest is what lets the model answer "which headlines mention AI?".
//
// Picking the shape — by WEIGHT, not by page-wide link density (which a real article buried in
// nav/related/footer link chrome trips just as a front page does). We compare Readability's
// article body against the total headline/link text: an article's body outweighs the headlines;
// a front page's headlines ARE the content and outweigh whatever block Readability scrapes.
// Readability.parse() MUTATES the document it is given, so we always clone first.

(() => {
  const clean = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();

  // Thresholds, surfaced rather than buried. SHORT_ARTICLE: floor for "a real article body".
  // SOME_LINKS: enough headlines to be worth listing. MAX_LINES: output backstop for pathological
  // pages — overflow is reported in the header, never dropped silently (the char weight below
  // still counts every headline, so the article/index decision is unaffected by the cap).
  const SHORT_ARTICLE = 250;
  const SOME_LINKS = 5;
  const MAX_LINES = 400;

  // The bundle exposes the index namespace as the global: { Readability, isProbablyReaderable }.
  const NS = (typeof Readability !== "undefined" && Readability) || {};
  const Ctor = typeof NS === "function" ? NS : NS.Readability || null;

  function readability() {
    if (!Ctor) return null;
    try {
      const a = new Ctor(document.cloneNode(true)).parse();
      const text = a && clean(a.textContent);
      if (text) return { title: clean(a.title) || document.title || "", text };
    } catch (_) {
      /* fall through to digest */
    }
    return null;
  }

  // Deduped headings and substantive link text in document order — the headlines a human scans
  // on a front/section/feed page. Short nav chrome ("Home", "Login") and giant blobs fall outside
  // the length window. `chars` is the total weight of ALL qualifying headlines (ignores MAX_LINES)
  // so the article/index decision sees the page's full headline mass.
  function digest() {
    const seen = new Set();
    const lines = [];
    let total = 0;
    let chars = 0;
    for (const el of document.querySelectorAll("h1, h2, h3, h4, a[href]")) {
      const t = clean(el.textContent);
      if (t.length < 12 || t.length > 300) continue;
      const key = t.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      total++;
      chars += t.length;
      if (lines.length < MAX_LINES) lines.push("- " + t);
    }
    return { lines, total, chars };
  }

  try {
    const art = readability();
    const d = digest();
    const bodyLen = art ? art.text.length : 0;

    // Article when its body outweighs the page's combined headline text; otherwise, if there is
    // a headline grid, list it. A brief article on a page with no grid still comes back as article.
    if (bodyLen >= SHORT_ARTICLE && bodyLen >= d.chars) {
      return { ok: true, mode: "article", title: art.title, text: art.text };
    }
    if (d.total >= SOME_LINKS) {
      const shown = d.total > d.lines.length ? `${d.lines.length} of ${d.total}` : String(d.total);
      const title = (art && art.title) || document.title || "";
      return { ok: true, mode: "index", count: d.total, title, text: `Headlines and links on this page (${shown}):\n` + d.lines.join("\n") };
    }
    if (bodyLen >= SHORT_ARTICLE) {
      return { ok: true, mode: "article", title: art.title, text: art.text };
    }

    // Nothing structured to lean on — hand back whatever visible text exists.
    const raw = clean(document.body && document.body.innerText);
    if (raw) return { ok: true, mode: "raw", title: document.title || "", text: raw };
    return { ok: false, reason: "no readable text on this page" };
  } catch (e) {
    return { ok: false, reason: "extraction failed: " + (clean(e && e.message) || e) };
  }
})();
