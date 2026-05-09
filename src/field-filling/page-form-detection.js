/**
 * Page-level form detection and mutation helpers used by the floating UI and background actions.
 * Classic content script: exposes helpers on globalThis.
 */
(function initPageFormDetection(global) {
  if (global.__formFillerPageFormTools) return;

  const FLOATING_ROOT_ID = "form-filler-floating-root";
  const RESTORE_CHIP_ID = "form-filler-floating-restore";

  function selectCurrentValue(select) {
    const opt = select.selectedOptions[0];
    return `${select.value || ""}|${(opt?.textContent || "").trim()}`.trim();
  }

  function collectFillControlCandidates(root = document) {
    const found = [];
    function walk(node) {
      if (!node) return;
      if (node instanceof Element) {
        if (
          node.matches(
            "input, textarea, select, [role='textbox'], [role='searchbox'], [role='combobox'], [role='listbox'], [role='spinbutton'], [role='checkbox'], [role='radio'], [role='switch'], [contenteditable], [aria-haspopup='listbox']"
          )
        ) {
          found.push(node);
        }
        if (node.shadowRoot) walk(node.shadowRoot);
      }
      for (const child of Array.from(node.childNodes || [])) {
        if (child.nodeType === 1) walk(child);
      }
    }
    walk(root instanceof Document ? root.documentElement : root);
    return found;
  }

  function isVisibleFillCandidate(el) {
    if (!(el instanceof Element) || !el.isConnected) return false;
    if (el.closest(`#${FLOATING_ROOT_ID}, #${RESTORE_CHIP_ID}`)) return false;
    if (el.closest("[hidden], [aria-hidden='true']")) return false;
    if (el.closest('header, nav, [role="navigation"], [role="banner"], [role="toolbar"], [role="menubar"], [role="search"]')) {
      return false;
    }
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    const rect = el.getBoundingClientRect();
    return !!rect && rect.width > 0 && rect.height > 0;
  }

  function isFillableNativeControl(el) {
    if (el instanceof HTMLInputElement) {
      const type = (el.type || "text").toLowerCase();
      if (["hidden", "submit", "button", "reset", "image", "search"].includes(type)) return false;
      return !el.disabled && (!el.readOnly || ["checkbox", "radio", "file"].includes(type));
    }
    if (el instanceof HTMLTextAreaElement) return !el.disabled && !el.readOnly;
    if (el instanceof HTMLSelectElement) return !el.disabled;
    return false;
  }

  function hasCustomFillSignal(el) {
    if (!(el instanceof Element)) return false;
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
      return isFillableNativeControl(el);
    }
    if (el.getAttribute("aria-disabled") === "true") return false;
    const role = (el.getAttribute("role") || "").toLowerCase();
    const popup = (el.getAttribute("aria-haspopup") || "").toLowerCase();
    return (
      ["combobox", "listbox", "spinbutton", "checkbox", "radio", "switch"].includes(role) ||
      popup === "listbox"
    );
  }

  function pageHasFillableFormFields() {
    try {
      return collectFillControlCandidates().some((el) => hasCustomFillSignal(el) && isVisibleFillCandidate(el));
    } catch {
      return false;
    }
  }

  function normalizedPageText(text) {
    return String(text || "").toLowerCase().replace(/\s+/g, " ").trim();
  }

  function collectVisibleTextSamples(maxCount = 80) {
    const out = [];
    try {
      const els = Array.from(document.querySelectorAll("button, a, h1, h2, h3, h4, label, legend, [role='button']"));
      for (const el of els) {
        if (!(el instanceof Element)) continue;
        if (!isVisibleFillCandidate(el)) continue;
        const txt = normalizedPageText(el.textContent || el.getAttribute("aria-label") || "");
        if (!txt) continue;
        out.push(txt);
        if (out.length >= maxCount) break;
      }
    } catch {
      return out;
    }
    return out;
  }

  function detectRegisterIntentSignals() {
    const textSamples = collectVisibleTextSamples();
    const pageContext = normalizedPageText(
      `${document.title || ""} ${location.pathname || ""} ${location.search || ""} ${location.hash || ""}`
    );
    const combinedText = `${pageContext} ${textSamples.join(" ")}`.trim();
    const hasRegisterSignal =
      /\b(register)\b/.test(combinedText) ||
      /\b(create account|create an account|new account)\b/.test(combinedText);
    const hasSignUpSignal = /\b(sign[\s-]?up)\b/.test(combinedText);
    const hasSignInSignal = /\b(sign[\s-]?in|log[\s-]?in|login)\b/.test(combinedText);
    const hasPasswordField = !!document.querySelector('input[type="password"], [autocomplete="new-password"]');
    const hasEmailLikeField = !!document.querySelector(
      'input[type="email"], input[autocomplete="email"], input[name*="email" i], input[id*="email" i]'
    );
    const registrationWeighted = (hasRegisterSignal ? 2 : 0) + (hasSignUpSignal ? 2 : 0) + (hasEmailLikeField ? 1 : 0);
    const loginOnlyWeighted = (hasSignInSignal ? 1 : 0) + (hasPasswordField ? 1 : 0);
    const isLikelyRegistrationFlow = registrationWeighted >= 2 && registrationWeighted >= loginOnlyWeighted;
    return {
      hasRegisterSignal,
      hasSignUpSignal,
      hasSignInSignal,
      hasPasswordField,
      hasEmailLikeField,
      isLikelyRegistrationFlow
    };
  }

  function pageHasResumeUploadField() {
    try {
      const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
      if (!inputs.length) return false;
      const isAts = /workday|greenhouse|lever|ashby|taleo|brassring|icims|smartrecruiters|myworkday|myworkdayjobs/.test(location.hostname);
      const pageCtx = (document.title + " " + location.pathname + " " + location.search).toLowerCase();
      const isJobApplicationPage = /resume|cv|autofill|apply|application/.test(pageCtx);
      return inputs.some((i) => {
        const attrs = [
          i.name, i.id, i.accept,
          i.getAttribute("aria-label"),
          i.getAttribute("data-automation-id"),
          i.placeholder, i.labels?.[0]?.textContent,
          i.closest("[data-automation-id]")?.getAttribute("data-automation-id")
        ].filter(Boolean).join(" ").toLowerCase();
        if (/resume|cv|curriculum|upload resume|attach resume|application document/.test(attrs)) return true;
        if (isAts && /file.?upload|upload.?input|attach.?file/.test(attrs)) return true;
        if (isJobApplicationPage && /\.(pdf|doc|docx|txt|rtf)/.test(i.accept || "")) return true;
        return isAts && inputs.length === 1 && isJobApplicationPage;
      });
    } catch {
      return false;
    }
  }

  function isJobApplicationContext() {
    try {
      const hostname = location.hostname.toLowerCase();
      const path = (location.pathname + location.search).toLowerCase();
      const pageTitle = (document.title || "").toLowerCase();

      if (/workday|greenhouse|lever\.co|ashby|taleo|brassring|icims|smartrecruiters|myworkday|myworkdayjobs|jobvite|bamboohr|workable|recruitee|jazzhr|jazz\.co|successfactors|dayforce|applytojob|pinpointhq|dover\.com/.test(hostname)) {
        return true;
      }
      if (/^(jobs|careers)\./.test(hostname)) return true;
      if (/\/(apply|application|job-application|submit-application|jobs|careers)\b/.test(path)) return true;
      if (pageHasResumeUploadField()) return true;

      const textSamples = collectVisibleTextSamples(60).join(" ");
      const combined = `${pageTitle} ${textSamples}`.toLowerCase();
      return (
        /\bcover\s+letter\b/.test(combined) ||
        /\b(upload|attach|submit)\s+(your\s+)?(resume|cv)\b/.test(combined) ||
        /\b(apply\s+(for|now)|submit\s+(your\s+)?application|complete\s+(your\s+)?application)\b/.test(combined) ||
        /\bjob\s+application\b/.test(combined) ||
        /\b(jobs|careers)\b/.test(pageTitle) ||
        ((/\bemployment\s+history\b/.test(combined) || /\bwork\s+experience\b/.test(combined)) && /\b(apply|application)\b/.test(combined))
      );
    } catch {
      return false;
    }
  }

  function setNativeInputValue(control, value) {
    const proto = control instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const nativeSetter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (nativeSetter) nativeSetter.call(control, value);
    else control.value = value;
  }

  function setNativeCheckedValue(input, checked) {
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked")?.set;
    if (nativeSetter) nativeSetter.call(input, checked);
    else input.checked = checked;
  }

  function emitFormFillerClearEvents(control) {
    try {
      control.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, data: "", inputType: "deleteContent" }));
    } catch {
      control.dispatchEvent(new Event("input", { bubbles: true }));
    }
    control.dispatchEvent(new Event("change", { bubbles: true }));
    try {
      control.dispatchEvent(new Event("blur", { bubbles: true }));
    } catch {}
  }

  function clearNativeFormControl(control) {
    if (!isFillableNativeControl(control)) return false;
    if (control instanceof HTMLInputElement) {
      const type = (control.type || "text").toLowerCase();
      if (["hidden", "submit", "button", "reset", "image"].includes(type)) return false;
      if (type === "checkbox" || type === "radio") {
        if (!control.checked) return false;
        setNativeCheckedValue(control, false);
      } else {
        if (!control.value) return false;
        setNativeInputValue(control, "");
      }
      emitFormFillerClearEvents(control);
      return true;
    }
    if (control instanceof HTMLTextAreaElement) {
      if (!control.value) return false;
      setNativeInputValue(control, "");
      emitFormFillerClearEvents(control);
      return true;
    }
    if (control instanceof HTMLSelectElement) {
      const oldValue = selectCurrentValue(control);
      const emptyIndex = Array.from(control.options).findIndex((opt) => !String(opt.value || "").trim());
      control.selectedIndex = emptyIndex >= 0 ? emptyIndex : -1;
      for (let i = 0; i < control.options.length; i += 1) {
        control.options[i].selected = i === control.selectedIndex;
      }
      if (selectCurrentValue(control) === oldValue) return false;
      emitFormFillerClearEvents(control);
      return true;
    }
    return false;
  }

  function clearCustomFormControl(el) {
    if (!(el instanceof HTMLElement)) return false;
    if (el.getAttribute("aria-disabled") === "true") return false;
    const role = (el.getAttribute("role") || "").toLowerCase();
    if (["checkbox", "radio", "switch"].includes(role) && el.getAttribute("aria-checked") === "true") {
      el.setAttribute("aria-checked", "false");
      emitFormFillerClearEvents(el);
      return true;
    }
    if ((role === "textbox" || el.isContentEditable) && el.textContent) {
      el.textContent = "";
      emitFormFillerClearEvents(el);
      return true;
    }
    return false;
  }

  /** Native textarea large enough for the inline AI writing chip; Fill skips these when empty. */
  function isLargeTextareaForAiAssist(el) {
    if (!(el instanceof HTMLTextAreaElement)) return false;
    if (el.disabled || el.readOnly) return false;
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 180 || rect.height < 48) return false;
    return el.rows >= 3 || rect.height >= 64;
  }

  function clearDetectedFormFields() {
    let cleared = 0;
    const seen = new Set();
    for (const el of collectFillControlCandidates()) {
      if (seen.has(el) || !isVisibleFillCandidate(el)) continue;
      seen.add(el);
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
        if (clearNativeFormControl(el)) cleared += 1;
      } else if (clearCustomFormControl(el)) {
        cleared += 1;
      }
    }
    return cleared;
  }

  const api = {
    collectFillControlCandidates,
    isVisibleFillCandidate,
    isFillableNativeControl,
    isLargeTextareaForAiAssist,
    hasCustomFillSignal,
    pageHasFillableFormFields,
    collectVisibleTextSamples,
    detectRegisterIntentSignals,
    pageHasResumeUploadField,
    isJobApplicationContext,
    setNativeInputValue,
    emitFormFillerClearEvents,
    clearDetectedFormFields
  };

  global.__formFillerPageFormTools = api;
  global.__clearFormFillerFields = clearDetectedFormFields;
})(typeof globalThis !== "undefined" ? globalThis : this);
