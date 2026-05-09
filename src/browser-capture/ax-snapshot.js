/**
 * Accessibility tree snapshot via chrome.automation.
 *
 * Returns a map of { "id:<elementId>" | "name:<elementName>" → accessible name }
 * for every form control found in the tab's accessibility tree.
 *
 * The .name property on each AutomationNode is the browser's computed accessible
 * name — the same value Playwright's browser_snapshot returns and what screen
 * readers announce. It is authoritative and handles all ARIA labelling patterns
 * (aria-labelledby, aria-label, <label for>, placeholder, title, wrapped label)
 * without any manual DOM traversal.
 *
 * @param {number} tabId
 * @returns {Promise<Map<string, string>>}
 */
export function getAxFieldMap(tabId) {
  return new Promise((resolve) => {
    try {
      chrome.automation.getTree(tabId, (rootNode) => {
        if (chrome.runtime.lastError || !rootNode) {
          resolve(new Map());
          return;
        }

        const map = new Map();

        // Roles that correspond to form controls we fill
        const FIELD_ROLES = new Set([
          "textField",
          "searchBox",
          "comboBox",
          "listBox",
          "checkBox",
          "radioButton",
          "radioGroup",
          "slider",
          "spinButton",
          "textArea",
          "date",
          "dateTime"
        ]);

        function walk(node) {
          if (!node) return;

          if (FIELD_ROLES.has(node.role) && node.name) {
            const id = node.htmlAttributes?.id;
            const name = node.htmlAttributes?.name;
            if (id) map.set(`id:${id}`, node.name);
            if (name) map.set(`name:${name}`, node.name);
          }

          // Recurse through children
          let child = node.firstChild;
          while (child) {
            walk(child);
            child = child.nextSibling;
          }
        }

        walk(rootNode);
        resolve(map);
      });
    } catch {
      resolve(new Map());
    }
  });
}
