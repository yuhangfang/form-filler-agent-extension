/**
 * @file Mirrors refs/playwright/packages/isomorphic/stringUtils.ts (normalizeWhiteSpace).
 * Loaded first; registers on globalThis.__formFillerAriaSnapshot.
 */
(function initAriaSnapshotStringUtils(globalObj) {
  const NS = (globalObj.__formFillerAriaSnapshot = globalObj.__formFillerAriaSnapshot || {});

  /** @param {string} s */
  NS.normalizeWhiteSpace = function normalizeWhiteSpace(s) {
    return String(s ?? "")
      .replace(/\s+/g, " ")
      .trim();
  };
})(typeof globalThis !== "undefined" ? globalThis : typeof self !== "undefined" ? self : window);
