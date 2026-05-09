/**
 * @file ARIA roles (refs/playwright/packages/injected/src/roleUtils.ts — explicit + implicit subset).
 */
(function initAriaSnapshotRoleUtils(globalObj) {
  const NS = globalObj.__formFillerAriaSnapshot;
  if (!NS) throw new Error("aria-snapshot: load string-utils before role-utils");

  /** Roles Playwright recognizes as explicit (subset of ARIA 1.2). */
  NS.VALID_EXPLICIT_ROLES = new Set([
    "alert",
    "alertdialog",
    "application",
    "article",
    "banner",
    "blockquote",
    "button",
    "caption",
    "cell",
    "checkbox",
    "code",
    "columnheader",
    "combobox",
    "complementary",
    "contentinfo",
    "definition",
    "deletion",
    "dialog",
    "emphasis",
    "figure",
    "form",
    "generic",
    "grid",
    "gridcell",
    "group",
    "heading",
    "img",
    "insertion",
    "link",
    "list",
    "listbox",
    "listitem",
    "log",
    "main",
    "mark",
    "marquee",
    "math",
    "meter",
    "navigation",
    "none",
    "note",
    "option",
    "paragraph",
    "presentation",
    "progressbar",
    "radio",
    "radiogroup",
    "region",
    "row",
    "rowgroup",
    "rowheader",
    "scrollbar",
    "search",
    "searchbox",
    "separator",
    "slider",
    "spinbutton",
    "status",
    "strong",
    "subscript",
    "superscript",
    "switch",
    "tab",
    "table",
    "tablist",
    "tabpanel",
    "term",
    "textbox",
    "time",
    "timer",
    "toolbar",
    "tooltip",
    "tree",
    "treegrid",
    "treeitem",
    "iframe",
    "document",
    "legend"
  ]);

  /** @param {Element} el */
  NS.getExplicitAriaRole = function getExplicitAriaRole(el) {
    const raw = el.getAttribute?.("role");
    if (!raw) return null;
    const roles = raw.split(/\s+/).map((r) => r.trim()).filter(Boolean);
    const hit = roles.find((r) => NS.VALID_EXPLICIT_ROLES.has(r));
    return hit || null;
  };

  /** @param {HTMLInputElement} input */
  NS.resolvedListElement = function resolvedListElement(input) {
    const lid = input.getAttribute("list");
    if (!lid) return null;
    try {
      const root = input.getRootNode();
      const host = root instanceof ShadowRoot || root instanceof Document ? root : document;
      return host.querySelector(`#${CSS.escape(lid)}`);
    } catch {
      return null;
    }
  };

  /** @param {Element} el */
  NS.getImplicitAriaRole = function getImplicitAriaRole(el) {
    const tag = el.tagName;
    if (tag === "HTML" || tag === "BODY") return null;
    if (tag === "IFRAME") return "iframe";

    if (tag === "A") return el.hasAttribute("href") ? "link" : null;
    if (tag === "AREA") return el.hasAttribute("href") ? "link" : null;
    if (tag === "BUTTON") return "button";
    if (tag === "TEXTAREA") return "textbox";

    if (tag === "SELECT") {
      const sel = /** @type {HTMLSelectElement} */ (el);
      return sel.hasAttribute("multiple") || sel.size > 1 ? "listbox" : "combobox";
    }

    if (tag === "INPUT") {
      const input = /** @type {HTMLInputElement} */ (el);
      const type = (input.type || "text").toLowerCase();
      if (type === "hidden") return null;
      if (type === "search") {
        const listEl = NS.resolvedListElement(input);
        return listEl && listEl.tagName === "DATALIST" ? "combobox" : "searchbox";
      }
      if (
        ["email", "tel", "text", "url", "password", "date", "time", "datetime-local", "month", "week", ""].includes(
          type
        )
      ) {
        const listEl = NS.resolvedListElement(input);
        return listEl && listEl.tagName === "DATALIST" ? "combobox" : "textbox";
      }
      if (type === "number") return "spinbutton";
      if (type === "checkbox") return input.getAttribute("role") === "switch" ? "switch" : "checkbox";
      if (type === "radio") return "radio";
      if (type === "range") return "slider";
      if (["button", "submit", "reset", "image"].includes(type)) return "button";
      if (type === "file") return "button";
      return "textbox";
    }

    if (tag === "NAV") return "navigation";
    if (tag === "MAIN") return "main";
    if (tag === "FORM") return el.hasAttribute("aria-label") || el.hasAttribute("aria-labelledby") ? "form" : null;
    if (tag === "IMG") return "img";
    if (tag === "UL" || tag === "OL") return "list";
    if (tag === "LI") return "listitem";
    if (/^H[1-6]$/.test(tag)) return "heading";
    if (tag === "SECTION") return el.hasAttribute("aria-label") || el.hasAttribute("aria-labelledby") ? "region" : null;
    if (tag === "OPTION") return "option";
    if (tag === "PROGRESS") return "progressbar";
    if (tag === "METER") return "meter";
    if (tag === "FIELDSET") return "group";
    if (tag === "LEGEND") return "legend";
    if (tag === "DATALIST") return "listbox";
    if (tag === "P") return "paragraph";

    if (el.hasAttribute("contenteditable") && el.getAttribute("contenteditable") === "true") return "textbox";

    return "generic";
  };

  /** @param {Element} el */
  NS.getAriaRole = function getAriaRole(el) {
    const explicit = NS.getExplicitAriaRole(el);
    if (explicit) {
      if (explicit === "none" || explicit === "presentation") {
        const implicit = NS.getImplicitAriaRole(el);
        const conflict =
          el.hasAttribute("aria-label") ||
          el.hasAttribute("aria-labelledby") ||
          el.getAttribute?.("tabindex") === "0" ||
          ["BUTTON", "A", "INPUT", "SELECT", "TEXTAREA"].includes(el.tagName);
        return conflict ? implicit ?? null : null;
      }
      return explicit;
    }
    return NS.getImplicitAriaRole(el);
  };
})(typeof globalThis !== "undefined" ? globalThis : typeof self !== "undefined" ? self : window);
