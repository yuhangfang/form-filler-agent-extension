/**
 * @file YAML helpers for aria snapshot keys (refs/playwright injected yamlEscape patterns).
 */
(function initAriaSnapshotYamlUtils(globalObj) {
  const NS = globalObj.__formFillerAriaSnapshot;
  if (!NS || typeof NS.normalizeWhiteSpace !== "function") {
    throw new Error("aria-snapshot: load string-utils.js before yaml-utils.js");
  }
  const normalizeWhiteSpace = NS.normalizeWhiteSpace;

  /**
   * Double-quoted snapshot names (Playwright MCP style).
   * @param {string} s
   */
  NS.yamlQuotedName = function yamlQuotedName(s) {
    const t = normalizeWhiteSpace(String(s ?? ""));
    if (!t) return "";
    return `"${t.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  };

  /** Same-line text after `: ` — unquoted when safe. */
  NS.yamlInlineSnapshotChunk = function yamlInlineSnapshotChunk(s) {
    const t = normalizeWhiteSpace(String(s ?? ""));
    if (!t) return '""';
    if (/[\x00-\x1f"#:|[\]{}]/.test(t)) return NS.yamlQuotedName(t);
    return t;
  };
})(typeof globalThis !== "undefined" ? globalThis : typeof self !== "undefined" ? self : window);
