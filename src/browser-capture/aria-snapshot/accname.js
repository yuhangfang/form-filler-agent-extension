/**
 * @file Accessible name (subset of ACCNAME / Playwright getElementAccessibleName quality).
 */
(function initAriaSnapshotAccname(globalObj) {
  const NS = globalObj.__formFillerAriaSnapshot;
  if (!NS || typeof NS.getAriaRole !== "function") {
    throw new Error("aria-snapshot: load role-utils before accname");
  }

  /** Shadow-root–aware ID lookup (Playwright getIdRefs). */
  /** @param {Element} el */
  /** @param {string | null | undefined} refAttr */
  NS.getIdRefs = function getIdRefs(el, refAttr) {
    if (!refAttr?.trim()) return [];
    const root = el.getRootNode();
    const host = root instanceof Document || root instanceof ShadowRoot ? root : document;
    const ids = refAttr.split(/\s+/).filter(Boolean);
    /** @type {Element[]} */
    const out = [];
    for (const id of ids) {
      try {
        const node = host.querySelector(`#${CSS.escape(id)}`);
        if (node) out.push(node);
      } catch {
        /* ignore */
      }
    }
    return out;
  };

  /** @param {Element} el */
  NS.accessibleName = function accessibleName(el) {
    let role = NS.getAriaRole(el) || "";
    if (!role) role = NS.getImplicitAriaRole(el) || "";
    const prohibits =
      role &&
      [
        "caption",
        "code",
        "definition",
        "deletion",
        "emphasis",
        "generic",
        "insertion",
        "mark",
        "paragraph",
        "presentation",
        "strong",
        "subscript",
        "superscript",
        "term",
        "time"
      ].includes(role);

    const labelledBy = el.getAttribute?.("aria-labelledby");
    if (labelledBy) {
      const parts = NS.getIdRefs(el, labelledBy)
        .map((n) => NS.normalizeWhiteSpace(n.innerText || n.textContent || ""))
        .filter(Boolean);
      if (parts.length) {
        let joined = NS.normalizeWhiteSpace(parts.join(" "));
        if (role === "region") {
          const h =
            el.querySelector?.(":scope h2") ||
            el.querySelector?.(':scope [role="heading"][aria-level="2"]') ||
            el.querySelector?.("h2");
          if (h instanceof Element) {
            const hh = NS.accessibleName(h);
            if (hh && (hh.includes("Form section") || hh.length > joined.length)) joined = hh;
          }
        }
        return joined;
      }
    }

    const ariaLabel = el.getAttribute?.("aria-label");
    if (ariaLabel?.trim()) {
      let al = NS.normalizeWhiteSpace(ariaLabel);
      if (role === "region") {
        const h =
          el.querySelector?.(":scope h2") ||
          el.querySelector?.(':scope [role="heading"][aria-level="2"]') ||
          el.querySelector?.("h2");
        if (h instanceof Element) {
          const hh = NS.accessibleName(h);
          if (hh && hh.includes("Form section")) al = hh;
        }
      }
      return al;
    }

    if (el.tagName === "LEGEND") {
      const lt = NS.normalizeWhiteSpace(el.innerText || "");
      if (lt) return lt;
    }

    if (el.tagName === "A") {
      const img = el.querySelector(":scope img[alt]");
      if (img?.getAttribute("alt") != null) {
        const alt = NS.normalizeWhiteSpace(img.getAttribute("alt") || "");
        if (alt) return alt;
      }
    }

    if (!prohibits) {
      if (typeof el.labels !== "undefined" && el.labels?.length) {
        const t = NS.normalizeWhiteSpace(Array.from(el.labels).map((l) => l.innerText || "").join(" "));
        if (t) return t;
      }
      const id = el.id;
      if (id) {
        try {
          const root = el.getRootNode();
          const host = root instanceof Document || root instanceof ShadowRoot ? root : document;
          const lbl = host.querySelector(`label[for="${CSS.escape(id)}"]`);
          if (lbl) {
            const t = NS.normalizeWhiteSpace(lbl.innerText || "");
            if (t) return t;
          }
        } catch {
          /* ignore */
        }
      }

      if (el.tagName === "IMG" || el.tagName === "AREA") {
        const alt = el.getAttribute?.("alt");
        if (alt != null) return NS.normalizeWhiteSpace(alt);
      }

      const isTextish =
        el instanceof HTMLInputElement &&
        !["button", "submit", "reset", "image", "checkbox", "radio", "file", "range", "hidden"].includes(
          (el.type || "").toLowerCase()
        );
      if (el instanceof HTMLTextAreaElement || isTextish) {
        const ph = el.getAttribute?.("placeholder");
        if (ph?.trim()) return NS.normalizeWhiteSpace(ph);
      }

      const title = el.getAttribute?.("title");
      if (title?.trim()) return NS.normalizeWhiteSpace(title);

      const allowFromContent =
        role &&
        [
          "button",
          "checkbox",
          "radio",
          "switch",
          "link",
          "heading",
          "menuitem",
          "option",
          "tab",
          "treeitem",
          "cell",
          "gridcell",
          "columnheader",
          "rowheader",
          "combobox",
          "listbox",
          "searchbox",
          "spinbutton",
          "textbox"
        ].includes(role);

      if (allowFromContent || ["BUTTON", "SUMMARY", "LABEL"].includes(el.tagName)) {
        const txt = NS.normalizeWhiteSpace(el.innerText || el.textContent || "");
        if (txt && txt.length <= 400) return txt.slice(0, 400);
      }
    }

    if (role === "region") {
      const h =
        el.querySelector?.(":scope h2") ||
        el.querySelector?.(':scope [role="heading"][aria-level="2"]') ||
        el.querySelector?.("h2");
      if (h instanceof Element) {
        const hn = NS.accessibleName(h);
        if (hn) return hn;
      }
    }

    return "";
  };
})(typeof globalThis !== "undefined" ? globalThis : typeof self !== "undefined" ? self : window);
