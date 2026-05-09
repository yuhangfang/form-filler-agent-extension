/**
 * General-purpose page inspection tools — injected into the page context.
 * These are stable primitives; the site agent (LLM) decides which ones to call
 * and how to interpret the results.
 *
 * Exports:
 *   global.__PAGE_TOOLS  — { toolName: fn }
 *   global.__runPageTool — (toolName, ...args) => result
 */
(function attachPageTools(global) {
  const TOOLS = {};

  /** Count and sample all standard HTML form controls. */
  TOOLS.scanStandardControls = function () {
    const inputs = Array.from(document.querySelectorAll("input")).filter((i) => {
      const t = (i.type || "text").toLowerCase();
      return !["hidden", "submit", "button", "reset", "image"].includes(t) && !i.disabled;
    });
    const selects = Array.from(document.querySelectorAll("select:not([disabled])"));
    const textareas = Array.from(document.querySelectorAll("textarea:not([disabled])"));
    const sample = [...inputs, ...selects, ...textareas].slice(0, 6).map((el) => ({
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute("type") || "",
      name: el.name || "",
      id: el.id || "",
      classes: el.className.split(" ").filter(Boolean).slice(0, 3).join(" ")
    }));
    return {
      inputCount: inputs.length,
      selectCount: selects.length,
      textareaCount: textareas.length,
      total: inputs.length + selects.length + textareas.length,
      sample
    };
  };

  /** Find elements with ARIA roles relevant to form filling. */
  TOOLS.scanAriaWidgets = function () {
    const roles = ["combobox", "listbox", "textbox", "spinbutton", "radio", "radiogroup", "checkbox", "option", "switch"];
    const counts = {};
    const samples = {};
    for (const role of roles) {
      const allEls = Array.from(document.querySelectorAll(`[role="${role}"]`))
        .filter(el => !el.closest('header, nav, [role="navigation"], [role="banner"], [role="toolbar"], [role="menubar"]'));
      if (!allEls.length) continue;
      counts[role] = allEls.length;
      const first = allEls[0];
      samples[role] = {
        tag: first.tagName.toLowerCase(),
        id: first.id || "",
        classes: first.className.split(" ").filter(Boolean).slice(0, 3).join(" "),
        ariaLabel: first.getAttribute("aria-label") || "",
        text: (first.textContent || "").trim().slice(0, 60)
      };
    }
    return { counts, samples };
  };

  /**
   * Find which data-* attributes are used heavily — helps identify
   * how the site's component system labels its fields.
   */
  TOOLS.scanDataAttributes = function () {
    const attrs = [
      "data-automation-id", "data-qa", "data-testid",
      "data-field", "data-component", "data-cy", "data-id", "data-name"
    ];
    const counts = {};
    const samples = {};
    for (const attr of attrs) {
      const els = document.querySelectorAll(`[${attr}]`);
      if (!els.length) continue;
      counts[attr] = els.length;
      samples[attr] = Array.from(els).slice(0, 6).map((el) => el.getAttribute(attr)).filter(Boolean);
    }
    return { counts, samples };
  };

  /** Detect frontend frameworks and platform-specific markers. */
  TOOLS.scanFramework = function () {
    return {
      hasReact: !!(window.__REACT_DEVTOOLS_GLOBAL_HOOK__ || document.querySelector("[data-reactroot]")),
      hasAngular: !!(document.querySelector("[ng-version], [_nghost]") || window.ng),
      hasVue: !!(window.__vue_devtools_global_hook__),
      hasDataAutomationId: document.querySelector("[data-automation-id]") !== null,
      hasSapUI5Markers: document.querySelector("[id*='sapui5'], [class*='sapUi']") !== null,
      hostname: location.hostname,
      pageTitle: document.title.slice(0, 100)
    };
  };

  /** Describe iframes present — important for ATS platforms that embed forms inside iframes. */
  TOOLS.scanIframes = function () {
    const iframes = Array.from(document.querySelectorAll("iframe"));
    return {
      count: iframes.length,
      sources: iframes.slice(0, 6).map((f) => ({
        src: (f.src || "").replace(/[?#].*$/, "").slice(0, 100),
        id: f.id || "",
        name: f.name || ""
      }))
    };
  };

  /**
   * Sample how form fields are labelled — which labelling strategies are in use.
   * Returns what works so the fill agent knows how to extract field context.
   */
  TOOLS.extractLabelSample = function () {
    const result = {};

    const labelFor = document.querySelectorAll("label[for]");
    if (labelFor.length) {
      result.labelFor = {
        count: labelFor.length,
        samples: Array.from(labelFor).slice(0, 5).map((l) => l.textContent.trim().slice(0, 60))
      };
    }

    const ariaLabel = document.querySelectorAll("[aria-label]");
    if (ariaLabel.length) {
      result.ariaLabel = {
        count: ariaLabel.length,
        samples: Array.from(ariaLabel).slice(0, 5).map((el) => el.getAttribute("aria-label").slice(0, 60))
      };
    }

    const ariaLB = document.querySelectorAll("[aria-labelledby]");
    if (ariaLB.length) result.ariaLabelledby = { count: ariaLB.length };

    const placeholders = document.querySelectorAll("[placeholder]");
    if (placeholders.length) {
      result.placeholder = {
        count: placeholders.length,
        samples: Array.from(placeholders).slice(0, 5).map((el) => el.getAttribute("placeholder").slice(0, 60))
      };
    }

    const wrapperLabels = document.querySelectorAll(
      ".form-group label, .form-field label, [class*='Field'] label, [class*='field'] label"
    );
    if (wrapperLabels.length) {
      result.wrapperLabel = {
        count: wrapperLabels.length,
        samples: Array.from(wrapperLabels).slice(0, 5).map((el) => el.textContent.trim().slice(0, 60))
      };
    }

    return result;
  };

  /** Detect shadow DOM usage — relevant when form controls are inside web components. */
  TOOLS.scanShadowDOM = function () {
    const hosts = [];
    for (const el of document.querySelectorAll("*")) {
      if (el.shadowRoot) hosts.push(el.tagName.toLowerCase());
    }
    return {
      shadowHostCount: hosts.length,
      hostTags: [...new Set(hosts)].slice(0, 10)
    };
  };

  /**
   * Probe a CSS selector — the LLM can request specific probes to verify
   * hypotheses about the page structure (e.g. "does [data-automation-id='baseTemplate'] exist?").
   * @param {string} selector
   */
  TOOLS.probeSelector = function (selector) {
    try {
      const els = document.querySelectorAll(selector);
      const first = els[0];
      return {
        count: els.length,
        found: els.length > 0,
        sample: first
          ? {
              tag: first.tagName.toLowerCase(),
              id: first.id || "",
              text: (first.textContent || "").trim().slice(0, 80),
              attrs: Object.fromEntries(
                Array.from(first.attributes || [])
                  .slice(0, 6)
                  .map((a) => [a.name, a.value.slice(0, 60)])
              )
            }
          : null
      };
    } catch (e) {
      return { count: 0, found: false, error: e.message };
    }
  };

  /**
   * Check what events a typical input reacts to (helps decide between
   * native value set vs simulated user input).
   * @param {string} selector  — selector for one input element
   */
  TOOLS.probeInputBehavior = function (selector) {
    try {
      const el = document.querySelector(selector);
      if (!el) return { found: false };
      const listeners = [];
      const orig = el.addEventListener.bind(el);
      // We can't list listeners directly, but we can check for common frameworks' attachments
      const isControlled = el.hasAttribute("data-reactroot") ||
        el.closest("[data-reactroot]") !== null ||
        typeof el._valueTracker !== "undefined"; // React
      return {
        found: true,
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute("type") || "",
        isReactControlled: isControlled,
        hasValueSetter: typeof Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set === "function"
      };
    } catch (e) {
      return { found: false, error: e.message };
    }
  };

  /**
   * Return a complete inventory of every fillable element on the page —
   * standard controls, ARIA dropdowns, radio groups, and file inputs.
   * Used by the site agent to build an accurate picture of what needs filling.
   *
   * When an application modal/dialog is open, the scan is scoped to that
   * dialog so underlying page chrome (search, nav) doesn't pollute results.
   */
  TOOLS.probeAllInteractableFields = function () {
    // Prefer scanning inside an open dialog/modal so we only see the apply form,
    // not the surrounding job listing page.
    const activeDialog = (function findActiveDialog() {
      // Explicit ARIA dialog (not hidden)
      for (const el of document.querySelectorAll('[role="dialog"], [aria-modal="true"]')) {
        if (el.getAttribute("aria-hidden") === "true") continue;
        if (el.hidden) continue;
        if (el.offsetWidth === 0 && el.offsetHeight === 0) continue;
        return el;
      }
      // Common modal class patterns as fallback
      for (const sel of ['[class*="modal" i] form', '[class*="Modal"] form', '[class*="drawer" i] form', '[class*="panel" i] form', '[class*="overlay" i] form']) {
        const formEl = document.querySelector(sel);
        if (formEl) return formEl.closest('[class*="modal" i], [class*="Modal"], [class*="drawer" i], [class*="panel" i], [class*="overlay" i]');
      }
      return null;
    })();

    const root = activeDialog || document;

    // When no modal is active, skip nav/search context elements.
    function isPageChrome(el) {
      if (activeDialog) return false; // inside the modal everything is relevant
      return !!el.closest('header, nav, [role="navigation"], [role="banner"], [role="toolbar"], [role="menubar"], [role="search"]');
    }

    function sanitizeText(raw) {
      return String(raw || "").replace(/\s+/g, " ").trim();
    }

    function getSectionPath(node) {
      const parts = [];
      const seen = new Set();
      const push = (raw) => {
        const text = sanitizeText(raw).slice(0, 80);
        if (!text) return;
        const k = text.toLowerCase();
        if (seen.has(k)) return;
        seen.add(k);
        parts.push(text);
      };
      const fieldset = node.closest("fieldset");
      if (fieldset) push(fieldset.querySelector("legend")?.textContent || fieldset.getAttribute("aria-label") || "");
      let el = node.parentElement;
      for (let depth = 0; depth < 5 && el; depth += 1, el = el.parentElement) {
        const heading = el.querySelector(":scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > legend");
        push(heading?.textContent || "");
        const lbId = el.getAttribute("aria-labelledby");
        if (lbId) {
          for (const id of lbId.split(/\s+/).filter(Boolean).slice(0, 2)) {
            push(document.getElementById(id)?.textContent || "");
          }
        }
        push(el.getAttribute("aria-label") || "");
        if (el.matches("form, section, article, main")) break;
      }
      return parts.slice(0, 3).join(" > ");
    }

    function getLabel(node) {
      const labels = [];
      const seen = new Set();
      const push = (raw) => {
        const text = sanitizeText(raw).slice(0, 120);
        if (!text) return;
        const k = text.toLowerCase();
        if (seen.has(k)) return;
        seen.add(k);
        labels.push(text);
      };
      if (node.labels?.length) {
        for (const lb of Array.from(node.labels).slice(0, 2)) push(lb.textContent || "");
      }
      if (node.id) {
        try {
          const esc = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(node.id) : node.id;
          push(document.querySelector(`label[for="${esc}"]`)?.textContent || "");
        } catch {
          // ignore invalid selector
        }
      }
      const ariaLBId = node.getAttribute("aria-labelledby");
      if (ariaLBId) {
        for (const id of ariaLBId.split(/\s+/).filter(Boolean).slice(0, 3)) {
          push(document.getElementById(id)?.textContent || "");
        }
      }
      push(node.getAttribute("aria-label") || "");
      const fieldset = node.closest("fieldset");
      if (fieldset) push(fieldset.querySelector("legend")?.textContent || "");
      if (!labels.length) {
        push(node.getAttribute("placeholder") || "");
        push(node.name || "");
        push(node.id || "");
      }
      return labels.join(" | ").slice(0, 160);
    }

    function getRoleForSnapshot(node, inputType) {
      if (node.tagName === "SELECT") return "combobox";
      if (node.tagName === "TEXTAREA") return "textbox";
      if (node.tagName === "INPUT") {
        if (inputType === "checkbox") return "checkbox";
        if (inputType === "radio") return "radio";
        if (inputType === "button" || inputType === "submit") return "button";
        return "textbox";
      }
      return node.getAttribute("role") || "control";
    }

    function getHelpText(node) {
      const out = [];
      const seen = new Set();
      const push = (raw) => {
        const text = String(raw || "").replace(/\s+/g, " ").trim().slice(0, 200);
        if (!text) return;
        const key = text.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        out.push(text);
      };
      push(node.getAttribute("aria-description") || "");
      const describedBy = node.getAttribute("aria-describedby");
      if (describedBy) {
        for (const id of describedBy.split(/\s+/).filter(Boolean)) {
          push(document.getElementById(id)?.textContent || "");
        }
      }
      const wrapper = node.closest("fieldset, section, [role='group'], [class*='field' i], [data-automation-id]");
      if (wrapper) {
        for (const el of wrapper.querySelectorAll(":scope [id*='help' i], :scope [class*='help' i], :scope [class*='hint' i], :scope [class*='desc' i], :scope [data-help], :scope small")) {
          if (el.querySelector("input, select, textarea")) continue;
          push(el.textContent || "");
        }
      }
      return out.slice(0, 4).join(" | ").slice(0, 450);
    }

    function isVisibleForScrape(node) {
      if (!(node instanceof Element)) return false;
      if (!node.isConnected) return false;
      if (node.closest("[hidden], [aria-hidden='true']")) return false;
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
      const r = node.getBoundingClientRect();
      return !!r && r.width > 0 && r.height > 0;
    }

    function sortElementsByVisualOrder(elements) {
      const withMeta = elements.map((el, idx) => {
        const r = el.getBoundingClientRect?.() || { top: 0, left: 0 };
        return { el, idx, top: Math.round(r.top), left: Math.round(r.left) };
      });
      withMeta.sort((a, b) => {
        const rowDelta = a.top - b.top;
        if (Math.abs(rowDelta) > 6) return rowDelta;
        const colDelta = a.left - b.left;
        if (Math.abs(colDelta) > 3) return colDelta;
        return a.idx - b.idx;
      });
      return withMeta.map((x) => x.el);
    }

    // Radio groups — one row per group, showing question label + selected option.
    // Most form frameworks put the question text as a preceding sibling of the
    // options container, not inside a <fieldset>. Walk up and check siblings.
    function getGroupLabel(el) {
      const fieldset = el.closest("fieldset");
      if (fieldset) {
        const legend = fieldset.querySelector("legend");
        if (legend?.textContent?.trim()) return legend.textContent.trim();
      }
      const group = el.closest("[role='group'], [role='radiogroup']");
      if (group) {
        const lbId = group.getAttribute("aria-labelledby");
        if (lbId) {
          const lbEl = document.getElementById(lbId.split(" ")[0]);
          if (lbEl?.textContent?.trim()) return lbEl.textContent.trim();
        }
        const ariaLabel = group.getAttribute("aria-label");
        if (ariaLabel) return ariaLabel;
      }
      let node = el.parentElement;
      for (let depth = 0; depth < 5 && node; depth++, node = node.parentElement) {
        let sibling = node.previousElementSibling;
        while (sibling) {
          if (sibling.querySelector("input, select, textarea")) { sibling = sibling.previousElementSibling; continue; }
          const text = sibling.textContent?.trim();
          if (text && text.length > 2 && text.length < 250) return text;
          sibling = sibling.previousElementSibling;
        }
        const lbId = node.getAttribute("aria-labelledby");
        if (lbId) {
          const lbEl = document.getElementById(lbId.split(" ")[0]);
          if (lbEl?.textContent?.trim()) return lbEl.textContent.trim();
        }
        if (node.matches("form, fieldset, section, article, main")) break;
      }
      return el.name || "";
    }

    // Pre-count checkbox names to decide grouped vs standalone
    const checkboxNameCount = new Map();
    for (const el of root.querySelectorAll('input[type="checkbox"]:not([disabled])')) {
      if (!isPageChrome(el) && isVisibleForScrape(el)) checkboxNameCount.set(el.name || "", (checkboxNameCount.get(el.name || "") || 0) + 1);
    }

    // Single querySelectorAll returns all controls in document order.
    // Radio/checkbox groups are collapsed to one entry at the position of their first member.
    const fields = [];
    const seenRadioGroups = new Set();
    const seenCheckboxGroups = new Set();
    const seenAriaIds = new Set();

    const allControls = sortElementsByVisualOrder(Array.from(root.querySelectorAll(
      'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]):not([disabled]),' +
      'select:not([disabled]),' +
      'textarea:not([disabled]),' +
      '[role="combobox"]:not(input):not([disabled]):not([aria-disabled="true"]),' +
      'button:not([disabled]),' +
      'button[aria-haspopup="listbox"]:not([disabled]),' +
      '[aria-haspopup="listbox"]:not(input):not([disabled]):not([aria-disabled="true"])'
    )));

    for (const el of allControls) {
      if (isPageChrome(el)) continue;
      if (!isVisibleForScrape(el)) continue;

      const tag = el.tagName.toUpperCase();
      const type = (el.getAttribute("type") || "").toLowerCase();

      // ── textarea ──────────────────────────────────────────────────────────
      if (tag === "TEXTAREA") {
        if (el.readOnly) continue;
        const label = getLabel(el);
        const sectionPath = getSectionPath(el);
        fields.push({ kind: "textarea", role: getRoleForSnapshot(el, ""), label: label.slice(0, 120), sectionPath, snapshot: `role:textbox | name:${label.slice(0, 120)}${sectionPath ? ` | section:${sectionPath.slice(0, 120)}` : ""}`, name: el.name || "", id: el.id || "", value: (el.value || "").slice(0, 60), helpText: getHelpText(el), empty: !(el.value || "").trim() });
        continue;
      }

      // ── native select ─────────────────────────────────────────────────────
      if (tag === "SELECT") {
        const label = getLabel(el);
        const sectionPath = getSectionPath(el);
        const selectedLabel = el.selectedOptions[0]?.textContent?.trim() || "";
        fields.push({ kind: "select", role: "combobox", label: label.slice(0, 120), sectionPath, snapshot: `role:combobox | name:${label.slice(0, 120)}${sectionPath ? ` | section:${sectionPath.slice(0, 120)}` : ""}`, name: el.name || "", id: el.id || "", automationId: el.getAttribute("data-automation-id") || "", value: selectedLabel, helpText: getHelpText(el), empty: !selectedLabel || /^(select|choose|—)/i.test(selectedLabel), optionCount: el.options.length });
        continue;
      }

      // ── ARIA combobox / custom dropdown trigger ───────────────────────────
      if (tag !== "INPUT") {
        if (el.closest('header, nav, [role="navigation"], [role="banner"], [role="toolbar"], [role="menubar"], [role="search"]')) continue;
        if (el.querySelector("select")) continue; // wraps a native select
        const clone = el.cloneNode(true);
        for (const icon of clone.querySelectorAll('svg, [class*="icon"], [class*="arrow"]')) icon.remove();
        const displayText = clone.textContent.trim();
        const sectionPath = getSectionPath(el);
        const isTerminalAction = /^(?:back|previous|prev|next|continue|save(?: and continue)?|submit|cancel|close|done|finish|review)$/i.test(displayText);
        const isExpandableAdd =
          tag === "BUTTON" &&
          !isTerminalAction &&
          /\badd\b|add another|add item|add entry|add row/i.test(displayText) &&
          !/\b(delete|remove|upload|select files?|browse)\b/i.test(displayText) &&
          (Boolean(sectionPath) || /\b(add another|add item|add entry|add row|add website|add url|add link|add experience|add education|add employment|add school|add degree|add certification|add project)\b/i.test(displayText));
        if (isExpandableAdd) {
          fields.push({
            kind: "expandButton",
            role: "button",
            label: displayText || "Add",
            sectionPath,
            snapshot: `role:button | name:${displayText || "Add"}${sectionPath ? ` | section:${sectionPath.slice(0, 120)}` : ""} | action:expand-repeatable-section`,
            id: el.id || "",
            automationId: el.getAttribute("data-automation-id") || el.closest("[data-automation-id]")?.getAttribute("data-automation-id") || "",
            value: "",
            helpText: "Click to reveal repeatable education/work experience fields.",
            empty: true,
            expandable: true
          });
          continue;
        }
        if (
          tag === "BUTTON" &&
          !el.matches('[role="combobox"], [aria-haspopup="listbox"], [aria-haspopup="true"]')
        ) {
          continue;
        }
        const wrap = el.closest("[data-automation-id], [data-qa], [data-testid]");
        const autoId = el.getAttribute("data-automation-id") || el.getAttribute("data-qa") || el.id || wrap?.getAttribute("data-automation-id") || wrap?.getAttribute("data-qa") || "";
        if (autoId && seenAriaIds.has(autoId)) continue;
        if (autoId) seenAriaIds.add(autoId);
        const lbIds = (el.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean);
        const resolvedLabel = getLabel(el) || autoId;
        fields.push({ kind: "ariaCombobox", role: "combobox", label: resolvedLabel.slice(0, 120), sectionPath, snapshot: `role:combobox | name:${resolvedLabel.slice(0, 120)}${sectionPath ? ` | section:${sectionPath.slice(0, 120)}` : ""}`, id: el.id || "", automationId: autoId, ariaLabelledby: lbIds.join(" "), value: displayText, helpText: getHelpText(el), empty: !displayText || /^(select|choose|—)/i.test(displayText) });
        continue;
      }

      // ── INPUT elements ────────────────────────────────────────────────────
      if (el.readOnly && type !== "radio" && type !== "checkbox") continue;

      if (type === "radio") {
        const name = el.name || "";
        if (seenRadioGroups.has(name)) continue;
        seenRadioGroups.add(name);
        const scope = el.form || root;
        const radios = Array.from(scope.querySelectorAll(`input[type="radio"][name="${CSS.escape(name)}"]`));
        const visibleRadios = radios.filter((r) => isVisibleForScrape(r));
        const checkedRadio = visibleRadios.find(r => r.checked);
        const options = visibleRadios.map(r => (r.labels?.[0]?.textContent?.trim() || r.value || "").slice(0, 40)).filter(Boolean);
        const label = getGroupLabel(el).slice(0, 120);
        const sectionPath = getSectionPath(el);
        fields.push({ kind: "radio", role: "radio", label, sectionPath, snapshot: `role:radio | name:${label}${sectionPath ? ` | section:${sectionPath.slice(0, 120)}` : ""}`, name, options, value: checkedRadio ? (checkedRadio.labels?.[0]?.textContent?.trim() || checkedRadio.value) : "", helpText: getHelpText(el), empty: !checkedRadio });
        continue;
      }

      if (type === "checkbox") {
        const name = el.name || "";
        if (name && checkboxNameCount.get(name) > 1) {
          if (seenCheckboxGroups.has(name)) continue;
          seenCheckboxGroups.add(name);
          const group = Array.from(root.querySelectorAll(`input[type="checkbox"][name="${CSS.escape(name)}"]`)).filter(c => !c.disabled && isVisibleForScrape(c));
          const checkedLabels = group.filter(c => c.checked).map(c => (c.labels?.[0]?.textContent?.trim() || c.value || "").slice(0, 40)).filter(Boolean);
          const label = getGroupLabel(el).slice(0, 120);
          const sectionPath = getSectionPath(el);
          fields.push({ kind: "checkbox-group", role: "checkbox", label, sectionPath, snapshot: `role:checkbox | name:${label}${sectionPath ? ` | section:${sectionPath.slice(0, 120)}` : ""}`, name, options: group.map(c => (c.labels?.[0]?.textContent?.trim() || c.value || "").slice(0, 40)).filter(Boolean), value: checkedLabels.join(", "), helpText: getHelpText(el), empty: checkedLabels.length === 0 });
        } else {
          const label = (getLabel(el) || getGroupLabel(el) || name || "").slice(0, 120);
          const sectionPath = getSectionPath(el);
          fields.push({ kind: "checkbox", role: "checkbox", label, sectionPath, snapshot: `role:checkbox | name:${label}${sectionPath ? ` | section:${sectionPath.slice(0, 120)}` : ""}`, name, id: el.id || "", value: el.checked ? "checked" : "", helpText: getHelpText(el), empty: !el.checked });
        }
        continue;
      }

      if (type === "file") {
        const label = getLabel(el) || el.closest("[data-automation-id]")?.getAttribute("data-automation-id") || el.name || el.id || "";
        const wrap = el.closest('[data-automation-id], section, [class*="upload"], [class*="drop"]');
        const finalLabel = (label || wrap?.textContent?.trim() || "file upload").slice(0, 120);
        const sectionPath = getSectionPath(el);
        fields.push({ kind: "file", role: "textbox", label: finalLabel, sectionPath, snapshot: `role:textbox | name:${finalLabel}${sectionPath ? ` | section:${sectionPath.slice(0, 120)}` : ""}`, name: el.name || "", id: el.id || "", automationId: el.getAttribute("data-automation-id") || wrap?.getAttribute("data-automation-id") || "", accept: el.accept || "", value: el.files?.length ? el.files[0].name : "", helpText: getHelpText(el), empty: !el.files?.length });
        continue;
      }

      if (type === "search" || type === "submit" || type === "button" || type === "reset" || type === "image") continue;

      // text / email / tel / url / date / number / etc.
      const label = getLabel(el).slice(0, 120);
      const sectionPath = getSectionPath(el);
      const role = getRoleForSnapshot(el, type || "text");
      fields.push({ kind: type || "text", role, label, sectionPath, snapshot: `role:${role} | name:${label}${sectionPath ? ` | section:${sectionPath.slice(0, 120)}` : ""}${type ? ` | type:${type}` : ""}`, name: el.name || "", id: el.id || "", automationId: el.getAttribute("data-automation-id") || el.closest("[data-automation-id]")?.getAttribute("data-automation-id") || "", value: el.value || "", helpText: getHelpText(el), empty: !(el.value || "").trim() });
    }

    function dedupeFields(rows) {
      const byKey = new Map();
      for (const f of rows) {
        const kind = String(f.kind || "");
        const label = String(f.label || "").trim().toLowerCase();
        const sectionPath = String(f.sectionPath || "").trim().toLowerCase();
        const name = String(f.name || "").trim().toLowerCase();
        const id = String(f.id || "").trim().toLowerCase();
        const autoId = String(f.automationId || "").trim().toLowerCase();
        const key = [kind, sectionPath, label, name, id, autoId].join("|");
        const prior = byKey.get(key);
        if (!prior) {
          byKey.set(key, f);
          continue;
        }
        // Prefer the richer/usable entry when duplicates collide:
        // 1) non-empty over empty, 2) with options over without, 3) longer label.
        const priorScore =
          (prior.empty ? 0 : 4) +
          (Array.isArray(prior.options) && prior.options.length ? 2 : 0) +
          Math.min(String(prior.label || "").length, 40) / 40;
        const nextScore =
          (f.empty ? 0 : 4) +
          (Array.isArray(f.options) && f.options.length ? 2 : 0) +
          Math.min(String(f.label || "").length, 40) / 40;
        if (nextScore > priorScore) byKey.set(key, f);
      }
      return Array.from(byKey.values());
    }

    const dedupedFields = dedupeFields(fields);
    return {
      total: dedupedFields.length,
      empty: dedupedFields.filter(f => f.empty).length,
      fields: dedupedFields,
      scopedToDialog: !!activeDialog
    };
  };

  global.__PAGE_TOOLS = TOOLS;
  global.__runPageTool = function (toolName, ...args) {
    const fn = TOOLS[toolName];
    if (typeof fn !== "function") return { error: `Unknown tool: ${toolName}` };
    try {
      return fn(...args);
    } catch (e) {
      return { error: e.message };
    }
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
