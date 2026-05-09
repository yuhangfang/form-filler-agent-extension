/**
 * Inline AI writing tools for large textarea fields.
 * Classic content script: exposes an initializer so floating-bar-controller can provide local dependencies.
 */
(function initLargeTextboxAssistModule(global) {
  if (global.__initLargeTextboxAssist) return;

  global.__initLargeTextboxAssist = function initLargeTextboxAssist(deps = {}) {
    const WIDGET_ID = "ff-textbox-assist";
    if (document.getElementById(WIDGET_ID)) return;

    const runtimeSendMessageAsync =
      typeof deps.runtimeSendMessageAsync === "function"
        ? deps.runtimeSendMessageAsync
        : async () => ({ ok: false, error: "Runtime messaging unavailable." });
    const controlLabelText =
      typeof deps.controlLabelText === "function"
        ? deps.controlLabelText
        : () => "";
    const setNativeInputValue =
      typeof deps.setNativeInputValue === "function"
        ? deps.setNativeInputValue
        : (el, value) => { el.value = value; };

    let activeTextarea = /** @type {HTMLTextAreaElement|null} */ (null);
    let hoveringWidget = false;
    let hideTimer = null;
    let busy = false;

    const widget = document.createElement("div");
    widget.id = WIDGET_ID;
    widget.style.cssText = [
      "position:fixed",
      "z-index:2147483647",
      "display:none",
      "font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif",
      "pointer-events:auto"
    ].join(";");
    widget.innerHTML = `
      <style>
        .ff-textbox-assist-toggle {
          border: 1px solid #3a4b88;
          background: #1a244a;
          color: #dbeafe;
          border-radius: 999px;
          padding: 2px 8px;
          font-size: 11px;
          line-height: 1.4;
          cursor: pointer;
        }
        @keyframes ff-textbox-assist-blink {
          0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(125, 211, 252, 0.1); }
          50% { opacity: 0.52; box-shadow: 0 0 0 4px rgba(125, 211, 252, 0.22); }
        }
        .ff-textbox-assist-toggle.ff-busy {
          animation: ff-textbox-assist-blink 0.9s ease-in-out infinite;
          border-color: #7dd3fc;
        }
        .ff-textbox-assist-panel {
          margin-top: 6px;
          display: none;
          gap: 6px;
          background: #0f172a;
          border: 1px solid #334155;
          padding: 6px;
          border-radius: 8px;
          box-shadow: 0 8px 20px rgba(0, 0, 0, 0.35);
        }
        .ff-textbox-assist-panel.open { display: flex; }
        .ff-textbox-assist-btn {
          border: 1px solid #3a4b88;
          background: #1e293b;
          color: #dbeafe;
          border-radius: 8px;
          padding: 4px 8px;
          font-size: 11px;
          cursor: pointer;
        }
        .ff-textbox-assist-btn:disabled {
          opacity: 0.65;
          cursor: wait;
        }
      </style>
      <button type="button" class="ff-textbox-assist-toggle" aria-label="Open AI writing tools">AI</button>
      <div class="ff-textbox-assist-panel">
        <button type="button" class="ff-textbox-assist-btn" data-role="primary">Polish</button>
        <button type="button" class="ff-textbox-assist-btn" data-role="chat">Chat</button>
      </div>
    `;
    document.documentElement.appendChild(widget);

    const toggleBtn = widget.querySelector(".ff-textbox-assist-toggle");
    const panelEl = widget.querySelector(".ff-textbox-assist-panel");
    const primaryBtn = widget.querySelector('[data-role="primary"]');
    const chatBtn = widget.querySelector('[data-role="chat"]');

    function getModeFromTextarea(el) {
      return (el.value || "").trim() ? "polish" : "generate";
    }

    function closePanel() {
      panelEl?.classList.remove("open");
    }

    function scheduleHide() {
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        if (hoveringWidget || busy) return;
        widget.style.display = "none";
        activeTextarea = null;
        closePanel();
      }, 140);
    }

    function positionNearTextarea(el) {
      const rect = el.getBoundingClientRect();
      const top = Math.max(8, rect.top + 8);
      const left = Math.max(8, Math.min(window.innerWidth - 140, rect.right - 96));
      widget.style.top = `${top}px`;
      widget.style.left = `${left}px`;
    }

    function refreshButtonLabels() {
      if (!activeTextarea || !(primaryBtn instanceof HTMLButtonElement)) return;
      const mode = getModeFromTextarea(activeTextarea);
      primaryBtn.textContent = mode === "polish" ? "Polish" : "Generate";
    }

    function showForTextarea(el) {
      activeTextarea = el;
      refreshButtonLabels();
      positionNearTextarea(el);
      widget.style.display = "block";
    }

    function emitTextareaEvents(el) {
      try {
        el.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, inputType: "insertText" }));
      } catch {
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }

    function inferTextareaQuestion(el) {
      if (!(el instanceof HTMLTextAreaElement)) return "";
      const direct = controlLabelText(el);
      if (direct) return direct;

      const byAria = String(el.getAttribute("aria-label") || "").trim();
      if (byAria) return byAria;

      const byPlaceholder = String(el.getAttribute("placeholder") || "").trim();
      if (byPlaceholder) return byPlaceholder;

      const describedBy = String(el.getAttribute("aria-describedby") || "")
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent || "")
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (describedBy.length >= 4) return describedBy.slice(0, 240);

      const isUsefulPrompt = (text) => {
        const s = String(text || "").replace(/\s+/g, " ").trim();
        if (s.length < 4) return false;
        if (/^(optional|required|characters? remaining|max(?:imum)? \d+)/i.test(s)) return false;
        return /[?：:]|if applicable|please|describe|explain|tell us|restrictions?|visa/i.test(s);
      };

      const cleanPrompt = (text) => {
        const s = String(text || "").replace(/\s+/g, " ").trim();
        const questionMatch = s.match(/(?:^|[.!]\s+)([^.!?]{8,260}\?)/g);
        if (questionMatch?.length) {
          return questionMatch[questionMatch.length - 1].replace(/^[.!]\s*/, "").trim().slice(0, 260);
        }
        return s.slice(Math.max(0, s.length - 260)).trim();
      };

      const isIgnoredTextNode = (node) => {
        const parent = node.parentElement;
        if (!parent) return true;
        if (parent.closest("textarea, input, select, option, button, script, style, noscript")) return true;
        const style = getComputedStyle(parent);
        return style.display === "none" || style.visibility === "hidden";
      };

      const visibleTextBefore = (container) => {
        const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
          acceptNode: (node) => {
            if (isIgnoredTextNode(node)) return NodeFilter.FILTER_REJECT;
            const relation = node.compareDocumentPosition(el);
            return relation & Node.DOCUMENT_POSITION_FOLLOWING
              ? NodeFilter.FILTER_ACCEPT
              : NodeFilter.FILTER_REJECT;
          }
        });
        const chunks = [];
        let node = walker.nextNode();
        while (node) {
          const text = String(node.textContent || "").replace(/\s+/g, " ").trim();
          if (text) chunks.push(text);
          node = walker.nextNode();
        }
        return chunks.join(" ").replace(/\s+/g, " ").trim();
      };

      let container = el.parentElement;
      for (let depth = 0; container && container !== document.body && depth < 8; depth += 1) {
        const promptText = visibleTextBefore(container);
        if (isUsefulPrompt(promptText)) return cleanPrompt(promptText);
        container = container.parentElement;
      }

      let prev = el.previousElementSibling;
      while (prev) {
        const txt = String(prev.textContent || "").replace(/\s+/g, " ").trim();
        if (txt.length >= 4) return txt.slice(0, 240);
        prev = prev.previousElementSibling;
      }
      return "";
    }

    function setAssistBusyIndicator(isBusy) {
      if (!(toggleBtn instanceof HTMLButtonElement)) return;
      toggleBtn.classList.toggle("ff-busy", !!isBusy);
      toggleBtn.setAttribute("aria-busy", isBusy ? "true" : "false");
      toggleBtn.title = isBusy ? "Waiting for AI response..." : "Open AI writing tools";
    }

    async function runAssist(mode, instruction) {
      if (!(activeTextarea instanceof HTMLTextAreaElement) || busy) return;
      const targetTextarea = activeTextarea;
      const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const inferredQuestion = inferTextareaQuestion(targetTextarea);
      const finalLabel = controlLabelText(targetTextarea) || inferredQuestion;
      const finalPlaceholder = String(targetTextarea.getAttribute("placeholder") || "");
      console.log("[FormFiller TextAssist][CS] start", {
        requestId,
        mode,
        label: finalLabel,
        placeholder: finalPlaceholder,
        questionContext: finalLabel || finalPlaceholder,
        currentTextLength: String(targetTextarea.value || "").length,
        instructionLength: String(instruction || "").length
      });
      busy = true;
      setAssistBusyIndicator(true);
      if (primaryBtn instanceof HTMLButtonElement) primaryBtn.disabled = true;
      if (chatBtn instanceof HTMLButtonElement) chatBtn.disabled = true;
      try {
        const res = await runtimeSendMessageAsync({
          type: "LARGE_TEXTBOX_ASSIST",
          payload: {
            domain: location.hostname,
            mode,
            label: finalLabel,
            placeholder: finalPlaceholder,
            currentText: String(targetTextarea.value || ""),
            instruction: String(instruction || "")
          }
        });
        console.log("[FormFiller TextAssist][CS] response", {
          requestId,
          ok: !!res?.ok,
          hasText: !!String(res?.text || "").trim(),
          textLength: String(res?.text || "").length,
          error: String(res?.error || "")
        });
        if (!res?.ok) {
          const errMsg = String(res?.error || "AI request failed.");
          setAssistBusyIndicator(false);
          if (toggleBtn instanceof HTMLButtonElement) toggleBtn.title = errMsg;
          console.warn("[FormFiller TextAssist][CS] assist failed", { requestId, errMsg });
          return;
        }
        if (!String(res?.text || "").trim()) {
          setAssistBusyIndicator(false);
          if (toggleBtn instanceof HTMLButtonElement) toggleBtn.title = "AI returned empty text.";
          console.warn("[FormFiller TextAssist][CS] empty text response", { requestId });
          return;
        }
        console.log("[FormFiller TextAssist][CS] applying text", {
          requestId,
          applyLength: String(res.text).length
        });
        setNativeInputValue(targetTextarea, String(res.text));
        emitTextareaEvents(targetTextarea);
        refreshButtonLabels();
        targetTextarea.focus();
      } finally {
        console.log("[FormFiller TextAssist][CS] end", { requestId });
        busy = false;
        setAssistBusyIndicator(false);
        if (primaryBtn instanceof HTMLButtonElement) primaryBtn.disabled = false;
        if (chatBtn instanceof HTMLButtonElement) chatBtn.disabled = false;
      }
    }

    function maybeShowForEventTarget(target) {
      const textarea = target instanceof Element ? target.closest("textarea") : null;
      if (!(textarea instanceof HTMLTextAreaElement)) return;
      const large = globalThis.__formFillerPageFormTools?.isLargeTextareaForAiAssist;
      if (typeof large !== "function" || !large(textarea)) return;
      if (hideTimer) clearTimeout(hideTimer);
      showForTextarea(textarea);
    }

    document.addEventListener("pointerover", (event) => {
      maybeShowForEventTarget(event.target);
    }, true);

    document.addEventListener("mouseover", (event) => {
      maybeShowForEventTarget(event.target);
    }, true);

    document.addEventListener("focusin", (event) => {
      maybeShowForEventTarget(event.target);
    }, true);

    document.addEventListener("pointerdown", (event) => {
      maybeShowForEventTarget(event.target);
    }, true);

    document.addEventListener("mouseout", (event) => {
      if (!(event.target instanceof HTMLTextAreaElement)) return;
      if (event.target !== activeTextarea) return;
      const next = event.relatedTarget;
      if (next instanceof Node && widget.contains(next)) return;
      scheduleHide();
    }, true);

    document.addEventListener("focusout", (event) => {
      if (!(event.target instanceof HTMLTextAreaElement)) return;
      if (event.target !== activeTextarea) return;
      const next = event.relatedTarget;
      if (next instanceof Node && widget.contains(next)) return;
      scheduleHide();
    }, true);

    if (document.activeElement instanceof HTMLTextAreaElement) {
      maybeShowForEventTarget(document.activeElement);
    }

    window.addEventListener("scroll", () => {
      if (activeTextarea && widget.style.display !== "none") positionNearTextarea(activeTextarea);
    }, true);
    window.addEventListener("resize", () => {
      if (activeTextarea && widget.style.display !== "none") positionNearTextarea(activeTextarea);
    });

    widget.addEventListener("mouseenter", () => {
      hoveringWidget = true;
      if (hideTimer) clearTimeout(hideTimer);
    });
    widget.addEventListener("mouseleave", () => {
      hoveringWidget = false;
      scheduleHide();
    });

    toggleBtn?.addEventListener("click", () => {
      if (!panelEl) return;
      panelEl.classList.toggle("open");
      refreshButtonLabels();
    });

    primaryBtn?.addEventListener("click", () => {
      if (!(activeTextarea instanceof HTMLTextAreaElement)) return;
      const mode = getModeFromTextarea(activeTextarea);
      void runAssist(mode, "");
    });

    chatBtn?.addEventListener("click", () => {
      if (!(activeTextarea instanceof HTMLTextAreaElement)) return;
      const mode = getModeFromTextarea(activeTextarea);
      const promptText = mode === "polish"
        ? "Tell AI how to polish this text:"
        : "Tell AI what to generate for this field:";
      const instruction = window.prompt(promptText, "");
      if (instruction == null) return;
      void runAssist(mode, instruction);
    });
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
