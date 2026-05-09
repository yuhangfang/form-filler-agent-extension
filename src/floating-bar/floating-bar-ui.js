/**
 * Shared UI layout, positioning, and drag helpers for floating-bar widgets.
 * Classic content script: attaches helpers to globalThis.
 */
(function initFloatingBarUiHelpers(global) {
  const FLOATING_DEFAULT_OFFSET_PX = 16;
  const floatingUiPosition = { left: null, top: null };

  function applyHostLayout(host) {
    host.style.position = "fixed";
    host.style.right = "16px";
    host.style.top = "16px";
    host.style.width = "340px";
    host.style.height = "auto";
    host.style.zIndex = "2147483647";
  }

  function applyRestoreChipLayout(chip) {
    chip.style.cssText = [
      "position:fixed",
      "right:16px",
      "top:16px",
      "z-index:2147483647",
      "display:none",
      "padding:8px 14px",
      "font-size:12px",
      "font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif",
      "border-radius:999px",
      "border:1px solid #4c67c2",
      "background:#2f4cb0",
      "color:#fff",
      "cursor:pointer",
      "box-shadow:0 4px 14px rgba(0,0,0,.35)"
    ].join(";");
  }

  function getFloatingBarTemplate() {
    return `
    <style>
      .bar {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: rgba(14, 21, 44, 0.96);
        color: #e9edff;
        border: 1px solid #334a90;
        border-radius: 12px;
        box-shadow: 0 10px 30px rgba(0,0,0,.35);
        width: 340px;
        height: auto;
        min-height: 0;
        padding: 10px;
        box-sizing: border-box;
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }
      .row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
      button {
        border: 1px solid #4c67c2;
        background: #2f4cb0;
        color: white;
        border-radius: 8px;
        padding: 6px 10px;
        font-size: 12px;
        cursor: pointer;
      }
      button.secondary { background: #1a244a; border-color: #3a4b88; }
      button.danger { background: #5f1f2f; border-color: #b84d64; }
      button.toggle-off { background: #27304f; border-color: #52607f; color: #cbd5e1; }
      button.stop { background: #7f1d1d; border-color: #ef4444; }
      button.suggested { border-color: #7fb4ff; box-shadow: 0 0 0 1px #7fb4ff inset; }
      button:disabled { opacity: 0.6; cursor: not-allowed; }
      .status {
        margin-top: 8px;
        font-size: 12px;
        line-height: 1.35;
        color: #c9d6ff;
        max-height: 60px;
        overflow: auto;
        word-break: break-word;
        flex: 0 0 auto;
      }
      .scan {
        margin-top: 8px;
        padding: 8px;
        border-radius: 8px;
        border: 1px solid #31447f;
        background: #0f1836;
        color: #c9d6ff;
        flex: 1 1 auto;
        min-height: 0;
        overflow: auto;
        white-space: pre-wrap;
        font-size: 11px;
        line-height: 1.35;
        display: block;
      }
      .card-nav {
        margin-top: 8px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        font-size: 11px;
        color: #a8bbff;
      }
      .card-nav-controls { display: flex; gap: 8px; margin-left: auto; }
      .reader-field-card{background:#111b30;border:1px solid #2b3a54;border-radius:8px;padding:10px 12px;border-left:4px solid #475569;font-size:12px;line-height:1.45;}
      .reader-field-card.reader-field-conf-high{border-left-color:#22c55e;}
      .reader-field-card.reader-field-conf-mid{border-left-color:#f59e0b;}
      .reader-field-card.reader-field-conf-low{border-left-color:#64748b;}
      .reader-field-card.reader-field-needs-expansion{border-left-color:#a855f7;background:#17152b;}
      .reader-field-group-meta{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;padding:6px 8px;border-radius:8px;border:1px solid #26395f;background:rgba(15,23,42,.75);}
      .reader-field-group-title{font-size:10px;font-weight:700;color:#dbeafe;text-transform:uppercase;letter-spacing:.06em;}
      .reader-field-group-pos{font-size:10px;color:#94a3b8;white-space:nowrap;}
      .reader-field-group-meta.reader-field-section-experience{border-color:#2563eb;background:rgba(30,64,175,.18);}
      .reader-field-group-meta.reader-field-section-education{border-color:#7c3aed;background:rgba(91,33,182,.18);}
      .reader-field-group-meta.reader-field-section-project{border-color:#0891b2;background:rgba(14,116,144,.16);}
      .reader-field-group-meta.reader-field-section-certification{border-color:#ca8a04;background:rgba(133,77,14,.16);}
      .reader-field-group-meta.reader-field-section-website{border-color:#059669;background:rgba(6,95,70,.16);}
      .reader-field-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px 10px;margin-bottom:8px;padding-bottom:8px;border-bottom:1px solid #1e293b;}
      .reader-field-idx{font-size:10px;font-weight:700;color:#94a3b8;min-width:1.5rem;}
      .reader-field-label{font-weight:600;color:#e5e7eb;flex:1 1 140px;min-width:0;word-break:break-word;}
      .reader-field-type{font-size:10px;text-transform:uppercase;letter-spacing:0.04em;padding:2px 8px;border-radius:999px;background:#1e293b;color:#94a3b8;border:1px solid #334155;}
      .reader-field-conf{font-size:11px;font-weight:600;margin-left:auto;}
      .reader-field-conf.reader-field-conf-high{color:#22c55e;}
      .reader-field-conf.reader-field-conf-mid{color:#f59e0b;}
      .reader-field-conf.reader-field-conf-low{color:#94a3b8;}
      .reader-field-block{margin-top:6px;}
      .reader-field-block:first-of-type{margin-top:0;}
      .reader-field-block-label{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:#94a3b8;margin-bottom:4px;}
      .reader-field-suggested{font-family:ui-monospace,monospace;font-size:12px;color:#e0f2fe;background:#0c1222;border:1px solid #334155;border-radius:6px;padding:8px 10px;white-space:pre-wrap;word-break:break-word;max-height:120px;overflow:auto;}
      .reader-field-suggested.reader-field-empty{color:#94a3b8;font-style:italic;}
      .reader-field-why{font-size:11px;color:#cbd5e1;white-space:pre-wrap;word-break:break-word;}
      .reader-field-options{display:flex;flex-wrap:wrap;gap:6px;}
      .reader-field-option-pill{display:inline-flex;align-items:center;max-width:100%;padding:2px 8px;border-radius:999px;border:1px solid #334155;background:#0f172a;color:#cbd5e1;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
      .reader-field-option-group{margin:6px 0;padding:8px;border:1px solid #1e293b;border-radius:6px;background:#0c1222;}
      .reader-field-option-group-label{font-size:10px;font-weight:600;color:#e2e8f0;margin-bottom:6px;}
      .reader-expansion-pill{font-size:10px;text-transform:uppercase;letter-spacing:0.04em;padding:2px 8px;border-radius:999px;background:#3b1a5f;color:#f3e8ff;border:1px solid #7e22ce;}
      .title-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 8px;
        cursor: move;
        user-select: none;
      }
      .title {
        font-size: 12px;
        color: #a8bbff;
        flex: 1;
        min-width: 0;
      }
      button.hide-btn {
        flex: 0 0 auto;
        padding: 4px 10px;
        font-size: 11px;
        background: #1a244a;
        border-color: #3a4b88;
      }
      @keyframes ff-llm-blink {
        0%, 100% {
          border-color: #334a90;
          box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
        }
        50% {
          border-color: #f59e0b;
          box-shadow:
            0 10px 30px rgba(0, 0, 0, 0.35),
            0 0 0 2px rgba(251, 191, 36, 0.95),
            0 0 28px 6px rgba(245, 158, 11, 0.4);
        }
      }
      .bar.ff-llm-active { animation: ff-llm-blink 1s ease-in-out infinite; }
    </style>
    <div class="bar">
      <div class="title-row">
        <span class="title">Adaptive Form Filler</span>
        <button type="button" id="ffHide" class="hide-btn" title="Hide this panel">Hide</button>
      </div>
      <div class="row">
        <button id="ffFill">Fill</button>
        <button id="ffAiToggle" class="secondary" title="Toggle AI fallback during Fill">AI: On</button>
        <button id="ffRunner" class="secondary">Experiment Runner</button>
        <button id="ffClear" class="danger">Clear</button>
        <button id="ffStop" class="stop" disabled>Stop</button>
      </div>
      <div id="ffStatus" class="status">Ready.</div>
      <div class="card-nav">
        <span id="ffCardCount">No extracted fields yet.</span>
        <div class="card-nav-controls">
          <button id="ffPrev" class="secondary" disabled>Previous</button>
          <button id="ffNext" class="secondary" disabled>Next</button>
        </div>
      </div>
      <div id="ffScanOut" class="scan"></div>
    </div>
  `;
  }

  function clampFloatingPosition(left, top, el) {
    const rect = el?.getBoundingClientRect?.();
    const width = Math.max(1, rect?.width || 160);
    const height = Math.max(1, rect?.height || 44);
    const maxLeft = Math.max(FLOATING_DEFAULT_OFFSET_PX, window.innerWidth - width - FLOATING_DEFAULT_OFFSET_PX);
    const maxTop = Math.max(FLOATING_DEFAULT_OFFSET_PX, window.innerHeight - height - FLOATING_DEFAULT_OFFSET_PX);
    return {
      left: Math.min(Math.max(FLOATING_DEFAULT_OFFSET_PX, left), maxLeft),
      top: Math.min(Math.max(FLOATING_DEFAULT_OFFSET_PX, top), maxTop)
    };
  }

  function setFloatingElementPosition(el, left, top) {
    if (!(el instanceof HTMLElement)) return;
    const next = clampFloatingPosition(left, top, el);
    floatingUiPosition.left = next.left;
    floatingUiPosition.top = next.top;
    el.style.left = `${next.left}px`;
    el.style.top = `${next.top}px`;
    el.style.right = "auto";
    el.style.bottom = "auto";
  }

  function rememberFloatingElementPosition(el) {
    if (!(el instanceof HTMLElement)) return;
    const rect = el.getBoundingClientRect();
    setFloatingElementPosition(el, rect.left, rect.top);
  }

  function applySavedFloatingPosition(el) {
    if (!(el instanceof HTMLElement)) return;
    if (Number.isFinite(floatingUiPosition.left) && Number.isFinite(floatingUiPosition.top)) {
      setFloatingElementPosition(el, floatingUiPosition.left, floatingUiPosition.top);
      return;
    }
    el.style.top = `${FLOATING_DEFAULT_OFFSET_PX}px`;
    el.style.right = `${FLOATING_DEFAULT_OFFSET_PX}px`;
    el.style.left = "auto";
    el.style.bottom = "auto";
  }

  function makeFloatingElementDraggable(el, handle, options = {}) {
    if (!(el instanceof HTMLElement) || !handle) return;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;
    let moved = false;

    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      if (options.ignore?.(event)) return;
      const rect = el.getBoundingClientRect();
      startX = event.clientX;
      startY = event.clientY;
      startLeft = rect.left;
      startTop = rect.top;
      moved = false;
      handle.setPointerCapture?.(event.pointerId);

      const onPointerMove = (moveEvent) => {
        const dx = moveEvent.clientX - startX;
        const dy = moveEvent.clientY - startY;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
        setFloatingElementPosition(el, startLeft + dx, startTop + dy);
        moveEvent.preventDefault();
      };

      const onPointerUp = (upEvent) => {
        handle.releasePointerCapture?.(event.pointerId);
        document.removeEventListener("pointermove", onPointerMove, true);
        document.removeEventListener("pointerup", onPointerUp, true);
        document.removeEventListener("pointercancel", onPointerUp, true);
        if (!moved && typeof options.onClick === "function") options.onClick(upEvent);
      };

      document.addEventListener("pointermove", onPointerMove, true);
      document.addEventListener("pointerup", onPointerUp, true);
      document.addEventListener("pointercancel", onPointerUp, true);
      event.preventDefault();
    });
  }

  if (!global.__floatingBarUi) {
    global.__floatingBarUi = {
      applyHostLayout,
      applyRestoreChipLayout,
      getFloatingBarTemplate,
      applySavedFloatingPosition,
      rememberFloatingElementPosition,
      makeFloatingElementDraggable,
      setFloatingElementPosition
    };
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
