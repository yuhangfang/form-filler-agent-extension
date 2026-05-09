const { getParsedFieldScan } = globalThis.ScanResultAdapters || {
  getParsedFieldScan: (source) => source?.scan?.parsedFieldScan || source?.scan?.parsed_field_scan || null
};

function isWeakControlCaption(text) {
  const t = String(text || "").replace(/\s+/g, " ").trim().toLowerCase();
  if (!t || t.length < 8) return true;
  if (/^(select|choose|open|browse|search|add|clear|show\s+menu|menu)\b/.test(t)) return true;
  if (/^(yes|no|ok|cancel|submit|next|back)\b$/i.test(t)) return true;
  return false;
}

function displayLabelForField(field) {
  const primary = String(
    field?.field_label ||
      field?.label ||
      field?.question ||
      field?.helpText ||
      field?.help_text ||
      ""
  )
    .replace(/\s+/g, " ")
    .trim();
  if (primary) return primary;

  const section = String(field?.section || "")
    .replace(/\s+/g, " ")
    .trim();
  const name = String(field?.name || "")
    .replace(/\s+/g, " ")
    .trim();
  const context = String(field?.context || "")
    .replace(/\s+/g, " ")
    .trim();
  const id = String(field?.id || field?.elementId || "")
    .replace(/\s+/g, " ")
    .trim();

  const caption =
    !isWeakControlCaption(name) ? name : context.length > name.length + 8 ? context : name || context;

  if (section && caption) {
    const s = section.toLowerCase();
    const c = caption.toLowerCase();
    if (s.includes(c) || c.includes(s)) return section.length >= caption.length ? section : caption;
    return `${section} — ${caption}`;
  }
  if (section) return section;
  return caption || id || "";
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "BROWSER_TOOL_RUN") {
    try {
      if (window.top !== window) return false;
    } catch {
      return false;
    }
    const run = globalThis.__dispatchBrowserTool;
    if (typeof run !== "function") {
      sendResponse({ ok: false, error: "browser-tools / aria-snapshot chain not loaded in this frame." });
      return true;
    }
    Promise.resolve(run({ tool: message.tool, payload: message.payload || {} }))
      .then((result) => sendResponse(result))
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : "browser tool failed"
        })
      );
    return true;
  }

  if (message?.type === "RUN_FILL") {
    try {
      const run = globalThis.__runDeterministicFill;
      if (typeof run !== "function") {
        sendResponse({
          ok: false,
          error: "Fill engine not loaded in this frame."
        });
      } else {
        Promise.resolve(run(message.profile || {}))
          .then((result) => sendResponse({ ok: true, result }))
          .catch((error) =>
            sendResponse({
              ok: false,
              error: error instanceof Error ? error.message : "Unknown fill error"
            })
          );
      }
    } catch (error) {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : "Unknown fill error"
      });
    }
    return true;
  }
  if (message?.type === "FLOATING_BAR_PROGRESS") {
    // Content scripts run in all frames; tabs.sendMessage delivers to each listener — only the top
    // frame owns the floating bar / status UI (and console spam would repeat once per iframe).
    try {
      if (window.top !== window) {
        sendResponse?.({ ok: true });
        return true;
      }
    } catch {
      sendResponse?.({ ok: true });
      return true;
    }
    const shadowRoot = document.documentElement
      ?.querySelector("#form-filler-floating-root")
      ?.shadowRoot;
    const status = shadowRoot?.getElementById("ffStatus");
    const isLlmDebugProgress = message?.phase === "field_llm_debug";
    // Keep verbose LLM diagnostics in DevTools only; don't replace the floating status line.
    if (status && !isLlmDebugProgress) status.textContent = String(message.text || "");
    if (message?.phase === "field_trace" && message?.text) {
      try {
        console.log(String(message.text));
      } catch {
        /* ignore */
      }
    }
    if (isLlmDebugProgress && message?.text) {
      try {
        console.log(String(message.text));
      } catch {
        /* ignore */
      }
    }
    if (message.field && typeof globalThis.__floatingBarShowFillProgress === "function") {
      globalThis.__floatingBarShowFillProgress(message);
    }
    const bar = shadowRoot?.querySelector(".bar");
    if (bar) {
      const text = String(message.text || "");
      const textLower = text.toLowerCase();
      const phase = message?.phase;
      const isLlmActive =
        phase === "llm" ||
        /\bllm\b|sending\s+.*\s+to\s+llm|waiting\s+for\s+llm/i.test(textLower) ||
        /\basking\s+ai\b/i.test(textLower) ||
        /\bapplying\s+llm\b/i.test(textLower) ||
        /\bai\s+stream/i.test(textLower);
      bar.classList.toggle("ff-llm-active", isLlmActive);
    }
    sendResponse?.({ ok: true });
    return true;
  }
  if (message?.type === "PROFILE_FIELD_UPDATED") {
    const status = document.documentElement
      ?.querySelector("#form-filler-floating-root")
      ?.shadowRoot
      ?.getElementById("ffStatus");
    if (status) status.textContent = String(message.text || "Profile updated.");
    sendResponse?.({ ok: true });
    return true;
  }
  return false;
});

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

