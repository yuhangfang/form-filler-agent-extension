/**
 * Page listeners that learn from user edits and submitted forms.
 * Classic content script: attaches small helpers to globalThis for other modules.
 */
(function initFieldLearningListeners(global) {
  if (global.__formFillerFieldLearningListenersLoaded) return;
  global.__formFillerFieldLearningListenersLoaded = true;

  function safeRuntimeSendMessage(message) {
    try {
      if (!chrome?.runtime?.id || typeof chrome.runtime.sendMessage !== "function") {
        return;
      }
      chrome.runtime.sendMessage(message, () => {
        // Prevent "unchecked runtime.lastError" noise when extension reloads.
        void chrome.runtime.lastError;
      });
    } catch {
      // Extension context can be invalidated after a hot-reload/update.
    }
  }

  function selectCurrentValue(select) {
    const opt = select.selectedOptions[0];
    return `${select.value || ""}|${(opt?.textContent || "").trim()}`.trim();
  }

  function controlLabelText(control) {
    if (!(control instanceof Element)) return "";
    const id = control.getAttribute("id");
    const explicit = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
    const wrapped = control.closest("label");
    const labelledBy = String(control.getAttribute("aria-labelledby") || "")
      .split(/\s+/)
      .map((part) => document.getElementById(part)?.textContent || "")
      .join(" ");
    return [
      explicit?.textContent,
      wrapped?.textContent,
      labelledBy,
      control.getAttribute("aria-label"),
      control.getAttribute("placeholder"),
      control.getAttribute("title")
    ]
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function controlDisplayValue(control) {
    if (control instanceof HTMLSelectElement) {
      const selected = control.selectedOptions?.[0];
      return (selected?.textContent || control.value || "").replace(/\s+/g, " ").trim();
    }
    if (control instanceof HTMLTextAreaElement) return (control.value || "").trim();
    if (control instanceof HTMLInputElement) {
      const type = (control.type || "text").toLowerCase();
      if (type === "checkbox" || type === "radio") {
        if (!control.checked) return "";
        return (controlLabelText(control) || control.value || "Yes").trim();
      }
      return (control.value || "").trim();
    }
    return "";
  }

  function shouldLearnProfileChange(control, event) {
    if (!event?.isTrusted) return false;
    if (
      !(control instanceof HTMLInputElement) &&
      !(control instanceof HTMLTextAreaElement) &&
      !(control instanceof HTMLSelectElement)
    ) {
      return false;
    }
    if (control.disabled || control.readOnly) return false;
    if (control instanceof HTMLInputElement) {
      const type = (control.type || "text").toLowerCase();
      if (["hidden", "password", "file", "submit", "button", "reset", "image", "search"].includes(type)) return false;
      if ((type === "checkbox" || type === "radio") && !control.checked) return false;
    }
    return !!controlDisplayValue(control);
  }

  function initFieldCorrectionListener() {
    document.addEventListener(
      "change",
      (ev) => {
        if (!ev?.isTrusted) return;
        const t = ev.target;
        if (
          !(t instanceof HTMLInputElement) &&
          !(t instanceof HTMLTextAreaElement) &&
          !(t instanceof HTMLSelectElement)
        ) {
          return;
        }
        const fp = t.getAttribute("data-form-filler-fp");
        if (!fp) return;
        const orig = t.getAttribute("data-form-filler-origin") || "";
        const cur =
          t instanceof HTMLSelectElement ? selectCurrentValue(t) : (t.value || "").trim();
        if (cur === orig.trim()) return;
        const semantic = typeof global.__getPlaywrightFieldSemantics === "function"
          ? global.__getPlaywrightFieldSemantics(t)
          : null;
        const label = controlLabelText(t);
        const context = [
          semantic?.name,
          semantic?.section,
          label,
          t.name,
          t.id
        ].filter(Boolean).join(" | ").replace(/\s+/g, " ").trim();
        safeRuntimeSendMessage({
          type: "FIELD_USER_CORRECTED",
          payload: {
            domain: location.hostname,
            fingerprint: fp,
            context,
            label,
            controlKind:
              t instanceof HTMLSelectElement
                ? "select"
                : t instanceof HTMLTextAreaElement
                  ? "textarea"
                  : (t.type || "text").toLowerCase(),
            newValue: cur,
            priorValue: orig
          }
        });
        t.setAttribute("data-form-filler-user-edited", "true");
        t.setAttribute("data-form-filler-origin", cur);
      },
      true
    );
  }

  function initProfileChangeSnapshotListener() {
    const recent = new Map();
    document.addEventListener(
      "change",
      (ev) => {
        const control = ev.target;
        if (!shouldLearnProfileChange(control, ev)) return;
        const displayValue = controlDisplayValue(control);
        const semantic = typeof global.__getPlaywrightFieldSemantics === "function"
          ? global.__getPlaywrightFieldSemantics(control)
          : null;
        const label = controlLabelText(control);
        const context = [
          semantic?.name,
          semantic?.section,
          label,
          control.name,
          control.id
        ]
          .filter(Boolean)
          .join(" | ")
          .replace(/\s+/g, " ")
          .trim();
        const fingerprint = String(semantic?.fingerprint || control.getAttribute("data-form-filler-fp") || "");
        const signature = `${fingerprint}|${context}|${displayValue}`;
        const now = Date.now();
        if (recent.get(signature) && now - recent.get(signature) < 1500) return;
        recent.set(signature, now);
        setTimeout(() => {
          safeRuntimeSendMessage({
            type: "PROFILE_FIELD_CHANGED",
            payload: {
              domain: location.hostname,
              url: location.href,
              fingerprint,
              context,
              label,
              displayValue,
              value: displayValue,
              elementId: control.id || "",
              elementName: control.name || "",
              controlKind:
                control instanceof HTMLSelectElement
                  ? "select"
                  : control instanceof HTMLTextAreaElement
                    ? "textarea"
                    : (control.type || "text").toLowerCase()
            }
          });
        }, 350);
      },
      true
    );
  }

  function sendFormSubmitHints(form) {
    if (!(form instanceof HTMLFormElement)) return;
    const collect = global.__collectFormSubmitHintEntries;
    if (typeof collect !== "function") return;
    const entries = collect(form);
    if (!entries.length) return;
    safeRuntimeSendMessage({
      type: "FORM_SUBMIT_FIELD_HINTS",
      payload: {
        domain: location.hostname,
        entries
      }
    });
  }

  function initFormSubmitHintCapture() {
    document.addEventListener(
      "submit",
      (ev) => {
        const form =
          ev.target instanceof HTMLFormElement
            ? ev.target
            : ev.target instanceof Element
              ? ev.target.closest("form")
              : null;
        if (!form) return;
        sendFormSubmitHints(form);
      },
      true
    );

    // Some SPA flows bypass native submit; capture submit-button clicks as fallback.
    document.addEventListener(
      "click",
      (ev) => {
        const t = ev.target;
        if (!(t instanceof Element)) return;
        const submitter = t.closest('button[type="submit"], input[type="submit"]');
        if (!submitter) return;
        const form =
          submitter instanceof HTMLButtonElement || submitter instanceof HTMLInputElement
            ? submitter.form || submitter.closest("form")
            : submitter.closest("form");
        if (!form) return;
        sendFormSubmitHints(form);
        setTimeout(() => sendFormSubmitHints(form), 300);
      },
      true
    );
  }

  global.__formFillerControlLabelText = controlLabelText;
  initFieldCorrectionListener();
  initProfileChangeSnapshotListener();
  initFormSubmitHintCapture();
})(typeof globalThis !== "undefined" ? globalThis : this);
