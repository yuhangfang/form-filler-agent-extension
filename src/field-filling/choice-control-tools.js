/**
 * Radio and checkbox helpers.
 *
 * This module owns checkable control discovery, group labelling, option matching,
 * and user-like click/set behavior for native and ARIA checkbox/radio widgets.
 */
(function attachChoiceControlTools(global) {
  const fieldDescriptorTools = global.__formFillerFieldDescriptorTools;
  if (!fieldDescriptorTools) {
    throw new Error("choice-control-tools: load field-filling/field-descriptor-tools.js before choice-control-tools.js");
  }
  const controlFillTools = global.__formFillerControlFillTools;
  if (!controlFillTools) {
    throw new Error("choice-control-tools: load field-filling/control-fill-tools.js before choice-control-tools.js");
  }

  function normalize(input) {
    return String(input || "").toLowerCase().replace(/\s+/g, " ").trim();
  }

  function debugLog(...args) {
    try {
      if (globalThis.__FORM_FILLER_DEBUG === true || localStorage.getItem("FORM_FILLER_DEBUG") === "1") {
        const serialized = args.map((arg) => {
          if (arg == null || typeof arg !== "object") return String(arg);
          try {
            return JSON.stringify(arg);
          } catch {
            return String(arg);
          }
        });
        console.warn("[FormFiller][debug]", new Date().toISOString(), ...serialized);
      }
    } catch {
      /* debug logging only */
    }
  }

  function debugElement(el) {
    if (!(el instanceof Element)) return null;
    const rect = el.getBoundingClientRect?.();
    return {
      tag: el.tagName,
      id: el.id || "",
      name: el.getAttribute("name") || "",
      type: el.getAttribute("type") || "",
      role: el.getAttribute("role") || "",
      ariaChecked: el.getAttribute("aria-checked") || "",
      checked: el instanceof HTMLInputElement ? !!el.checked : undefined,
      text: normalize(el.textContent || el.getAttribute("aria-label") || "").slice(0, 180),
      box: rect ? {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        w: Math.round(rect.width),
        h: Math.round(rect.height)
      } : null
    };
  }

  function checkboxOrRadioLabel(control) {
    if (!(control instanceof HTMLInputElement)) {
      const aria = control.getAttribute?.("aria-label") || "";
      if (String(aria).trim()) return String(aria).trim();
      const text = control.textContent || "";
      if (String(text).trim()) return String(text).trim();
      return String(control.closest?.("label")?.textContent || "").trim();
    }
    const direct = control.labels?.[0]?.textContent || "";
    if (String(direct).trim()) return String(direct).trim();
    const parentLabel = control.closest("label")?.textContent || "";
    return String(parentLabel).trim();
  }

  function checkableType(control) {
    if (control instanceof HTMLInputElement) {
      const t = (control.type || "").toLowerCase();
      return t === "checkbox" || t === "radio" ? t : "";
    }
    if (control instanceof Element) {
      const role = String(control.getAttribute("role") || "").toLowerCase();
      return role === "checkbox" || role === "radio" ? role : "";
    }
    return "";
  }

  function checkableValue(control) {
    if (control instanceof HTMLInputElement) return control.value || "";
    return control.getAttribute?.("value") || control.getAttribute?.("aria-label") || checkboxOrRadioLabel(control);
  }

  function checkableChecked(control) {
    const ariaChecked = String(control.getAttribute?.("aria-checked") || "").toLowerCase() === "true";
    if (control instanceof HTMLInputElement) return control.checked || ariaChecked;
    return String(control.getAttribute?.("aria-checked") || "").toLowerCase() === "true";
  }

  function checkableDisabled(control) {
    return !!(control instanceof HTMLInputElement ? control.disabled : control.getAttribute?.("aria-disabled") === "true");
  }

  function collectRoleCheckables(root, type) {
    const scope = root || document;
    const nodes = scope.querySelectorAll ? Array.from(scope.querySelectorAll(`[role="${type}"]`)) : [];
    return nodes.filter((el) => el instanceof Element && controlFillTools.isVisibleForScrape(el) && !checkableDisabled(el));
  }

  function collectChoiceControls(root, type) {
    const native = controlFillTools.collectFormControls(root || document).filter(
      (x) =>
        x instanceof HTMLInputElement &&
        (x.type || "").toLowerCase() === type &&
        controlFillTools.isVisibleForScrape(x) &&
        !checkableDisabled(x)
    );
    return controlFillTools.sortElementsByVisualOrder([...native, ...collectRoleCheckables(root || document, type)]);
  }

  function collectFormControlsAndRoleCheckables(root) {
    return controlFillTools.sortElementsByVisualOrder([
      ...controlFillTools.collectFormControls(root || document),
      ...collectRoleCheckables(root || document, "radio"),
      ...collectRoleCheckables(root || document, "checkbox")
    ]);
  }

  /**
   * All radio widgets in the same group as `control`: named native inputs,
   * unnamed radios under a shared list/field group, or options inside a radiogroup.
   */
  function collectRadioGroupMembers(control) {
    if (!(control instanceof Element)) return [];
    const rg = control.closest("[role='radiogroup']");
    if (rg) {
      return controlFillTools.sortElementsByVisualOrder(collectChoiceControls(rg, "radio"));
    }
    const named =
      control instanceof HTMLInputElement &&
      (control.type || "").toLowerCase() === "radio" &&
      (control.name || "").trim();
    if (named) {
      const form = control.form || control.closest("form") || document;
      return controlFillTools.sortElementsByVisualOrder(
        controlFillTools.collectFormControls(form).filter(
          (x) =>
            x instanceof HTMLInputElement &&
            (x.type || "").toLowerCase() === "radio" &&
            (x.name || "").trim() === control.name.trim()
        )
      );
    }
    let root = choiceGroupRoot(control, "radio");
    if (!root) {
      const li = control.closest("li");
      const listParent = li?.parentElement;
      if (listParent && /^(UL|OL)$/i.test(listParent.tagName || "")) {
        root = listParent;
      }
    }
    if (!root) {
      let p = control.parentElement;
      for (let d = 0; d < 5 && p; d += 1, p = p.parentElement) {
        const ch = collectChoiceControls(p, "radio");
        if (ch.length >= 2 && ch.includes(control)) {
          root = p;
          break;
        }
      }
    }
    if (!root) return [control];
    return controlFillTools.sortElementsByVisualOrder(collectChoiceControls(root, "radio"));
  }

  /** Same grouping idea as collectRadioGroupMembers, for checkbox lists (e.g. pronouns). */
  function collectCheckboxGroupMembers(control) {
    if (!(control instanceof Element)) return [];
    const named =
      control instanceof HTMLInputElement &&
      (control.type || "").toLowerCase() === "checkbox" &&
      (control.name || "").trim();
    if (named) {
      const form = control.form || control.closest("form") || document;
      return controlFillTools.sortElementsByVisualOrder(
        controlFillTools.collectFormControls(form).filter(
          (x) =>
            x instanceof HTMLInputElement &&
            (x.type || "").toLowerCase() === "checkbox" &&
            (x.name || "").trim() === control.name.trim()
        )
      );
    }
    let root = choiceGroupRoot(control, "checkbox");
    if (!root) {
      const li = control.closest("li");
      const listParent = li?.parentElement;
      if (listParent && /^(UL|OL)$/i.test(listParent.tagName || "")) {
        root = listParent;
      }
    }
    if (!root) {
      let p = control.parentElement;
      for (let d = 0; d < 5 && p; d += 1, p = p.parentElement) {
        const ch = collectChoiceControls(p, "checkbox");
        if (ch.length >= 2 && ch.includes(control)) {
          root = p;
          break;
        }
      }
    }
    if (!root) return [control];
    return controlFillTools.sortElementsByVisualOrder(collectChoiceControls(root, "checkbox"));
  }

  function findMatchingRadioInGroup(control, candidates) {
    const radios = collectRadioGroupMembers(control);
    if (!radios.length) return null;
    for (const r of radios) {
      const optionText = normalize(`${checkableValue(r)} ${checkboxOrRadioLabel(r)}`.trim());
      for (const c of candidates) {
        const n = normalize(c);
        if (!n) continue;
        if (
          optionText &&
          (
            optionText === n ||
            optionText.includes(n) ||
            (optionText.length >= 3 && n.includes(optionText))
          )
        ) return r;
      }
    }
    return null;
  }

  function choiceGroupRoot(control, inputType) {
    if (!(control instanceof Element)) return null;
    let node = control.closest("fieldset, [role='group'], [role='radiogroup']") || control.parentElement;
    for (let depth = 0; depth < 8 && node; depth += 1, node = node.parentElement) {
      const choices = collectChoiceControls(node, inputType);
      if (choices.length >= 2 && choices.includes(control)) return node;
    }
    return null;
  }

  function choiceGroupLabel(root, control) {
    const labels = [];
    const push = (raw) => {
      const text = fieldDescriptorTools.sanitizeFieldContext(raw).slice(0, 180);
      if (text) labels.push(text);
    };
    if (root instanceof Element) {
      push(root.querySelector?.("legend")?.textContent || "");
      const labelledBy = root.getAttribute?.("aria-labelledby");
      if (labelledBy) {
        for (const id of labelledBy.split(/\s+/).filter(Boolean).slice(0, 3)) {
          push(root.ownerDocument?.getElementById(id)?.textContent || "");
        }
      }
      push(root.getAttribute?.("aria-label") || "");
      let sibling = root.previousElementSibling;
      while (sibling && labels.length < 1) {
        if (!sibling.querySelector?.("input, select, textarea")) push(sibling.textContent || "");
        sibling = sibling.previousElementSibling;
      }
    }
    push(fieldDescriptorTools.getRadioOrCheckboxGroupLabel(control));
    return labels[0] || "";
  }

  function findMatchingCheckboxInGroup(control, candidates) {
    const checkboxes = collectCheckboxGroupMembers(control);
    if (!checkboxes.length) return null;
    for (const box of checkboxes) {
      const optionText = normalize(`${checkableValue(box)} ${checkboxOrRadioLabel(box)}`.trim());
      for (const c of candidates) {
        const n = normalize(c);
        if (!n) continue;
        if (checkboxCandidateMatchesOption(optionText, n)) return box;
      }
    }
    return null;
  }

  function clickLikeUser(el) {
    if (!(el instanceof Element)) return false;
    try { el.scrollIntoView?.({ behavior: "smooth", block: "center", inline: "nearest" }); } catch {}
    try { el.focus?.(); } catch {}
    try { el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "mouse" })); } catch {}
    try { el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })); } catch {}
    try { el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, pointerType: "mouse" })); } catch {}
    try { el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true })); } catch {}
    try { el.click(); return true; } catch {
      try { el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); return true; } catch {}
    }
    return false;
  }

  function clickMatchingChoiceLabel(root, candidates) {
    const scope = root instanceof Element || root instanceof Document ? root : document;
    const wanted = (Array.isArray(candidates) ? candidates : [])
      .map((c) => normalize(c))
      .filter(Boolean);
    debugLog("checkbox:label_fallback:start", { wanted });
    if (!wanted.length || !scope.querySelectorAll) return false;
    const nodes = Array.from(scope.querySelectorAll(
      "label, [role='checkbox'], [role='radio'], [role='cell'], td, div, span"
    )).filter((el) => {
      if (!(el instanceof Element) || !controlFillTools.isVisibleForScrape(el)) return false;
      const text = normalize(el.textContent || el.getAttribute?.("aria-label") || "");
      if (!text) return false;
      return wanted.some((w) => text === w || text.includes(w));
    });
    nodes.sort((a, b) => {
      const at = normalize(a.textContent || a.getAttribute?.("aria-label") || "");
      const bt = normalize(b.textContent || b.getAttribute?.("aria-label") || "");
      const aExact = wanted.some((w) => at === w) ? 0 : 1;
      const bExact = wanted.some((w) => bt === w) ? 0 : 1;
      return (aExact - bExact) || (at.length - bt.length);
    });
    for (const node of nodes) {
      const targets = [];
      const push = (el) => {
        if (el instanceof Element && !targets.includes(el)) targets.push(el);
      };
      push(node.querySelector?.("[role='checkbox'], input[type='checkbox']"));
      push(node.previousElementSibling?.querySelector?.("[role='checkbox'], input[type='checkbox']"));
      push(node.closest?.("label"));
      push(node.closest?.("[role='checkbox']"));
      const cell = node.closest?.("[role='cell'], td, [role='row'], tr");
      push(cell?.querySelector?.("[role='checkbox'], input[type='checkbox']"));
      push(node);
      push(cell);
      const target = targets[0];
      if (!target) continue;
      debugLog("checkbox:label_fallback:click", {
        nodeText: normalize(node.textContent || node.getAttribute?.("aria-label") || "").slice(0, 180),
        target: debugElement(target)
      });
      clickLikeUser(target);
      debugLog("checkbox:label_fallback:after_click", { target: debugElement(target) });
      return true;
    }
    debugLog("checkbox:label_fallback:no_match", { wanted });
    return false;
  }

  function selectCheckboxChoice(control, candidates) {
    const root = control instanceof Element ? (choiceGroupRoot(control, "checkbox") || control.closest("form") || document) : document;
    const target = control instanceof Element ? findMatchingCheckboxInGroup(control, candidates) : null;
    debugLog("checkbox:select:start", {
      candidates,
      control: debugElement(control),
      target: debugElement(target),
      targetChecked: target instanceof Element ? checkableChecked(target) : false
    });
    if (target && checkableChecked(target)) {
      debugLog("checkbox:select:skip_already_checked", { target: debugElement(target) });
      return true;
    }
    if (target) {
      if (target instanceof HTMLInputElement) {
        const ok = setChecked(target);
        debugLog("checkbox:select:native_set_checked", { ok, target: debugElement(target) });
        return ok;
      }
      clickLikeUser(target);
      controlFillTools.tagFilledControlAfterWrite(target, checkableValue(target) || "on", "evaluate:checkbox_click_once");
      debugLog("checkbox:select:clicked_target_once", {
        target: debugElement(target),
        checkedAfterClick: checkableChecked(target),
        ariaChecked: target.getAttribute?.("aria-checked") || ""
      });
      return true;
    }
    return clickMatchingChoiceLabel(root, candidates);
  }

  function setChecked(control) {
    const shared = globalThis.__formFillerBrowserActions;
    if (shared && typeof shared.setChecked === "function") {
      const result = shared.setChecked(control, true);
      if (result?.ok) {
        controlFillTools.tagFilledControlAfterWrite(control, checkableValue(control) || "on", "evaluate:storage");
        return true;
      }
    }
    if (!(control instanceof Element)) return false;
    if (checkableChecked(control)) return true;
    if (!clickLikeUser(control)) return false;
    control.dispatchEvent(new Event("input", { bubbles: true }));
    control.dispatchEvent(new Event("change", { bubbles: true }));
    if (control instanceof HTMLInputElement && !control.checked) control.checked = true;
    if (!(control instanceof HTMLInputElement) && !checkableChecked(control)) return false;
    controlFillTools.tagFilledControlAfterWrite(control, checkableValue(control) || "on", "evaluate:storage");
    return true;
  }

  function checkboxCandidateMatchesOption(optionText, candidate) {
    const optionNorm = normalize(optionText);
    const candNorm = normalize(candidate);
    if (!optionNorm || !candNorm) return false;
    if (optionNorm === candNorm) return true;
    if (optionNorm.includes(candNorm) && candNorm.length >= 2) return true;
    if (
      candNorm.includes(optionNorm) &&
      optionNorm.length >= 3 &&
      candNorm.length <= optionNorm.length + 12
    ) {
      return true;
    }
    return false;
  }

  global.__formFillerChoiceControlTools = {
    checkboxOrRadioLabel,
    checkableType,
    checkableValue,
    checkableChecked,
    checkableDisabled,
    collectRoleCheckables,
    collectChoiceControls,
    collectFormControlsAndRoleCheckables,
    collectRadioGroupMembers,
    collectCheckboxGroupMembers,
    findMatchingRadioInGroup,
    choiceGroupRoot,
    choiceGroupLabel,
    findMatchingCheckboxInGroup,
    clickLikeUser,
    clickMatchingChoiceLabel,
    selectCheckboxChoice,
    setChecked,
    checkboxCandidateMatchesOption
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