function runtimeSendMessageAsync(message) {
  return new Promise((resolve) => {
    let attempts = 0;
    const send = () => {
      try {
        chrome.runtime.sendMessage(message, (resp) => {
          const err = chrome.runtime.lastError;
          if (!err) {
            resolve(resp || { ok: false, error: "No response." });
            return;
          }

          const msg = err.message || "Runtime message failed.";
          const receiverMissing = /Receiving end does not exist/i.test(msg);
          // After extension update/reload, old content scripts often lose the receiver temporarily.
          // Retry a few times to let service worker wake/start.
          if (receiverMissing && attempts < 4) {
            attempts += 1;
            setTimeout(send, 120 * (attempts + 1));
            return;
          }

          resolve(receiverMissing
            ? {
              ok: false,
              error: "Connection lost after extension reload. Please refresh this page once, then try again."
            }
            : { ok: false, error: msg });
        });
      } catch (e) {
        resolve({ ok: false, error: e instanceof Error ? e.message : "Message failed." });
      }
    };

    if (!chrome?.runtime?.id || typeof chrome.runtime.sendMessage !== "function") {
      resolve({ ok: false, error: "Extension runtime unavailable." });
      return;
    }

    send();
  });
}

function prepareFillContextAsync(reason = "detected") {
  return runtimeSendMessageAsync({
    type: "FLOATING_BAR_PREPARE_CONTEXT",
    payload: { reason, url: location.href }
  });
}

function requestFloatingBarStopAsync(reason = "user_stop") {
  return runtimeSendMessageAsync({
    type: "FLOATING_BAR_STOP",
    payload: { reason, url: location.href }
  });
}

/**
 * Match background `getProfileForFill`: same storage merge as popup, then Quick Profile defaults
 * for any field the user left empty (same as popup placeholders — see profile-defaults.js).
 */
async function getProfileFromStorage() {
  try {
    const data = await chrome.storage.local.get(["profile.v1", "userContent.v1"]);
    const fromUser =
      data["userContent.v1"]?.profile && typeof data["userContent.v1"].profile === "object"
        ? data["userContent.v1"].profile
        : {};
    const direct = data["profile.v1"];
    const fromDirect = direct && typeof direct === "object" ? direct : {};
    const merged = normalizeProfileFromStorage({ ...fromUser, ...fromDirect });
    try {
      const url = chrome.runtime.getURL("src/applicant-data/profile-defaults.js");
      const { mergeProfileWithDefaults } = await import(url);
      if (typeof mergeProfileWithDefaults === "function") return mergeProfileWithDefaults(merged);
    } catch {
      /* dynamic import unavailable — fill without exemplar defaults */
    }
    return merged;
  } catch {
    return {};
  }
}

function normalizeProfileFromStorage(p) {
  if (!p || typeof p !== "object") return {};
  return { ...p, registerPassword: String(p.registerPassword || "") };
}

const FLOATING_ROOT_ID = "form-filler-floating-root";
const RESTORE_CHIP_ID = "form-filler-floating-restore";
const FIELD_PRESENCE_MESSAGE = "ADAPTIVE_FORM_FILLER_FIELD_PRESENCE";
const FRAME_FIELD_PRESENCE_TTL_MS = 6000;
const frameFieldPresence = new Map();
const pageFormTools = globalThis.__formFillerPageFormTools || {};
const floatingBarUi = globalThis.__floatingBarUi || {};

function controlLabelText(control) {
  if (typeof globalThis.__formFillerControlLabelText === "function") {
    return globalThis.__formFillerControlLabelText(control);
  }
  return "";
}

function pageHasFillableFormFields() {
  return typeof pageFormTools.pageHasFillableFormFields === "function"
    ? pageFormTools.pageHasFillableFormFields()
    : false;
}

function pageHasResumeUploadField() {
  return typeof pageFormTools.pageHasResumeUploadField === "function"
    ? pageFormTools.pageHasResumeUploadField()
    : false;
}

function isJobApplicationContext() {
  return typeof pageFormTools.isJobApplicationContext === "function"
    ? pageFormTools.isJobApplicationContext()
    : false;
}

function clearDetectedFormFields() {
  return typeof pageFormTools.clearDetectedFormFields === "function"
    ? pageFormTools.clearDetectedFormFields()
    : 0;
}

function setNativeInputValue(control, value) {
  if (typeof pageFormTools.setNativeInputValue === "function") {
    pageFormTools.setNativeInputValue(control, value);
  } else {
    control.value = value;
  }
}

function isTopFrame() {
  try {
    return window.top === window;
  } catch {
    return false;
  }
}

function removeFloatingBar() {
  document.getElementById(FLOATING_ROOT_ID)?.remove();
  document.getElementById(RESTORE_CHIP_ID)?.remove();
  _barHasScannedFields = false;
  _barFieldRefreshFn = null;
}

