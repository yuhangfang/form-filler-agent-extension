/**
 * @file DOM visibility / geometry aligned with refs/playwright/packages/injected/src/domUtils.ts
 * (computeBox, isElementVisible patterns) and pointer-events walk (roleUtils.receivesPointerEvents).
 */
(function initAriaSnapshotDomUtils(globalObj) {
  const NS = globalObj.__formFillerAriaSnapshot;
  if (!NS || typeof NS.normalizeWhiteSpace !== "function") {
    throw new Error("aria-snapshot: load string-utils before dom-utils");
  }

  /** @param {Element} el */
  NS.subtreeBlocked = function subtreeBlocked(el) {
    if (["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "META", "LINK"].includes(el.tagName)) return true;
    if (el instanceof HTMLInputElement && el.type === "hidden") return true;
    let n = el;
    while (n && n.nodeType === Node.ELEMENT_NODE) {
      if (n.getAttribute?.("aria-hidden") === "true") return true;
      const st = window.getComputedStyle(n);
      if (st.display === "none" || st.visibility === "hidden") return true;
      n =
        n.parentElement ||
        (n.parentNode instanceof ShadowRoot ? /** @type {ShadowRoot} */ (n.parentNode).host : null);
    }
    return false;
  };

  /** @param {Element} el */
  NS.getMergedChildNodes = function getMergedChildNodes(el) {
    const slot = /** @type {HTMLElement} */ (el).shadowRoot;
    return slot ? [...el.childNodes, ...slot.childNodes] : [...el.childNodes];
  };

  /** @param {Element} el */
  NS.getElementChildren = function getElementChildren(el) {
    return NS.getMergedChildNodes(el)
      .filter((n) => {
        if (n.nodeType !== Node.ELEMENT_NODE) return false;
        const ch = /** @type {Element} */ (n);
        return !["SCRIPT", "STYLE", "NOSCRIPT", "META", "LINK"].includes(ch.tagName);
      })
      .map((n) => /** @type {Element} */ (n));
  };

  /** @param {Element} el */
  NS.directTextsJoined = function directTextsJoined(el) {
    const parts = [];
    for (const n of NS.getMergedChildNodes(el)) {
      if (n.nodeType !== Node.TEXT_NODE) continue;
      const t = NS.normalizeWhiteSpace(n.nodeValue || "");
      if (t) parts.push(t);
    }
    return NS.normalizeWhiteSpace(parts.join(" "));
  };

  /** @param {Element | null | undefined} element */
  NS.parentElementOrShadowHostLite = function parentElementOrShadowHostLite(element) {
    if (!element) return null;
    if (element.parentElement) return element.parentElement;
    const root = element.parentNode;
    if (root && root.nodeType === 11 && /** @type {ShadowRoot} */ (root).host) {
      return /** @type {ShadowRoot} */ (root).host;
    }
    return null;
  };

  /** @param {Node} node */
  NS.isVisibleTextNodeLite = function isVisibleTextNodeLite(node) {
    if (!node || node.nodeType !== Node.TEXT_NODE) return false;
    try {
      const range = node.ownerDocument.createRange();
      range.selectNode(node);
      const rect = range.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    } catch {
      return false;
    }
  };

  /** @param {Element} el */
  NS.isProbablyVisible = function isProbablyVisible(el) {
    if (!(el instanceof Element)) return false;
    const st = window.getComputedStyle(el);
    if (st.visibility === "hidden" || st.display === "none") return false;
    const r = el.getBoundingClientRect?.();
    const tag = el.tagName;
    const zero =
      !r ||
      ((r.width === 0 || r.height === 0) &&
        !["INPUT", "TEXTAREA", "SELECT", "OPTION", "BUTTON"].includes(tag));
    if (zero && tag !== "INPUT" && tag !== "BUTTON") return false;
    return true;
  };

  /** @param {Element} el */
  NS.isLayoutRelevant = function isLayoutRelevant(el) {
    if (!(el instanceof Element)) return false;
    const st = window.getComputedStyle(el);
    return st.display !== "none" && st.visibility !== "hidden" && st.visibility !== "collapse";
  };

  /**
   * Port of injected computeBox (refs/playwright/packages/injected/src/domUtils.ts).
   * @param {Element} el
   * @returns {{ visible: boolean, inline: boolean, cursor?: string }}
   */
  NS.computeSnapshotBox = function computeSnapshotBox(el) {
    if (!(el instanceof Element) || NS.subtreeBlocked(el)) return { visible: false, inline: false };
    const style = window.getComputedStyle(el);
    if (!style) return { visible: true, inline: false };
    const cursor = style.cursor || undefined;
    if (style.display === "contents") {
      for (let child = el.firstChild; child; child = child.nextSibling) {
        if (child.nodeType === 1 && NS.isProbablyVisible(/** @type {Element} */ (child))) {
          return { visible: true, inline: false, cursor };
        }
        if (child.nodeType === 3 && NS.isVisibleTextNodeLite(/** @type {Text} */ (child))) {
          return { visible: true, inline: true, cursor };
        }
      }
      return { visible: false, inline: false, cursor };
    }
    if (style.visibility !== "visible") return { visible: false, inline: false, cursor };
    try {
      if (typeof Element !== "undefined" && Element.prototype.checkVisibility && !el.checkVisibility()) {
        return { visible: false, inline: false, cursor };
      }
    } catch {
      /* ignore */
    }
    const rect = el.getBoundingClientRect();
    const inline = style.display === "inline";
    const visible = rect.width > 0 && rect.height > 0;
    return { visible, inline, cursor };
  };

  /** @param {Element} el */
  NS.elementReceivesPointerEvents = function elementReceivesPointerEvents(el) {
    let e = el;
    while (e && e.nodeType === Node.ELEMENT_NODE) {
      try {
        if (window.getComputedStyle(e).pointerEvents === "none") return false;
      } catch {
        return true;
      }
      e = NS.parentElementOrShadowHostLite(e);
    }
    return true;
  };

  /** @param {Element} el */
  NS.isClickSurface = function isClickSurface(el) {
    if (!(el instanceof Element)) return false;
    try {
      if (el.matches?.("[onclick], [role='button'], [cursor='pointer'], [cursor=pointer]")) return true;
      if (el.getAttribute?.("tabindex") === "0") return true;
      const st = window.getComputedStyle(el);
      if (
        st.cursor === "pointer" &&
        el.querySelector?.(':scope [role="combobox"], :scope select, :scope input:not([type="hidden"])')
      ) {
        return true;
      }
    } catch {
      /* ignore */
    }
    return false;
  };
})(typeof globalThis !== "undefined" ? globalThis : typeof self !== "undefined" ? self : window);
