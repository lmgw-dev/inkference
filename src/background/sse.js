// Streaming SSE line parser for OpenAI-style chat completions.
//
// ReadableStream reads do NOT align to line boundaries — a single read can contain a
// partial line, several lines, or a split multi-byte char. We keep a string buffer, emit
// only complete lines, and retain the trailing fragment for the next push. The caller
// handles `[DONE]` and JSON parsing.

export function createSSEParser() {
  let buffer = "";
  return {
    // Returns the payloads of any complete `data:` lines found in this chunk.
    push(chunk) {
      buffer += chunk;
      const out = [];
      let idx;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        let line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1); // tolerate CRLF
        if (line === "") continue; // event separator
        if (line.startsWith(":")) continue; // SSE comment / keep-alive heartbeat
        if (line.startsWith("data:")) {
          out.push(line.slice(5).replace(/^ /, "")); // single leading space per spec
        }
        // other fields (event:, id:, retry:) are not used here
      }
      return out;
    },
  };
}