function rememberFloatingElementPosition(el) {
  floatingBarUi.rememberFloatingElementPosition?.(el);
}

function applySavedFloatingPosition(el) {
  floatingBarUi.applySavedFloatingPosition?.(el);
}

function makeFloatingElementDraggable(el, handle, options = {}) {
  floatingBarUi.makeFloatingElementDraggable?.(el, handle, options);
}

function hasRecentFrameFields() {
  const now = Date.now();
  for (const [token, state] of frameFieldPresence) {
    if (!state || now - state.lastSeen > FRAME_FIELD_PRESENCE_TTL_MS) {
      frameFieldPresence.delete(token);
      continue;
    }
    if (state.hasFields) return true;
  }
  return false;
}

function shouldShowFloatingBar() {
  if (!isJobApplicationContext()) return false;
  return pageHasFillableFormFields() || hasRecentFrameFields() || pageHasResumeUploadField();
}

let _barFieldRefreshFn = null;
let _barHasScannedFields = false;
let _barRefreshThrottleTimer = null;

function triggerBarRefreshIfEmpty() {
  if (_barHasScannedFields || typeof _barFieldRefreshFn !== "function") return;
  if (_barRefreshThrottleTimer) return;
  _barRefreshThrottleTimer = setTimeout(() => {
    _barRefreshThrottleTimer = null;
    if (!_barHasScannedFields && typeof _barFieldRefreshFn === "function") {
      _barFieldRefreshFn();
    }
  }, 800);
}

let floatingPresenceTimer = null;
function scheduleFloatingBarVisibilityUpdate(delay = 120) {
  if (!isTopFrame()) return;
  if (floatingPresenceTimer) clearTimeout(floatingPresenceTimer);
  floatingPresenceTimer = setTimeout(() => {
    floatingPresenceTimer = null;
    if (shouldShowFloatingBar()) {
      const barWasUp = !!document.getElementById(FLOATING_ROOT_ID)?.shadowRoot?.getElementById("ffStatus");
      initFloatingBar();
      if (barWasUp) triggerBarRefreshIfEmpty();
    } else {
      removeFloatingBar();
    }
  }, delay);
}

const framePresenceToken = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
function reportFrameFieldPresence() {
  if (isTopFrame()) return;
  try {
    window.top?.postMessage(
      {
        source: "adaptive-form-filler",
        type: FIELD_PRESENCE_MESSAGE,
        token: framePresenceToken,
        hasFields: pageHasFillableFormFields()
      },
      "*"
    );
  } catch {
    // Cross-origin frame messaging can fail on restricted pages.
  }
}

function initFieldPresenceWatcher() {
  if (isTopFrame()) {
    window.addEventListener(
      "message",
      (event) => {
        const data = event?.data;
        if (data?.source !== "adaptive-form-filler" || data?.type !== FIELD_PRESENCE_MESSAGE || !data.token) return;
        frameFieldPresence.set(String(data.token), {
          hasFields: !!data.hasFields,
          lastSeen: Date.now()
        });
        scheduleFloatingBarVisibilityUpdate(0);
      },
      true
    );

    const observer = new MutationObserver(() => scheduleFloatingBarVisibilityUpdate());
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        "aria-hidden",
        "aria-disabled",
        "disabled",
        "hidden",
        "role",
        "style",
        "type",
        "class"
      ]
    });
    scheduleFloatingBarVisibilityUpdate(0);
    setInterval(() => scheduleFloatingBarVisibilityUpdate(0), 2500);
    return;
  }

  const observer = new MutationObserver(() => {
    if (floatingPresenceTimer) clearTimeout(floatingPresenceTimer);
    floatingPresenceTimer = setTimeout(() => {
      floatingPresenceTimer = null;
      reportFrameFieldPresence();
    }, 120);
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["aria-hidden", "aria-disabled", "disabled", "hidden", "role", "style", "type", "class"]
  });
  reportFrameFieldPresence();
  setInterval(reportFrameFieldPresence, 2000);
}

