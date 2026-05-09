/**
 * Ordered script chain for aria snapshot + MCP tools (content script + executeScript).
 * Keep in sync with manifest.json content_scripts[0].js.
 */
export const BROWSER_TOOLS_INJECT_CHAIN = [
  "src/browser-capture/aria-snapshot/string-utils.js",
  "src/browser-capture/aria-snapshot/yaml-utils.js",
  "src/browser-capture/aria-snapshot/dom-utils.js",
  "src/browser-capture/aria-snapshot/role-utils.js",
  "src/browser-capture/aria-snapshot/accname.js",
  "src/browser-capture/aria-snapshot/aria-snapshot.js",
  "src/browser-capture/browser-tools.js"
];
