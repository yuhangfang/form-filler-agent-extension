/**
 * @file DOM → YAML aria snapshot. Layout follows refs/playwright/packages/injected/src/ariaSnapshot.ts:
 * generateAriaTree (visibility, include rules, child order) + renderAriaTree (keys, refs, boxes, cursor propagation).
 *
 * Exposes NS.createBuildAriaYamlSnapshot(deps) — browser-tools.js supplies ref map + highlight hooks.
 */
(function initAriaSnapshotTree(globalObj) {
  const A = globalObj.__formFillerAriaSnapshot;
  if (!A || typeof A.getAriaRole !== "function" || typeof A.yamlQuotedName !== "function") {
    throw new Error("aria-snapshot: load accname + yaml-utils before aria-snapshot.js");
  }

  /**
   * @param {{
   *   allocRef: (el: Element) => string,
   *   resetRefState: () => void,
   *   clearAriaSnapshotHighlights: () => void,
   *   applyAriaSnapshotHighlights: () => void
   * }} deps
   */
  A.createBuildAriaYamlSnapshot = function createBuildAriaYamlSnapshot(deps) {
    const { allocRef, resetRefState, clearAriaSnapshotHighlights, applyAriaSnapshotHighlights } = deps;

    /** @param {string | null} r */
    function widgetKidRole(r) {
      return (
        !!r &&
        [
          "button",
          "link",
          "textbox",
          "searchbox",
          "checkbox",
          "radio",
          "combobox",
          "listbox",
          "slider",
          "spinbutton",
          "switch",
          "option",
          "tab",
          "progressbar",
          "meter"
        ].includes(r)
      );
    }

    /**
     * Material / custom selects: dropdown arrow in open shadow roots (sibling parity with Playwright AX).
     * @param {Element} comboRoot
     * @returns {Element[]}
     */
    function collectOpenShadowComboTriggerButtons(comboRoot) {
      /** @type {Element[]} */
      const found = [];
      /** @param {Element} n @param {number} d */
      function walk(n, d) {
        if (d > 24 || !(n instanceof Element) || A.subtreeBlocked(n)) return;
        if (n.tagName === "BUTTON") {
          if (/** @type {HTMLButtonElement} */ (n).disabled) return;
          const br = A.getAriaRole(n);
          if (br === "button" && includeElement(n, "button")) found.push(n);
        } else if (n.getAttribute?.("role") === "button" && includeElement(n, "button")) {
          found.push(n);
        } else if (
          n instanceof HTMLInputElement &&
          ["button", "submit", "reset", "image"].includes((n.type || "").toLowerCase()) &&
          includeElement(n, "button")
        ) {
          found.push(n);
        }
        const sr = /** @type {HTMLElement} */ (n).shadowRoot;
        if (sr) {
          for (const c of sr.children) {
            if (c instanceof Element) walk(c, d + 1);
          }
        }
        for (const c of n.children) {
          if (c instanceof Element) walk(c, d + 1);
        }
      }
      walk(comboRoot, 0);
      const seen = new Set();
      const out = [];
      for (const b of found) {
        if (seen.has(b)) continue;
        seen.add(b);
        out.push(b);
      }
      return out;
    }

    /** @param {Element} comboHost */
    function siblingComboTriggerButtons(comboHost) {
      const p = comboHost.parentElement;
      if (!p) return [];
      /** @type {Element[]} */
      const out = [];
      for (const c of p.children) {
        if (!(c instanceof Element) || c === comboHost) continue;
        const r = A.getAriaRole(c);
        if (c.tagName === "BUTTON" || r === "button") {
          if (includeElement(c, "button")) out.push(c);
        }
      }
      return out;
    }

    /** @param {Element} comboHost */
    function spatialComboTriggerButtons(comboHost) {
      const p = comboHost.parentElement;
      if (!p) return [];
      const cr = comboHost.getBoundingClientRect?.();
      if (!cr || (cr.width === 0 && cr.height === 0)) return [];
      /** @type {Element[]} */
      const out = [];
      for (const b of p.querySelectorAll("button")) {
        if (!(b instanceof HTMLButtonElement) || b === comboHost || comboHost.contains(b)) continue;
        if (!includeElement(b, "button")) continue;
        const br = b.getBoundingClientRect();
        const dx = br.left - cr.right;
        const mid = cr.top + cr.height / 2;
        const dy = Math.abs(br.top + br.height / 2 - mid);
        if (dx >= -4 && dx < 72 && dy < 40) out.push(b);
      }
      return out;
    }

    /** @param {Element} comboHost */
    function pointProbeComboTrigger(comboHost) {
      const r = comboHost.getBoundingClientRect?.();
      if (!r || r.width < 2) return null;
      const w = window.innerWidth || 1920;
      const h = window.innerHeight || 1080;
      const pts = [
        [Math.min(r.right + 2, w - 1), r.top + r.height * 0.35],
        [Math.min(r.right + 2, w - 1), r.top + r.height * 0.65],
        [Math.min(r.right + 8, w - 1), r.top + r.height * 0.5],
        [Math.min(r.right + 16, w - 1), r.top + r.height * 0.5]
      ];
      for (const [cx, cy] of pts) {
        if (cy < 1 || cy >= h - 1) continue;
        let stack;
        try {
          stack = document.elementsFromPoint(cx, cy);
        } catch {
          continue;
        }
        if (!stack) continue;
        for (const n of stack) {
          if (!(n instanceof Element) || n === comboHost || comboHost.contains(n)) continue;
          const tg = n.tagName;
          const rr = A.getAriaRole(n);
          if (tg === "BUTTON" && includeElement(n, "button")) return n;
          if (rr === "button" && includeElement(n, "button")) return n;
          if (
            n instanceof HTMLInputElement &&
            ["button", "submit", "reset", "image"].includes((n.type || "").toLowerCase()) &&
            includeElement(n, "button")
          ) {
            return n;
          }
        }
      }
      return null;
    }

    /** @param {Element} parent */
    function snapshotOrderedChildNodes(parent) {
      const merged = A.getMergedChildNodes(parent);
      /** @type {Node[]} */
      const out = [];
      const direct = new Set(
        merged.filter((n) => n.nodeType === Node.ELEMENT_NODE).map((n) => /** @type {Element} */ (n))
      );
      for (const n of merged) {
        out.push(n);
        if (n.nodeType !== Node.ELEMENT_NODE) continue;
        const elc = /** @type {Element} */ (n);
        if (A.getAriaRole(elc) !== "combobox") continue;
        for (const b of collectOpenShadowComboTriggerButtons(elc)) {
          if (direct.has(b) || elc === b) continue;
          if (merged.includes(b)) continue;
          out.push(b);
        }
        for (const b of siblingComboTriggerButtons(elc)) {
          if (direct.has(b) || elc === b) continue;
          if (merged.includes(b) || out.includes(b)) continue;
          out.push(b);
        }
        for (const b of spatialComboTriggerButtons(elc)) {
          if (direct.has(b) || elc === b) continue;
          if (merged.includes(b) || out.includes(b)) continue;
          out.push(b);
        }
        const probed = pointProbeComboTrigger(elc);
        if (
          probed &&
          !direct.has(probed) &&
          probed !== elc &&
          !merged.includes(probed) &&
          !out.includes(probed)
        ) {
          out.push(probed);
        }
      }
      return out;
    }

    /** @param {Element} el */
    function isInsideListItem(el) {
      let p = el.parentElement;
      while (p) {
        if (p.tagName === "LI" || p.getAttribute?.("role") === "listitem") return true;
        if (A.getAriaRole(p) === "listitem") return true;
        p = p.parentElement;
      }
      return false;
    }

    /** @param {Element} root */
    function subtreeButtonCount(root) {
      let n = 0;
      /** @param {Element} x */
      function w(x) {
        if (!(x instanceof Element) || A.subtreeBlocked(x)) return;
        if (x.tagName === "BUTTON") n++;
        const sr = /** @type {HTMLElement} */ (x).shadowRoot;
        if (sr) {
          for (const c of sr.children) {
            if (c instanceof Element) w(c);
          }
        }
        for (const c of x.children) {
          if (c instanceof Element) w(c);
        }
      }
      w(root);
      return n;
    }

    function includeUnnamedGeneric(el) {
      if (!A.isProbablyVisible(el)) return false;
      const elems = A.getElementChildren(el);
      const dt = A.directTextsJoined(el);
      if (elems.length === 0) return !!dt;
      if (dt && !/^[*✱]+$/.test(dt)) return true;
      if (elems.length === 1) {
        const cr = A.getAriaRole(elems[0]);
        if ((cr === "button" || cr === "link") && !dt) {
          const inListItem = isInsideListItem(el);
          if (!A.isClickSurface(el) || inListItem) return false;
        }
      }
      if (A.isClickSurface(el)) return true;
      for (const ch of elems) {
        if (widgetKidRole(A.getAriaRole(ch))) return true;
      }
      return false;
    }

    /** @param {Element} el */
    function hoistAnonymousGeneric(el) {
      let cur = el;
      let guard = 0;
      while (guard++ < 100) {
        if (A.subtreeBlocked(cur)) break;
        const role = A.getAriaRole(cur);
        const nm = A.normalizeWhiteSpace(A.accessibleName(cur) || "");
        const dt = A.directTextsJoined(cur);
        const kids = A.getElementChildren(cur);
        if (role !== "generic") break;
        if (nm) break;
        if (dt) break;
        if (kids.length !== 1) break;
        cur = kids[0];
      }
      return cur;
    }

    /**
     * Whether to emit a YAML line (AI mode ≈ Playwright visibility: ariaOrVisible + tree rules).
     * @param {Element} el
     * @param {string} role
     */
    function includeElement(el, role) {
      const interactable =
        role &&
        [
          "button",
          "link",
          "textbox",
          "searchbox",
          "checkbox",
          "radio",
          "combobox",
          "listbox",
          "slider",
          "spinbutton",
          "switch",
          "option",
          "tab",
          "menuitem",
          "menuitemcheckbox",
          "menuitemradio",
          "treeitem",
          "gridcell",
          "cell",
          "columnheader",
          "rowheader"
        ].includes(role);

      if (role === "option" && el.closest?.("select")) return true;
      if (interactable) {
        if (role === "button" && A.isLayoutRelevant(el)) return true;
        return A.isProbablyVisible(el) || role === "option";
      }
      if (role === "generic") {
        const nm = A.normalizeWhiteSpace(A.accessibleName(el) || "");
        if (!nm) return includeUnnamedGeneric(el);
        if (isInsideListItem(el)) {
          if (el.querySelector?.('[role="combobox"], select')) {
            /* keep wrapper around custom selects */
          } else if (subtreeButtonCount(el) === 1) {
            return false;
          }
        }
      }
      return A.isProbablyVisible(el);
    }

    function headingLevel(el) {
      const ar = el.getAttribute?.("aria-level");
      if (ar && /^\d+$/.test(ar)) return Number(ar);
      const m = /^H([1-6])$/i.exec(el.tagName || "");
      return m ? Number(m[1]) : undefined;
    }

    /** @returns {boolean} */
    function shouldAssignRef(role, el) {
      if (!role || role === "presentation" || role === "none") return false;
      const interactive =
        [
          "button",
          "link",
          "textbox",
          "searchbox",
          "checkbox",
          "radio",
          "combobox",
          "listbox",
          "slider",
          "spinbutton",
          "switch",
          "option",
          "tab",
          "menuitem",
          "menuitemcheckbox",
          "menuitemradio",
          "treeitem",
          "gridcell",
          "cell",
          "scrollbar",
          "progressbar",
          "meter"
        ].includes(role) ||
        el.getAttribute?.("tabindex") === "0" ||
        (el.getAttribute?.("tabindex") != null && !Number.isNaN(Number(el.getAttribute("tabindex"))));

      const name = A.accessibleName(el);
      if (interactive) return true;
      if (["list", "listitem", "group", "status", "note", "img", "paragraph"].includes(role)) return true;
      if (
        ["main", "navigation", "banner", "contentinfo", "complementary"].includes(role) &&
        A.isProbablyVisible(el)
      ) {
        return true;
      }
      if (role === "heading" && A.isProbablyVisible(el)) return true;
      if (name && ["navigation", "region", "form", "dialog", "article", "main"].includes(role)) return true;
      if (role === "generic") {
        const nm = A.normalizeWhiteSpace(name || "");
        if (nm) return true;
        const elems = A.getElementChildren(el);
        const dt = A.directTextsJoined(el);
        if (elems.length === 0 && dt) return true;
        for (const ch of elems) {
          if (widgetKidRole(A.getAriaRole(ch))) return true;
        }
        if (A.isClickSurface(el)) return true;
        return false;
      }
      return false;
    }

    /** @param {Element} el */
    function valueSuffixLines(el, indent) {
      /** @type {string[]} */
      const out = [];
      function optionTextsFromElements(elements) {
        const seen = new Set();
        const values = [];
        for (const option of elements) {
          const text = A.normalizeWhiteSpace(option.textContent || option.getAttribute?.("aria-label") || "");
          const value = option.getAttribute?.("value") || option.getAttribute?.("data-value") || "";
          const label = text || value;
          if (!label) continue;
          const key = label.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          values.push(label);
          if (values.length >= 120) break;
        }
        return values;
      }

      function pushOptionsLines(options) {
        const clean = (Array.isArray(options) ? options : []).map((x) => A.normalizeWhiteSpace(String(x || ""))).filter(Boolean);
        if (!clean.length) return;
        out.push(`${indent}  - /options:`);
        for (const option of clean) {
          out.push(`${indent}    - ${A.yamlQuotedName(option)}`);
        }
      }

      function controlledOptionCount(el0) {
        const ids = `${el0.getAttribute?.("aria-controls") || ""} ${el0.getAttribute?.("aria-owns") || ""}`
          .split(/\s+/)
          .map((id) => id.trim())
          .filter(Boolean);
        let count = 0;
        for (const id of ids) {
          const root = el0.getRootNode() instanceof Document || el0.getRootNode() instanceof ShadowRoot
            ? /** @type {Document|ShadowRoot} */ (el0.getRootNode())
            : document;
          const list = root.getElementById?.(id);
          if (list instanceof Element) {
            count += list.querySelectorAll('[role="option"], option, li, [data-value]').length;
          }
        }
        return count;
      }

      function expansionHint(el0) {
        const role = A.getAriaRole(el0);
        const isNativeSelect = el0 instanceof HTMLSelectElement;
        const isDropdownish =
          role === "combobox" ||
          role === "listbox" ||
          el0.getAttribute?.("aria-haspopup") === "listbox" ||
          el0.getAttribute?.("aria-haspopup") === "menu" ||
          el0.hasAttribute?.("aria-controls") ||
          el0.hasAttribute?.("aria-owns");
        if (!isDropdownish || isNativeSelect) return null;
        const expanded = el0.getAttribute?.("aria-expanded");
        const controls = `${el0.getAttribute?.("aria-controls") || ""} ${el0.getAttribute?.("aria-owns") || ""}`.trim();
        const optionCount = controlledOptionCount(el0);
        if (expanded === "true" && optionCount > 0) return null;
        const reasons = [];
        if (expanded === "false" || expanded == null) reasons.push(`aria-expanded=${expanded ?? "missing"}`);
        if (!controls) reasons.push("no aria-controls/owns");
        if (optionCount === 0) reasons.push("no mounted options");
        return {
          needsExpansion: true,
          reason: reasons.join("; ") || "custom dropdown options may mount only after opening"
        };
      }

      const hint = expansionHint(el);
      if (hint?.needsExpansion) {
        out.push(`${indent}  - /needs-expansion: true`);
        out.push(`${indent}  - /expansion-reason: ${A.yamlQuotedName(hint.reason)}`);
      }

      if (el instanceof HTMLInputElement) {
        const t = (el.type || "").toLowerCase();
        if (!["checkbox", "radio", "file", "hidden", "button", "submit", "reset", "image"].includes(t)) {
          if (el.hasAttribute("placeholder")) {
            const ph = el.getAttribute("placeholder") ?? "";
            const an = A.normalizeWhiteSpace(A.accessibleName(el) || "");
            const phn = A.normalizeWhiteSpace(ph);
            const skipDup =
              A.getAriaRole(el) === "combobox" &&
              phn &&
              an &&
              phn.toLowerCase() === an.toLowerCase();
            if (!skipDup) {
              out.push(`${indent}  - /placeholder: ${ph === "" ? '""' : A.yamlQuotedName(ph)}`);
            }
          }
          const v = el.value ?? "";
          const shown = v.length > 200 ? `${v.slice(0, 200)}…` : v;
          if (A.normalizeWhiteSpace(shown)) out.push(`${indent}  - ${A.yamlQuotedName(shown)}`);
          const datalist = A.resolvedListElement(el);
          if (datalist instanceof HTMLDataListElement) {
            pushOptionsLines(optionTextsFromElements(Array.from(datalist.querySelectorAll("option"))));
          }
          const ownedIds = `${el.getAttribute("aria-controls") || ""} ${el.getAttribute("aria-owns") || ""}`
            .split(/\s+/)
            .map((id) => id.trim())
            .filter(Boolean);
          for (const id of ownedIds) {
            const ownerRoot = el.getRootNode() instanceof Document || el.getRootNode() instanceof ShadowRoot
              ? /** @type {Document|ShadowRoot} */ (el.getRootNode())
              : document;
            const list = ownerRoot.getElementById?.(id);
            if (list instanceof Element) {
              pushOptionsLines(optionTextsFromElements(Array.from(list.querySelectorAll('[role="option"], option, li, [data-value]'))));
            }
          }
        }
      } else if (el instanceof HTMLTextAreaElement) {
        if (el.hasAttribute("placeholder")) {
          const ph = el.getAttribute("placeholder") ?? "";
          out.push(`${indent}  - /placeholder: ${ph === "" ? '""' : A.yamlQuotedName(ph)}`);
        }
        const v = el.value ?? "";
        const shown = v.length > 200 ? `${v.slice(0, 200)}…` : v;
        if (A.normalizeWhiteSpace(shown)) out.push(`${indent}  - ${A.yamlQuotedName(shown)}`);
      } else if (el instanceof HTMLSelectElement) {
        pushOptionsLines(optionTextsFromElements(Array.from(el.options)));
      }
      return out;
    }

    /** @param {string} href */
    function formatUrlSnapshotLine(href) {
      const h = String(href || "");
      if (!h) return '""';
      if (/^[\w\-./:?#=&%+]+$/.test(h)) return h;
      return A.yamlQuotedName(h);
    }

    /**
     * @param {Element | Document} root
     * @param {{ depth?: number, boxes?: boolean, highlightRefs?: boolean }} opts
     * @returns {{ lines: string[], yaml: string }}
     */
    function buildAriaYamlSnapshot(root, opts = {}) {
      resetRefState();
      clearAriaSnapshotHighlights();
      const maxDepth = opts.depth !== undefined ? Number(opts.depth) : Infinity;
      const highlightRefs = !!opts.highlightRefs;
      const boxes = highlightRefs || !!opts.boxes;

      /** @type {string[]} */
      const lines = [];
      const visitedInSnapshotWalk = new WeakSet();

      /**
       * @param {Element} el
       * @param {number} depth
       * @param {string} indent
       * @param {boolean} renderCursorPointer
       */
      function visit(el, depth, indent, renderCursorPointer = true) {
        if (depth > maxDepth || !el) return;
        if (A.subtreeBlocked(el)) return;

        el = hoistAnonymousGeneric(el);
        if (A.subtreeBlocked(el)) return;
        if (visitedInSnapshotWalk.has(el)) return;
        visitedInSnapshotWalk.add(el);

        const role = A.getAriaRole(el);
        let emit = !!(role && includeElement(el, role));
        if (emit && role === "generic" && isInsideListItem(el)) {
          if (!el.querySelector?.('[role="combobox"], select') && subtreeButtonCount(el) === 1) {
            emit = false;
          }
        }
        const childIndent = emit ? `${indent}  ` : indent;

        const elems = A.getElementChildren(el);
        const inlineText = A.directTextsJoined(el);
        const textOnlyNoElements = elems.length === 0 && !!inlineText;
        const inlineTextSuffixRoles = new Set(["listitem", "paragraph", "generic", "heading"]);

        /**
         * @param {string} role0
         * @param {boolean} renderCursorPointer0
         */
        function roleLineSuffixes(role0, el0, name0, renderCursorPointer0) {
          let refAttr = "";
          let extra = "";
          const hl = headingLevel(el0);
          const snapBox = A.computeSnapshotBox(el0);
          const refOk =
            shouldAssignRef(role0, el0) &&
            snapBox.visible &&
            A.elementReceivesPointerEvents(el0);
          let suppressChildCursor = false;
          if (refOk) {
            const rid = allocRef(el0);
            refAttr = ` [ref=${rid}]`;
            const pointerCursor = snapBox.cursor === "pointer";
            if (renderCursorPointer0 && pointerCursor) {
              extra += " [cursor=pointer]";
              suppressChildCursor = true;
            }
          }
          let boxStr = "";
          if (boxes) {
            const r = el0.getBoundingClientRect();
            boxStr = ` [box=${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)}]`;
          }
          let headingSuffix = "";
          if (role0 === "heading" && hl) headingSuffix = ` [level=${hl}]`;
          let stateSuffix = "";
          if (role0 === "checkbox" || role0 === "radio" || role0 === "switch") {
            if (el0 instanceof HTMLInputElement && "checked" in el0) {
              if (el0.checked) stateSuffix += " [checked]";
            } else if (el0.getAttribute("aria-checked") === "true") {
              stateSuffix += " [checked]";
            }
          }
          if (el0.getAttribute("aria-expanded") === "true") {
            stateSuffix += " [expanded]";
          }
          if (el0.hasAttribute("disabled") || el0.getAttribute("aria-disabled") === "true") {
            stateSuffix += " [disabled]";
          }
          const namePart = name0 ? ` ${A.yamlQuotedName(name0)}` : "";
          const active = document.activeElement === el0 ? " [active]" : "";
          return { refAttr, extra, boxStr, headingSuffix, stateSuffix, namePart, active, suppressChildCursor };
        }

        function pushLinkAndValueLines() {
          if (role === "link" && el instanceof HTMLAnchorElement) {
            const href = el.getAttribute("href");
            if (href != null && href !== "") {
              lines.push(`${childIndent}- /url: ${formatUrlSnapshotLine(href)}`);
            }
          }
          const valLines = valueSuffixLines(el, indent);
          for (const vl of valLines) lines.push(vl);
        }

        /** @type {{ suppressChildCursor: boolean } | null} */
        let emittedSuffix = null;

        if (emit && textOnlyNoElements && inlineTextSuffixRoles.has(role)) {
          const name = A.accessibleName(el);
          if (!(role === "heading" && name)) {
            const suf = roleLineSuffixes(role, el, name, renderCursorPointer);
            lines.push(
              `${indent}- ${role}${suf.namePart}${suf.active}${suf.refAttr}${suf.extra}${suf.boxStr}${suf.headingSuffix}${suf.stateSuffix}: ${A.yamlInlineSnapshotChunk(inlineText)}`
            );
            pushLinkAndValueLines();
            return;
          }
        }

        if (emit) {
          const name = A.accessibleName(el);
          const suf = roleLineSuffixes(role, el, name, renderCursorPointer);
          emittedSuffix = suf;
          lines.push(
            `${indent}- ${role}${suf.namePart}${suf.active}${suf.refAttr}${suf.extra}${suf.boxStr}${suf.headingSuffix}${suf.stateSuffix}:`
          );
          pushLinkAndValueLines();
        }

        const childRenderCursor =
          emittedSuffix != null ? renderCursorPointer && !emittedSuffix.suppressChildCursor : renderCursorPointer;

        for (const n of snapshotOrderedChildNodes(el)) {
          if (n.nodeType === Node.TEXT_NODE) {
            const t = A.normalizeWhiteSpace(n.nodeValue || "");
            if (!t) continue;
            lines.push(`${childIndent}- text: ${A.yamlQuotedName(t)}`);
          } else if (n.nodeType === Node.ELEMENT_NODE) {
            const ch = /** @type {Element} */ (n);
            if (["SCRIPT", "STYLE", "NOSCRIPT", "META", "LINK", "TEMPLATE"].includes(ch.tagName)) continue;
            visit(ch, depth + 1, childIndent, childRenderCursor);
          }
        }
      }

      const start =
        root instanceof Document ? root.body || root.documentElement : /** @type {Element} */ (root);
      if (!start) return { lines: [], yaml: "" };

      const useSyntheticDocumentRoot =
        (root instanceof Document && start.tagName === "BODY") ||
        (root instanceof Element && start.tagName === "BODY");

      if (useSyntheticDocumentRoot) {
        const active =
          document.activeElement &&
          (start === document.activeElement || start.contains(document.activeElement))
            ? " [active]"
            : "";
        const bodyBox = A.computeSnapshotBox(start);
        const bodyRefOk = bodyBox.visible && A.elementReceivesPointerEvents(start);
        let rootLine = `- generic${active}`;
        let rootChildCursor = true;
        if (bodyRefOk) {
          const rid = allocRef(start);
          rootLine += ` [ref=${rid}]`;
          if (bodyBox.cursor === "pointer") {
            rootLine += " [cursor=pointer]";
            rootChildCursor = false;
          }
        }
        rootLine += ":";
        lines.push(rootLine);
        for (const ch of A.getElementChildren(start)) visit(ch, 0, "  ", rootChildCursor);
      } else {
        visit(start, 0, "", true);
      }
      const yaml = lines.join("\n");
      if (highlightRefs) applyAriaSnapshotHighlights();
      return { lines, yaml };
    }

    return buildAriaYamlSnapshot;
  };
})(typeof globalThis !== "undefined" ? globalThis : typeof self !== "undefined" ? self : window);