function initFloatingBar() {
  try {
    if (window.top !== window) return;
  } catch {
    return;
  }
  if (!/^https?:/i.test(location.protocol)) return;
  const existing = document.getElementById(FLOATING_ROOT_ID);
  if (existing) {
    if (existing.shadowRoot?.getElementById("ffStatus")) return;
    existing.remove();
  }

  const host = document.createElement("div");
  host.id = FLOATING_ROOT_ID;
  floatingBarUi.applyHostLayout?.(host);
  applySavedFloatingPosition(host);
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = floatingBarUi.getFloatingBarTemplate?.() || "";
  document.documentElement.appendChild(host);

  // Restore/minimize UI
  function ensureRestoreChip() {
    let chip = document.getElementById(RESTORE_CHIP_ID);
    if (chip) return chip;
    chip = document.createElement("button");
    chip.id = RESTORE_CHIP_ID;
    chip.type = "button";
    chip.textContent = "Form filler";
    chip.setAttribute("aria-label", "Show Adaptive Form Filler bar");
    floatingBarUi.applyRestoreChipLayout?.(chip);
    applySavedFloatingPosition(chip);
    makeFloatingElementDraggable(chip, chip, {
      onClick: () => {
        rememberFloatingElementPosition(chip);
        chip.style.display = "none";
        const h = document.getElementById(FLOATING_ROOT_ID);
        if (h) {
          applySavedFloatingPosition(h);
          h.style.display = "";
        }
      }
    });
    chip.addEventListener("click", (event) => {
      event.preventDefault();
    });
    chip.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      rememberFloatingElementPosition(chip);
      chip.style.display = "none";
      const h = document.getElementById(FLOATING_ROOT_ID);
      if (h) {
        applySavedFloatingPosition(h);
        h.style.display = "";
      }
    });
    document.documentElement.appendChild(chip);
    return chip;
  }

  {
    const prevRestore = document.getElementById(RESTORE_CHIP_ID);
    if (prevRestore) prevRestore.style.display = "none";
  }

  const hideBtn = shadow.getElementById("ffHide");
  hideBtn?.addEventListener("click", () => {
    rememberFloatingElementPosition(host);
    host.style.display = "none";
    const chip = ensureRestoreChip();
    applySavedFloatingPosition(chip);
    chip.style.display = "block";
  });
  const titleRow = shadow.querySelector(".title-row");
  makeFloatingElementDraggable(host, titleRow, {
    ignore: (event) => event.target instanceof Element && !!event.target.closest("button")
  });

  const fillBtn = shadow.getElementById("ffFill");
  const aiToggleBtn = shadow.getElementById("ffAiToggle");
  const runnerBtn = shadow.getElementById("ffRunner");
  const clearBtn = shadow.getElementById("ffClear");
  const stopBtn = shadow.getElementById("ffStop");
  const prevBtn = shadow.getElementById("ffPrev");
  const nextBtn = shadow.getElementById("ffNext");
  const cardCountEl = shadow.getElementById("ffCardCount");
  const statusEl = shadow.getElementById("ffStatus");
  const scanOut = shadow.getElementById("ffScanOut");

  // Shared UI state
  const snapshotCards = { fields: /** @type {any[]} */ ([]), index: 0, title: "" };
  const fieldCardView = globalThis.ExtractedFieldCardsView || globalThis.WebsiteReaderLlmView || null;
  let locatedFieldEl = null;
  let locatedFieldPrevOutline = "";
  let locatedFieldResetTimer = null;
  let fillingHighlightEl = null;
  let fillingHighlightPrevOutline = "";
  let aiFallbackEnabled = true;
  let stopRequested = false;

  // Snapshot navigation and context display
  function clearScanPanel() {
    if (!scanOut) return;
    scanOut.textContent = "";
    scanOut.innerHTML = "";
  }

  function classifyFieldGroup(field) {
    return typeof fieldCardView?.classifyFieldGroup === "function"
      ? fieldCardView.classifyFieldGroup(field)
      : null;
  }

  function setCardNavState() {
    const total = snapshotCards.fields.length;
    if (prevBtn) prevBtn.disabled = total <= 1;
    if (nextBtn) nextBtn.disabled = total <= 1;
    if (cardCountEl) cardCountEl.textContent = "";
  }

  function snapshotFieldContext(field) {
    const label = displayLabelForField(field) || "Field";
    const type = String(field?.field_type || field?.type || "").trim();
    const context = String(
      field?.context ||
      field?.helpText ||
      field?.help_text ||
      field?.section ||
      field?.description ||
      ""
    ).replace(/\s+/g, " ").trim();
    return [
      label ? `Question: ${label}` : "",
      type ? `Type: ${type}` : "",
      context ? `Context: ${context.slice(0, 500)}` : ""
    ].filter(Boolean).join("\n");
  }

  function showSnapshotFieldContext() {
    if (!scanOut) return;
    clearScanPanel();
    const fields = snapshotCards.fields;
    if (!fields.length) {
      scanOut.textContent = "No fields were extracted.";
      scanOut.style.display = "block";
      statusEl.textContent = "No extracted fields yet.";
      setCardNavState();
      return;
    }
    const idx = Math.max(0, Math.min(snapshotCards.index, fields.length - 1));
    snapshotCards.index = idx;
    const f = fields[idx] || {};
    const question = displayLabelForField(f) || "Field";
    statusEl.textContent = `Field ${idx + 1} / ${fields.length}: ${question || "Field"}`;
    scanOut.textContent = "";
    scanOut.style.display = "none";
    setCardNavState();
    locateCurrentFieldInPage();
  }

  function hideSnapshotFieldContext() {
    if (!scanOut) return;
    clearScanPanel();
    scanOut.style.display = "none";
    setCardNavState();
  }

  async function refreshSnapshotFields() {
    setFloatingBarBusy(true);
    statusEl.textContent = "Loading snapshot fields...";
    const res = await runtimeSendMessageAsync({
      type: "FLOATING_BAR_FIELD_SCAN",
      payload: { snapshotOnly: true, includeChunked: false }
    });
    const snapshotParserScan = getParsedFieldScan(res);
    const fields = Array.isArray(snapshotParserScan?.domFields || snapshotParserScan?.dom_fields)
      ? (snapshotParserScan?.domFields || snapshotParserScan?.dom_fields)
      : [];
    snapshotCards.fields = fields;
    if (fields.length > 0) _barHasScannedFields = true;
    snapshotCards.index = 0;
    snapshotCards.title = String(res?.scan?.title || "");
    hideSnapshotFieldContext();
    statusEl.textContent = res?.ok
      ? (res.summary || `${fields.length} field(s) are found`)
      : (res?.error || "Failed to load fields.");
    setFloatingBarBusy(false);
  }

  function setFloatingBarBusy(busy) {
    fillBtn.disabled = busy;
    if (aiToggleBtn) aiToggleBtn.disabled = busy;
    if (runnerBtn) runnerBtn.disabled = busy;
    if (clearBtn) clearBtn.disabled = busy;
    if (stopBtn) stopBtn.disabled = !busy;
    if (prevBtn) prevBtn.disabled = busy || snapshotCards.fields.length <= 1;
    nextBtn.disabled = busy || snapshotCards.fields.length <= 1;
  }

  // Field locating and highlighting
  function clearLocatedFieldHighlight() {
    if (locatedFieldResetTimer) {
      clearTimeout(locatedFieldResetTimer);
      locatedFieldResetTimer = null;
    }
    if (locatedFieldEl instanceof HTMLElement) {
      locatedFieldEl.style.outline = locatedFieldPrevOutline;
      locatedFieldEl.style.outlineOffset = "";
    }
    locatedFieldEl = null;
    locatedFieldPrevOutline = "";
  }

  function locateCurrentFieldInPage() {
    const fields = snapshotCards.fields;
    const idx = Math.max(0, Math.min(snapshotCards.index, fields.length - 1));
    const current = fields[idx];
    if (!current) return false;
    const el = findFieldElement(current);
    if (!(el instanceof Element)) return false;
    clearLocatedFieldHighlight();
    el.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
    if (el instanceof HTMLElement) {
      locatedFieldEl = el;
      locatedFieldPrevOutline = el.style.outline || "";
      el.style.outline = "3px solid #22c55e";
      el.style.outlineOffset = "2px";
      locatedFieldResetTimer = setTimeout(() => {
        if (locatedFieldEl === el) clearLocatedFieldHighlight();
      }, 2200);
    }
    return true;
  }

  function clearFillingHighlight() {
    const restoreOutline = (value) => /#f59e0b|rgb\(\s*245\s*,\s*158\s*,\s*11\s*\)|orange/i.test(String(value || "")) ? "" : String(value || "");
    if (fillingHighlightEl instanceof HTMLElement) {
      fillingHighlightEl.style.outline = restoreOutline(fillingHighlightPrevOutline);
      fillingHighlightEl.style.outlineOffset = "";
      fillingHighlightEl.removeAttribute("data-form-filler-floating-highlight");
    }
    for (const highlighted of document.querySelectorAll("[data-form-filler-floating-highlight='true']")) {
      if (!(highlighted instanceof HTMLElement)) continue;
      highlighted.style.outline = restoreOutline(highlighted.getAttribute("data-form-filler-prev-outline"));
      highlighted.style.outlineOffset = highlighted.getAttribute("data-form-filler-prev-outline-offset") || "";
      highlighted.removeAttribute("data-form-filler-floating-highlight");
      highlighted.removeAttribute("data-form-filler-prev-outline");
      highlighted.removeAttribute("data-form-filler-prev-outline-offset");
    }
    fillingHighlightEl = null;
    fillingHighlightPrevOutline = "";
  }

  function setFillingHighlight(el) {
    clearFillingHighlight();
    if (!(el instanceof HTMLElement)) return;
    fillingHighlightEl = el;
    fillingHighlightPrevOutline = el.style.outline || "";
    el.setAttribute("data-form-filler-floating-highlight", "true");
    el.setAttribute("data-form-filler-prev-outline", fillingHighlightPrevOutline);
    el.setAttribute("data-form-filler-prev-outline-offset", el.style.outlineOffset || "");
    el.style.outline = "3px solid #f59e0b";
    el.style.outlineOffset = "2px";
  }

  function showFillProgress(progress) {
    if (scanOut) {
      clearScanPanel();
      scanOut.style.display = "none";
    }
    // Page-frame focus/highlight is handled by __focusFieldByFingerprint from the background.
    // Avoid applying a second outline here; otherwise cleanup can restore a stale orange outline.
    clearFillingHighlight();
  }

  // Snapshot field -> DOM element matching
  function findFieldElement(field) {
    const ref = String(field?.id || "").trim().toLowerCase();
    const label = String(field?.label || field?.field_label || "").trim().toLowerCase();
    const type = String(field?.type || field?.field_type || "").toLowerCase();
    const refMap = globalThis.__browserToolRefs;
    const candidates = Array.from(
      document.querySelectorAll(
        "input, textarea, select, button, [role='textbox'], [role='searchbox'], [role='combobox'], [role='listbox'], [role='spinbutton'], [role='checkbox'], [role='radio'], [role='switch'], [aria-haspopup='listbox']"
      )
    );
    const normalized = (text) => String(text || "").replace(/\s+/g, " ").trim().toLowerCase();
    const tokenSet = (text) =>
      new Set(
        normalized(text)
          .replace(/[^a-z0-9\s]/g, " ")
          .split(/\s+/)
          .filter((t) => t.length >= 3)
      );
    const labelTokens = tokenSet(label);
    const tokenOverlap = (a, b) => {
      let hit = 0;
      for (const t of a) if (b.has(t)) hit += 1;
      return hit;
    };
    const looksEquivalentLabel = (candidateText) => {
      const c = normalized(candidateText);
      if (!c) return false;
      if (c === label) return true;
      if (c.length >= 6 && label.length >= 6) {
        // Only allow candidate containing label (not the reverse),
        // otherwise short nav labels like "Resume" match long prompts.
        if (c.includes(label)) return true;
      }
      const cTokens = tokenSet(c);
      const overlap = tokenOverlap(labelTokens, cTokens);
      const minTokens = Math.min(labelTokens.size, cTokens.size);
      const minNeeded = minTokens <= 1 ? 1 : Math.max(2, Math.ceil(minTokens * 0.6));
      return overlap >= minNeeded;
    };
    const containsChoiceControls = (el) => {
      if (!(el instanceof Element)) return false;
      return !!el.querySelector(
        "input[type='radio'], input[type='checkbox'], [role='radio'], [role='checkbox']"
      );
    };
    const isUsableElement = (el) => {
      if (!(el instanceof Element) || !el.isConnected) return false;
      const rect = el.getBoundingClientRect?.();
      return !!rect && rect.width > 0 && rect.height > 0;
    };
    const isIgnoredContainer = (el) =>
      !!el.closest("nav, [role='navigation'], [role='menubar'], [role='tablist'], aside, header");
    const containsUploadControl = (el) => {
      if (!(el instanceof Element)) return false;
      const uploadText = normalized(el.textContent);
      return !!el.querySelector("input[type='file'], button, a, [role='button']") &&
        /\b(upload|attach|resume|cv|file|browse|drag\s*&?\s*drop)\b/i.test(uploadText);
    };
    const closestQuestionContainer = (el) => {
      let cur = el instanceof Element ? el : null;
      while (cur && cur !== document.documentElement) {
        if (
          /^(li|fieldset|section|article|div)$/i.test(cur.tagName) &&
          containsChoiceControls(cur)
        ) {
          return cur;
        }
        cur = cur.parentElement;
      }
      return el;
    };
    const closestUploadContainer = (el) => {
      let cur = el instanceof Element ? el : null;
      while (cur && cur !== document.documentElement) {
        if (
          /^(li|fieldset|section|article|div)$/i.test(cur.tagName) &&
          containsUploadControl(cur) &&
          (!label || looksEquivalentLabel(cur.textContent))
        ) {
          return cur;
        }
        cur = cur.parentElement;
      }
      return el;
    };
    // Try the snapshot ref first — it uniquely maps to the exact DOM element captured
    // during the field scan. Workday/React can rerender date widgets after scanning, so
    // only trust refs that still point at a connected, visible element.
    if (ref && refMap?.get) {
      const byRef = refMap.get(ref) || refMap.get(ref.toLowerCase());
      if (isUsableElement(byRef)) return type === "file" ? closestUploadContainer(byRef) : byRef;
    }
    const labelledByText = (el) => {
      const ids = String(el?.getAttribute?.("aria-labelledby") || "").split(/\s+/).filter(Boolean);
      return ids.map((id) => document.getElementById(id)?.textContent || "").join(" ");
    };
    const directLegendText = (el) => {
      if (!(el instanceof Element)) return "";
      const legend = el.querySelector?.(":scope > legend");
      return normalized(legend?.textContent || "");
    };
    const nearestDateScopeText = (el) => {
      let cur = el instanceof Element ? el : null;
      const pieces = [];
      while (cur && cur !== document.documentElement) {
        if (/^(FIELDSET|DIV|SECTION|LI)$/i.test(cur.tagName) || cur.getAttribute("role") === "group") {
          const text = normalized([
            directLegendText(cur),
            labelledByText(cur),
            cur.getAttribute("aria-label")
          ].filter(Boolean).join(" "));
          if (text) pieces.push(text);
        }
        cur = cur.parentElement;
      }
      return normalized(pieces.join(" "));
    };
    const findScopedDatePart = () => {
      const wantedPart = /\b(month|year)\b/i.exec(label)?.[1]?.toLowerCase() || "";
      const wantedScope = /\b(from|to|start|end|actual|expected)\b/i.exec(label)?.[1]?.toLowerCase() || "";
      if (!wantedPart || !wantedScope) return null;
      const scopeAliases =
        wantedScope === "from" || wantedScope === "start"
          ? ["from", "start", "begin"]
          : wantedScope === "to" || wantedScope === "end"
            ? ["to", "end"]
            : [wantedScope];
      for (const el of candidates) {
        if (!isUsableElement(el) || isIgnoredContainer(el)) continue;
        const aria = normalized(el.getAttribute("aria-label"));
        const role = normalized(el.getAttribute("role"));
        const inputType = normalized(el.getAttribute("type"));
        const partMatches = aria === wantedPart || el.id?.toLowerCase().includes(`datesection${wantedPart}`);
        const controlMatches =
          role === "spinbutton" ||
          inputType === "number" ||
          el instanceof HTMLInputElement;
        if (!partMatches || !controlMatches) continue;
        const scopeText = nearestDateScopeText(el);
        if (scopeAliases.some((scope) => new RegExp(`\\b${scope}\\b`, "i").test(scopeText))) return el;
      }
      return null;
    };
    const scopedDatePart = findScopedDatePart();
    if (scopedDatePart) return scopedDatePart;
    if (!label) return null;
    const findChoiceGroupContainer = () => {
      if (type !== "radio" && type !== "checkbox") return null;
      const groupCandidates = Array.from(
        document.querySelectorAll("li, fieldset, [role='group'], [role='radiogroup'], section, article, div")
      );
      let bestGroup = null;
      let bestGroupScore = -1;
      for (const el of groupCandidates) {
        if (!(el instanceof HTMLElement) || isIgnoredContainer(el) || !containsChoiceControls(el)) continue;
        const text = normalized(el.textContent);
        if (!text || !text.includes(label)) continue;
        const rect = el.getBoundingClientRect();
        const area = Math.max(1, rect.width * rect.height);
        // Prefer the smallest matching container so the highlight lands on the question block.
        const score = 100000000 / area;
        if (score > bestGroupScore) {
          bestGroupScore = score;
          bestGroup = el;
        }
      }
      return bestGroup;
    };
    const findUploadGroupContainer = () => {
      if (type !== "file") return null;
      const uploadCandidates = Array.from(document.querySelectorAll("li, fieldset, section, article, div"));
      let bestUpload = null;
      let bestUploadScore = -1;
      for (const el of uploadCandidates) {
        if (!(el instanceof HTMLElement) || isIgnoredContainer(el) || !containsUploadControl(el)) continue;
        const text = normalized(el.textContent);
        if (!text || (label && !looksEquivalentLabel(text))) continue;
        const rect = el.getBoundingClientRect();
        const area = Math.max(1, rect.width * rect.height);
        const score = 100000000 / area;
        if (score > bestUploadScore) {
          bestUploadScore = score;
          bestUpload = el;
        }
      }
      return bestUpload;
    };

    let best = null;
    let bestScore = -1;
    for (const el of candidates) {
      if (isIgnoredContainer(el)) continue;
      const aria = normalized(el.getAttribute("aria-label"));
      const ariaLabelledBy = normalized(labelledByText(el));
      const placeholder = normalized(el.getAttribute("placeholder"));
      const title = normalized(el.getAttribute("title"));
      const text = normalized(el.textContent);
      let score = 0;
      if (looksEquivalentLabel(aria)) score = Math.max(score, 100);
      if (looksEquivalentLabel(ariaLabelledBy)) score = Math.max(score, 115);
      if (looksEquivalentLabel(placeholder)) score = Math.max(score, 70);
      if (looksEquivalentLabel(title)) score = Math.max(score, 60);
      if (looksEquivalentLabel(text)) score = Math.max(score, 40);
      const id = el.getAttribute("id");
      if (id) {
        const labelEl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
        const labelText = normalized(labelEl?.textContent);
        if (looksEquivalentLabel(labelText)) score = Math.max(score, 120);
      }
      if (score > bestScore) {
        bestScore = score;
        best = type === "radio" || type === "checkbox"
          ? closestQuestionContainer(el)
          : type === "file"
            ? closestUploadContainer(el)
            : el;
      }
    }
    
    if (bestScore >= 40 && best) return best;
    
    const groupContainer = findChoiceGroupContainer();
    if (groupContainer) return groupContainer;
    const uploadContainer = findUploadGroupContainer();
    if (uploadContainer) return uploadContainer;
    
    return null;
  }

  // Button actions
  async function runClearAction() {
    setFloatingBarBusy(true);
    statusEl.textContent = "Clearing form fields...";
    clearLocatedFieldHighlight();
    clearFillingHighlight();
    const res = await runtimeSendMessageAsync({ type: "FLOATING_BAR_CLEAR" });
    const shouldFallback =
      !res?.ok &&
      /Connection lost|Receiving end does not exist|Unsupported action/i.test(String(res?.error || ""));
    const clearedCount = shouldFallback ? clearDetectedFormFields() : Number(res?.clearedCount || 0);
    statusEl.textContent = res?.ok || shouldFallback
      ? `Cleared ${clearedCount} field(s).`
      : (res?.error || "Clear failed.");
    await refreshSnapshotFields();
    setFloatingBarBusy(false);
  }

  async function runFillLocalFallback() {
    const profile = await getProfileFromStorage();
    try {
      const run = globalThis.__runDeterministicFill;
      if (typeof run !== "function") return { ok: false, error: "Local fill engine unavailable." };
      const result = await Promise.resolve(run(profile));
      const filledCount = Number(result?.filledCount || 0);
      return { ok: true, summary: `Filled ${filledCount} fields (local fallback).`, filledCount };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Local fallback failed." };
    }
  }

  async function runFillAction() {
    stopRequested = false;
    setFloatingBarBusy(true);
    try {
      statusEl.textContent = aiFallbackEnabled
        ? "Fill: field-by-field deterministic first, then AI fallback…"
        : "Fill: deterministic only. AI fallback is off…";
      const res = await runtimeSendMessageAsync({
        type: "FLOATING_BAR_FILL",
        payload: { aiFallbackEnabled }
      });
      const shouldFallback =
        !res?.ok &&
        /Connection lost|Receiving end does not exist/i.test(String(res?.error || ""));
      const finalRes = shouldFallback ? await runFillLocalFallback() : res;
      const baseSummary = finalRes?.ok
        ? (finalRes.summary || `Done. Filled ${finalRes.filledCount || 0}.`)
        : (finalRes?.error || "Action failed.");
      statusEl.textContent = baseSummary;
      await refreshSnapshotFields();
    } finally {
      setFloatingBarBusy(false);
    }
  }

  // Event wiring and startup
  function wirePrimaryActions() {
    fillBtn.addEventListener("click", () => void runFillAction());
    aiToggleBtn?.addEventListener("click", () => {
      aiFallbackEnabled = !aiFallbackEnabled;
      aiToggleBtn.textContent = aiFallbackEnabled ? "AI: On" : "AI: Off";
      aiToggleBtn.classList.toggle("toggle-off", !aiFallbackEnabled);
      aiToggleBtn.title = aiFallbackEnabled
        ? "AI fallback is enabled during Fill"
        : "AI fallback is disabled; Fill will use deterministic rules only";
      statusEl.textContent = aiFallbackEnabled
        ? "AI fallback enabled."
        : "AI fallback disabled. Fill will use deterministic rules only.";
    });
    runnerBtn?.addEventListener("click", async () => {
      const res = await runtimeSendMessageAsync({ type: "OPEN_EXPERIMENT_RUNNER" });
      statusEl.textContent = res?.ok
        ? "Opened Experiment Runner."
        : (res?.error || "Could not open Experiment Runner.");
    });
    clearBtn?.addEventListener("click", () => void runClearAction());
    stopBtn?.addEventListener("click", () => {
      stopRequested = true;
      statusEl.textContent = "Stopping...";
      void requestFloatingBarStopAsync();
    });
  }

  function wireSnapshotNavigation() {
    prevBtn?.addEventListener("click", () => {
      if (snapshotCards.fields.length <= 1) return;
      snapshotCards.index = (snapshotCards.index - 1 + snapshotCards.fields.length) % snapshotCards.fields.length;
      showSnapshotFieldContext();
    });
    nextBtn.addEventListener("click", () => {
      if (snapshotCards.fields.length <= 1) return;
      snapshotCards.index = (snapshotCards.index + 1) % snapshotCards.fields.length;
      showSnapshotFieldContext();
    });
  }

  function startFloatingBarDataLoads() {
    _barHasScannedFields = false;
    _barFieldRefreshFn = () => {
      if (document.getElementById(FLOATING_ROOT_ID)?.shadowRoot?.getElementById("ffStatus")) {
        void refreshSnapshotFields();
      }
    };
    void refreshSnapshotFields();
    void prepareFillContextAsync("floating_bar_visible");
  }

  globalThis.__floatingBarShowFillProgress = showFillProgress;
  globalThis.__floatingBarClearFillHighlight = clearFillingHighlight;
  wirePrimaryActions();
  wireSnapshotNavigation();
  startFloatingBarDataLoads();
}

initFieldPresenceWatcher();

globalThis.__initLargeTextboxAssist?.({
  runtimeSendMessageAsync,
  controlLabelText,
  setNativeInputValue
});

// Re-check on SPA route changes.
window.addEventListener("popstate", () => scheduleFloatingBarVisibilityUpdate(50), true);
window.addEventListener("hashchange", () => scheduleFloatingBarVisibilityUpdate(50), true);
