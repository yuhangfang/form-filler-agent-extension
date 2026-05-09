/**
 * Playwright MCP–compatible browser helpers for extension content scripts.
 *
 * Snapshot YAML is built by src/browser-capture/aria-snapshot/* (aligned with refs/playwright injected ariaSnapshot.ts
 * + domUtils + roleUtils). This file owns ref allocation, optional highlights, and tool dispatch.
 *
 * Script load order: see src/browser-capture/browser-tools-inject-chain.js and manifest.json.
 */
(function initBrowserTools() {
  const NS = globalThis.__formFillerAriaSnapshot;
  if (!NS || typeof NS.createBuildAriaYamlSnapshot !== "function") {
    throw new Error(
      "browser-tools: load aria-snapshot chain first (string-utils → … → aria-snapshot.js). See browser-tools-inject-chain.js."
    );
  }

  let refCounter = 0;
  /** @type {Map<string, Element>} */
  const refToElement = new Map();

  function resetRefs() {
    refCounter = 0;
    refToElement.clear();
  }

  const HL_ROOT_ID = "__formFillerAriaSnapshotHighlightRoot";

  function clearAriaSnapshotHighlights() {
    document.getElementById(HL_ROOT_ID)?.remove();
  }

  /** Playwright-style blue outlines over ref targets (extension-only; MCP string has [box=…] when boxes). */
  function applyAriaSnapshotHighlights() {
    clearAriaSnapshotHighlights();
    if (!refToElement.size) return;
    const root = document.createElement("div");
    root.id = HL_ROOT_ID;
    root.setAttribute("aria-hidden", "true");
    root.style.cssText =
      "position:fixed;inset:0;pointer-events:none;z-index:2147483646;margin:0;padding:0;";
    for (const [, hel] of refToElement) {
      if (!(hel instanceof Element)) continue;
      if (NS.subtreeBlocked(hel)) continue;
      const r = hel.getBoundingClientRect?.();
      if (!r || (r.width === 0 && r.height === 0)) continue;
      const b = document.createElement("div");
      b.style.cssText = `position:fixed;left:${Math.round(r.left)}px;top:${Math.round(
        r.top
      )}px;width:${Math.round(r.width)}px;height:${Math.round(
        r.height
      )}px;outline:2px solid rgba(66,133,244,0.95);outline-offset:-1px;box-sizing:border-box;border-radius:2px;`;
      root.appendChild(b);
    }
    document.documentElement.appendChild(root);
    window.setTimeout(() => clearAriaSnapshotHighlights(), 2600);
  }

  function allocRef(el) {
    refCounter += 1;
    const id = `e${refCounter}`;
    refToElement.set(id, el);
    return id;
  }

  const buildAriaYamlSnapshot = NS.createBuildAriaYamlSnapshot({
    allocRef,
    resetRefState: resetRefs,
    clearAriaSnapshotHighlights,
    applyAriaSnapshotHighlights
  });

  /** @param {string} target */
  function resolveTarget(target) {
    const t = String(target || "").trim();
    const refMatch = /^(?:ref=)?(e\d+)$/i.exec(t);
    if (refMatch) {
      const el = refToElement.get(refMatch[1].toLowerCase());
      if (el) return el;
    }
    if (/^e\d+$/i.test(t)) {
      const el = refToElement.get(t.toLowerCase());
      if (el) return el;
    }
    try {
      return document.querySelector(t);
    } catch {
      return null;
    }
  }

  function scrollIntoViewMaybe(el) {
    try {
      el.scrollIntoView?.({ block: "center", inline: "nearest" });
    } catch {
      /* ignore */
    }
  }

  function normalizeText(input) {
    return String(input || "").toLowerCase().replace(/\s+/g, " ").trim();
  }

  function isVisibleElement(el) {
    if (!(el instanceof Element)) return false;
    const r = el.getBoundingClientRect?.();
    if (!r || r.width < 2 || r.height < 2) return false;
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
  }

  function setNativeValue(input, value) {
    const proto = input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const nativeSetter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (nativeSetter) nativeSetter.call(input, value);
    else input.value = value;
  }

  function dispatchTextCommit(input, value) {
    try {
      input.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, data: value, inputType: "insertText" }));
    } catch {
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    input.dispatchEvent(new Event("change", { bubbles: true }));
    try { input.dispatchEvent(new Event("blur", { bubbles: true })); } catch {}
  }

  function fillTextControl(control, value) {
    if (!(control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement)) {
      return { ok: false, reason: "not_text_control" };
    }
    if (control.disabled || control.readOnly) return { ok: false, reason: "not_actionable" };
    const text = String(value ?? "");
    scrollIntoViewMaybe(control);
    control.focus();
    setNativeValue(control, text);
    dispatchTextCommit(control, text);
    return { ok: true };
  }

  function monthNumber(month) {
    const months = {
      "1": "01", "01": "01", jan: "01", january: "01",
      "2": "02", "02": "02", feb: "02", february: "02",
      "3": "03", "03": "03", mar: "03", march: "03",
      "4": "04", "04": "04", apr: "04", april: "04",
      "5": "05", "05": "05", may: "05",
      "6": "06", "06": "06", jun: "06", june: "06",
      "7": "07", "07": "07", jul: "07", july: "07",
      "8": "08", "08": "08", aug: "08", august: "08",
      "9": "09", "09": "09", sep: "09", sept: "09", september: "09",
      "10": "10", oct: "10", october: "10",
      "11": "11", nov: "11", november: "11",
      "12": "12", dec: "12", december: "12"
    };
    return months[String(month || "").toLowerCase().replace(/\.$/, "")] || "";
  }

  function coerceSpinbuttonValue(input, value) {
    const raw = String(value ?? "").trim();
    if (!raw) return "";
    const label = normalizeText([
      input.getAttribute?.("aria-label"),
      input.getAttribute?.("name"),
      input.getAttribute?.("id")
    ].filter(Boolean).join(" "));
    if (/\byear\b|datesectionyear/i.test(label)) {
      return raw.match(/\b(19\d{2}|20\d{2})\b/)?.[1] || raw.replace(/\D/g, "").slice(0, 4);
    }
    if (/\bmonth\b|datesectionmonth/i.test(label)) {
      const numeric = raw.match(/\b(0?[1-9]|1[0-2])\s*(?:[\/.-]\s*(?:19|20)\d{2})?\b/)?.[1] || "";
      if (numeric) return numeric.padStart(2, "0");
      const named = raw.match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\b/i)?.[1] || "";
      return monthNumber(named);
    }
    return raw;
  }

  function fillSpinbutton(control, value) {
    if (!(control instanceof HTMLInputElement)) return { ok: false, reason: "not_input" };
    if (control.disabled || control.readOnly) return { ok: false, reason: "not_actionable" };
    const coercedValue = coerceSpinbuttonValue(control, value);
    if (!String(coercedValue || "").trim()) return { ok: false, reason: "empty_value" };
    scrollIntoViewMaybe(control);
    firePointerClick(control);
    control.focus();
    try { control.select(); } catch {}
    setNativeValue(control, "");
    control.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", code: "Backspace", keyCode: 8, bubbles: true }));
    let current = "";
    for (const char of String(coercedValue)) {
      current += char;
      setNativeValue(control, current);
      const keyCode = char.charCodeAt(0);
      control.dispatchEvent(new KeyboardEvent("keydown", { key: char, code: `Digit${char}`, keyCode, which: keyCode, bubbles: true }));
      try {
        control.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, data: char, inputType: "insertText" }));
      } catch {
        control.dispatchEvent(new Event("input", { bubbles: true }));
      }
      control.dispatchEvent(new KeyboardEvent("keyup", { key: char, code: `Digit${char}`, keyCode, which: keyCode, bubbles: true }));
    }
    control.dispatchEvent(new Event("change", { bubbles: true }));
    try { control.dispatchEvent(new Event("blur", { bubbles: true })); } catch {}
    return { ok: true, value: coercedValue };
  }

  function setChecked(control, checked = true) {
    const role = control instanceof Element ? String(control.getAttribute("role") || "").toLowerCase() : "";
    const isNative = control instanceof HTMLInputElement;
    const type = isNative ? (control.type || "").toLowerCase() : role;
    if (type !== "checkbox" && type !== "radio") return { ok: false, reason: "not_checkable" };
    if ((isNative && control.disabled) || control.getAttribute?.("aria-disabled") === "true") return { ok: false, reason: "not_actionable" };
    const want = !!checked;
    const ariaMatches = () => String(control.getAttribute?.("aria-checked") || "").toLowerCase() === String(want);
    if (isNative && (control.checked === want || ariaMatches())) return { ok: true, skipped: true };
    if (!isNative && String(control.getAttribute("aria-checked") || "").toLowerCase() === String(want)) {
      return { ok: true, skipped: true };
    }
    scrollIntoViewMaybe(control);
    try { control.focus(); } catch {}
    firePointerClick(control);
    if (isNative) {
      if (control.checked !== want) control.checked = want;
    }
    control.dispatchEvent(new Event("input", { bubbles: true }));
    control.dispatchEvent(new Event("change", { bubbles: true }));
    if (isNative) return { ok: control.checked === want || ariaMatches() };
    return {
      ok: String(control.getAttribute("aria-checked") || "").toLowerCase() === String(want),
      reason: "aria_state_not_committed"
    };
  }

  function radioLabel(control) {
    const direct = control.labels?.[0]?.textContent || "";
    if (String(direct).trim()) return String(direct).trim();
    return String(control.closest("label")?.textContent || "").trim();
  }

  function selectRadioOption(control, desired) {
    if (!(control instanceof HTMLInputElement)) return { ok: false, reason: "not_input" };
    const name = (control.name || "").trim();
    const form = control.form || control.closest("form") || document;
    const radios = Array.from(form.querySelectorAll("input[type='radio']")).filter((r) => !name || (r.name || "").trim() === name);
    const want = normalizeText(desired);
    if (!want) return { ok: false, reason: "empty_value" };
    for (const radio of radios) {
      const optionText = normalizeText(`${radio.value || ""} ${radioLabel(radio)}`.trim());
      if (
        optionText &&
        (
          optionText === want ||
          optionText.includes(want) ||
          (optionText.length >= 3 && want.includes(optionText))
        )
      ) {
        return setChecked(radio, true);
      }
    }
    return { ok: false, reason: "no_radio_match" };
  }

  function isPlaceholderOptionText(text) {
    const t = normalizeText(text);
    if (!t) return true;
    if (/^(select|choose|please select|please choose|pick one|pick an option|\-\-+|—|n\/a)$/i.test(t)) return true;
    return /^(select|choose)\b/.test(t) && /\b(one|option|value|answer)\b/.test(t);
  }

  function optionScore(option, desired) {
    const d = normalizeText(desired);
    const dDigits = d.replace(/\D/g, "");
    const value = String(option.value || "").trim();
    const label = String(option.textContent || "").trim();
    const vNorm = normalizeText(value);
    const lNorm = normalizeText(label);
    if ((!d && !dDigits) || option.disabled) return 0;
    if (isPlaceholderOptionText(label) && !value) return 0;
    let score = 0;
    if (vNorm && vNorm === d) score = 100;
    else if (lNorm && lNorm === d) score = 100;
    else if (vNorm && d.includes(vNorm) && vNorm.length >= 3) score = 72;
    else if (vNorm && vNorm.includes(d) && d.length >= 3) score = 68;
    else if (lNorm && (lNorm.includes(d) || d.includes(lNorm)) && Math.min(lNorm.length, d.length) >= 4) {
      score = 55;
    }
    if (dDigits.length >= 7) {
      const optDigits = `${value}${label}`.replace(/\D/g, "");
      if (optDigits.includes(dDigits) || dDigits.includes(optDigits)) score = Math.max(score, 85);
    }
    return score;
  }

  function selectNativeOption(select, desired, opts = {}) {
    if (!(select instanceof HTMLSelectElement)) return { ok: false, reason: "not_select" };
    if (select.disabled) return { ok: false, reason: "not_actionable" };
    const minScore = Number(opts.minScore || 55);
    let bestIdx = -1;
    let bestScore = 0;
    for (let i = 0; i < select.options.length; i += 1) {
      const score = optionScore(select.options[i], desired);
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    if (bestIdx < 0 || bestScore < minScore) return { ok: false, reason: "no_option_match", score: bestScore };
    scrollIntoViewMaybe(select);
    select.focus();
    select.selectedIndex = bestIdx;
    for (let i = 0; i < select.options.length; i += 1) select.options[i].selected = i === bestIdx;
    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
    try {
      select.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      select.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
      select.dispatchEvent(new Event("blur", { bubbles: true }));
    } catch {}
    const option = select.options[bestIdx];
    return { ok: true, score: bestScore, value: option?.value || "", label: option?.textContent?.trim() || "" };
  }

  function firePointerClick(el) {
    try { el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); } catch {}
    try { el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); } catch {}
    try { el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })); } catch {}
    try { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); } catch {}
    try { el.click(); } catch {}
  }

  function resolveByToken(locator) {
    const raw = String(locator || "").trim();
    if (!raw) return null;
    try {
      const direct = refToElement.get(raw) || refToElement.get(raw.toLowerCase());
      if (direct instanceof Element) return direct;
    } catch {}
    let esc = raw;
    try { esc = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(raw) : raw; } catch {}
    const selectors = [
      `[data-automation-id="${esc}"]`, `[data-automation-id^="${esc}"]`, `[data-automation-id*="${esc}"]`,
      `[data-qa="${esc}"]`, `[data-qa^="${esc}"]`, `[data-qa*="${esc}"]`,
      `[data-testid="${esc}"]`, `[data-testid^="${esc}"]`, `[data-testid*="${esc}"]`,
      `[data-field-name="${esc}"]`, `[data-field-name^="${esc}"]`, `[data-field-name*="${esc}"]`,
      `#${esc}`, `[id="${esc}"]`, `[id^="${esc}"]`, `[id*="${esc}"]`,
      `[name="${esc}"]`, `[name^="${esc}"]`, `[name*="${esc}"]`
    ];
    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel);
        if (el) return el;
      } catch {}
    }
    const token = normalizeText(raw).replace(/[-_]+/g, " ").trim();
    let best = null;
    let bestScore = 0;
    for (const el of Array.from(document.querySelectorAll('[role="combobox"], [aria-haspopup="listbox"], [data-automation-id], [data-qa], [data-testid], [data-field-name], input, button'))) {
      if (!isVisibleElement(el)) continue;
      const bag = normalizeText([
        el.getAttribute?.("data-automation-id"),
        el.getAttribute?.("data-qa"),
        el.getAttribute?.("data-testid"),
        el.getAttribute?.("data-field-name"),
        el.getAttribute?.("id"),
        el.getAttribute?.("name"),
        el.getAttribute?.("aria-label"),
        el.textContent,
        el.closest?.("[data-automation-id], [data-qa], [data-testid], [id], [class]")?.textContent
      ].filter(Boolean).join(" "));
      let score = 0;
      if (token && bag.includes(token)) score += 4;
      if (token && token.split(" ").every((part) => part && bag.includes(part))) score += 2;
      if (bag.includes("question")) score += 1;
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }
    return bestScore > 0 ? best : null;
  }

  function isTriggerLike(el) {
    return el instanceof Element && (
      el.matches('[role="combobox"], button[aria-haspopup], [role="button"][aria-haspopup], [aria-haspopup="listbox"], input[aria-autocomplete], input[role="combobox"], button, input') ||
      !!el.querySelector?.('[role="combobox"], button[aria-haspopup], [role="button"][aria-haspopup], [aria-haspopup="listbox"], input[aria-autocomplete], input[role="combobox"]')
    );
  }

  function findDropdownTrigger(wrapper, locator) {
    if (!wrapper) return null;
    if (wrapper instanceof Element && wrapper.matches('[role="combobox"], button[aria-haspopup], [role="button"][aria-haspopup], [aria-haspopup="listbox"], input[aria-autocomplete], input[role="combobox"], button, input')) {
      return wrapper;
    }
    const direct = wrapper.querySelector?.('[role="combobox"], button[aria-haspopup], [role="button"][aria-haspopup], [aria-haspopup="listbox"], input[aria-autocomplete], input[role="combobox"], button, input');
    if (direct) return direct;
    const container = wrapper.closest?.('[data-automation-id*="question" i], [id*="question" i], [class*="question" i], li, fieldset, section, form') || wrapper.parentElement;
    const near = container?.querySelector?.('[role="combobox"], button[aria-haspopup], [role="button"][aria-haspopup], [aria-haspopup="listbox"], input[aria-autocomplete], input[role="combobox"], button, input');
    if (near) return near;
    const token = normalizeText(locator).replace(/[-_]+/g, " ").trim();
    let best = null;
    let bestScore = 0;
    for (const candidate of Array.from(document.querySelectorAll('[role="combobox"], [aria-haspopup="listbox"], button, input'))) {
      if (!isTriggerLike(candidate) || !isVisibleElement(candidate)) continue;
      const bag = normalizeText([
        candidate.getAttribute?.("data-automation-id"),
        candidate.getAttribute?.("data-qa"),
        candidate.getAttribute?.("data-testid"),
        candidate.getAttribute?.("id"),
        candidate.getAttribute?.("name"),
        candidate.getAttribute?.("aria-label"),
        candidate.closest?.("[data-automation-id]")?.getAttribute?.("data-automation-id"),
        candidate.closest?.("[id]")?.getAttribute?.("id"),
        candidate.closest?.("[class]")?.getAttribute?.("class"),
        candidate.textContent
      ].filter(Boolean).join(" "));
      let score = 0;
      if (token && bag.includes(token)) score += 4;
      if (bag.includes("question")) score += 1;
      if (score > bestScore) {
        bestScore = score;
        best = candidate;
      }
    }
    return bestScore > 0 ? best : null;
  }

  function collectListboxes() {
    const surfaces = Array.from(document.querySelectorAll(
      [
        '[role="listbox"]',
        '[data-automation-id="dropdownPanel"]',
        '[data-automation-id*="popup" i]',
        '[data-automation-id*="prompt" i]',
        '[data-automation-id*="menu" i]',
        '[id*="listbox" i]',
        '[id*="popup" i]',
        '[class*="listbox" i]',
        '[class*="dropdown" i]',
        '[class*="popup" i]',
        '[class*="popover" i]',
        '[class*="menu" i]'
      ].join(", ")
    ));
    for (const opt of Array.from(document.querySelectorAll('[role="option"], [data-automation-id="promptOption"], [data-automation-id*="promptOption" i], [data-value]'))) {
      const surface = opt.closest?.('[role="listbox"], [data-automation-id="dropdownPanel"], [data-automation-id*="popup" i], [data-automation-id*="prompt" i], [data-automation-id*="menu" i], [id*="listbox" i], [id*="popup" i], [class*="listbox" i], [class*="dropdown" i], [class*="popup" i], [class*="popover" i], [class*="menu" i]') || opt.parentElement || opt;
      surfaces.push(surface);
    }
    const seen = new Set();
    return surfaces.filter((el) => {
      if (!(el instanceof Element) || seen.has(el)) return false;
      seen.add(el);
      if (!isVisibleElement(el)) return false;
      const r = el.getBoundingClientRect();
      return r.width >= 8 && r.height >= 8;
    });
  }

  function findListboxForTrigger(trigger) {
    if (!(trigger instanceof Element)) return null;
    const controlledId = trigger.getAttribute("aria-controls") || trigger.getAttribute("aria-owns") || "";
    if (controlledId) {
      const direct = document.getElementById(controlledId);
      if (direct && isVisibleElement(direct)) return direct;
    }
    const localContainer = trigger.closest('[data-automation-id], [data-qa], [data-testid], [data-field-name], [id], [class*="question" i], li, fieldset, section');
    const local = localContainer?.querySelector?.('[role="listbox"], [data-automation-id="dropdownPanel"], [data-automation-id*="popup" i], [data-automation-id*="prompt" i], [data-automation-id*="menu" i], [id*="listbox" i], [id*="popup" i], [class*="listbox" i], [class*="dropdown" i], [class*="popup" i], [class*="popover" i], [class*="menu" i]');
    if (local && isVisibleElement(local)) return local;
    const tr = trigger.getBoundingClientRect();
    const tx = tr.left + tr.width / 2;
    const ty = tr.top + tr.height / 2;
    let best = null;
    let bestDist = Number.POSITIVE_INFINITY;
    for (const box of collectListboxes()) {
      const r = box.getBoundingClientRect();
      const dist = Math.hypot((r.left + r.width / 2) - tx, (r.top + r.height / 2) - ty);
      if (dist < bestDist) {
        bestDist = dist;
        best = box;
      }
    }
    return best;
  }

  const GENERIC_OPTION_WORDS = new Set(["university", "college", "school", "institute", "of", "the", "and", "for", "at", "in"]);
  function meaningfulTokens(text) {
    return String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").split(/\s+/).filter((t) => t.length >= 3 && !GENERIC_OPTION_WORDS.has(t));
  }

  function normalizeDropdownComparable(text) {
    return normalizeText(text)
      .replace(/\bbachelors\b/g, "bachelor")
      .replace(/\bmasters\b/g, "master")
      .replace(/\bdoctorate\b/g, "phd")
      .replace(/\bdoctor of philosophy\b/g, "phd")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  function isPreferNotAnswerText(text) {
    const s = normalizeDropdownComparable(text);
    return /\b(prefer not|rather not|choose not|do not wish|don t wish|decline|not disclose|not answer|no answer|self identify|self identification)\b/.test(s);
  }

  function dropdownOptionScore(opt, desiredNorm) {
    const text = normalizeText(opt?.textContent || "");
    const val = normalizeText(opt?.getAttribute?.("data-value") || opt?.getAttribute?.("value") || "");
    const aria = normalizeText(opt?.getAttribute?.("aria-label") || "");
    const textCompact = normalizeDropdownComparable(text);
    const desiredCompact = normalizeDropdownComparable(desiredNorm);
    const desiredTokens = meaningfulTokens(desiredNorm);
    let best = -1;
    for (const h of [text, val, aria, textCompact].filter(Boolean)) {
      const comparable = normalizeDropdownComparable(h);
      let score = 0;
      if (comparable === desiredCompact) score = 100;
      else if (isPreferNotAnswerText(desiredNorm) && isPreferNotAnswerText(comparable)) score = 92;
      else if (comparable.startsWith(desiredCompact) || desiredCompact.startsWith(comparable)) score = 88;
      else if (comparable.includes(desiredCompact) || desiredCompact.includes(comparable)) score = 74;
      else if (/\bbachelor\b/.test(desiredCompact) && /\bbachelor\b/.test(comparable)) score = 70;
      else if (/\bmaster\b/.test(desiredCompact) && /\bmaster\b/.test(comparable)) score = 70;
      else if (/\b(phd|ph d)\b/.test(desiredCompact) && /\b(phd|ph d)\b/.test(comparable)) score = 70;
      else {
        const hw = comparable.split(/\s+/).filter((w) => w.length > 2);
        const dw = new Set(desiredCompact.split(/\s+/).filter((w) => w.length > 2));
        let overlap = 0;
        for (const w of hw) if (dw.has(w)) overlap += 1;
        const minOverlap = desiredTokens.length >= 2 ? 2 : 1;
        if (overlap >= minOverlap) score = 40 + overlap * 8;
      }
      if (score > 0 && desiredTokens.length) {
        const hTok = new Set(meaningfulTokens(comparable));
        if (!desiredTokens.some((t) => hTok.has(t))) score = 0;
      }
      if (score > 0) score -= Math.min(20, Math.max(0, h.length - desiredCompact.length) / 6);
      if (score > best) best = score;
    }
    return best;
  }

  function findBestDropdownOption(listbox, desiredNorm) {
    const opts = [
      ...(listbox.matches?.('[role="option"], [data-automation-id="promptOption"], [data-automation-id*="promptOption" i], [data-value]') ? [listbox] : []),
      ...Array.from(listbox.querySelectorAll('[role="option"], [data-automation-id="promptOption"], [data-automation-id*="promptOption" i], [data-value], li, button, div, span'))
    ]
      .filter((el) => {
        if (!isVisibleElement(el)) return false;
        const text = normalizeText(el.textContent || "");
        return text && !/no results|loading|type to search|select\.\.\./i.test(text);
      });
    let best = null;
    let bestScore = -1;
    for (const opt of opts) {
      const score = dropdownOptionScore(opt, desiredNorm);
      if (score > bestScore) {
        bestScore = score;
        best = opt;
      }
    }
    return bestScore >= 45 ? best : null;
  }

  function dropdownSearchQueries(value) {
    const raw = String(value || "").trim();
    const comparable = normalizeDropdownComparable(raw);
    const tokens = comparable.split(/\s+/).filter((t) => t.length >= 3 && !GENERIC_OPTION_WORDS.has(t));
    const queries = [raw];
    const commaParts = raw.split(",").map((p) => p.trim()).filter(Boolean);
    // Location-style values often arrive as full addresses; prioritize city/state queries first.
    if (commaParts.length >= 2) {
      const city = commaParts[1] || "";
      const stateZip = commaParts[2] || "";
      const stateMatch = stateZip.match(/\b([A-Za-z]{2})\b/);
      const state = stateMatch ? stateMatch[1].toUpperCase() : "";
      if (city) {
        queries.push(city);
        if (state) {
          queries.push(`${city}, ${state}`);
          queries.push(`${city} ${state}`);
        }
      }
    }
    const cityStateInline = raw.match(/\b([A-Za-z][A-Za-z.'-]*(?:\s+[A-Za-z][A-Za-z.'-]*)*)\s*,\s*([A-Za-z]{2})\b/);
    if (cityStateInline) {
      const city = String(cityStateInline[1] || "").trim();
      const state = String(cityStateInline[2] || "").trim().toUpperCase();
      if (city) {
        queries.push(city);
        if (state) {
          queries.push(`${city}, ${state}`);
          queries.push(`${city} ${state}`);
        }
      }
    }
    if (tokens.length >= 2) {
      queries.push(tokens.slice(0, 2).join(" "));
      queries.push(tokens.slice(-2).join(" "));
    }
    for (const token of tokens) queries.push(token);
    if (/\bcomputer\b/.test(comparable) && /\b(engineering|science)\b/.test(comparable)) {
      queries.push(comparable.match(/\bcomputer\s+(?:engineering|science)\b/)?.[0] || "");
    }
    if (/\bbachelor\b/.test(comparable)) queries.push("bachelor", "bachelors");
    if (/\bmaster\b/.test(comparable)) queries.push("master", "masters");
    return Array.from(new Set(queries.map((q) => q.trim()).filter(Boolean)));
  }

  async function findBestDropdownOptionAfterSearch(trigger, wrapper, box, desiredNorm, query, log, opts = {}) {
    const searchInput = trigger.matches("input, textarea")
      ? trigger
      : box.querySelector("input, textarea") || wrapper.querySelector("input, textarea");
    const beforeTexts = new Set(
      Array.from(box.querySelectorAll('[role="option"], [data-automation-id="promptOption"], li, button, div, span'))
        .map((el) => normalizeText(el.textContent || ""))
        .filter(Boolean)
    );
    if (searchInput && await clearAndTypeSearch(searchInput, query)) {
      log.steps.push(`typed:search text "${query}"`);
      await submitSearchInput(searchInput, log);
      const optionChangeTimeoutMs = Math.max(1400, Math.min(12000, Number(opts.optionChangeTimeoutMs || 5200)));
      const minSettledMs = Math.max(120, Math.min(1200, Number(opts.minSettledMs || 420)));
      await waitForDropdownOptionsToChange(trigger, box, beforeTexts, optionChangeTimeoutMs, { minSettledMs });
      if (isDropdownCommitted(trigger, wrapper, desiredNorm) || hasAnyDropdownValue(trigger, wrapper)) {
        log.steps.push("confirm:ok after search");
        return { alreadyCommitted: true };
      }
    }
    let currentBox = findListboxForTrigger(trigger) || box;
    let matched = null;
    const postSearchPollMs = Math.max(1500, Math.min(12000, Number(opts.postSearchPollMs || 5200)));
    const pollIntervalMs = Math.max(120, Math.min(400, Number(opts.pollIntervalMs || 220)));
    const pollDeadline = Date.now() + postSearchPollMs;
    while (!matched && Date.now() < pollDeadline) {
      currentBox = findListboxForTrigger(trigger) || currentBox;
      matched = findBestDropdownOption(currentBox, desiredNorm);
      if (!matched) await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
    if (matched) return { option: matched };
    const afterOptions = Array.from(currentBox.querySelectorAll('[role="option"], [data-automation-id="promptOption"], [data-value], li, button, div, span'))
      .filter((el) => isVisibleElement(el))
      .filter((el) => {
        const text = normalizeText(el.textContent || "");
        return text && !beforeTexts.has(text) && !/no results|loading|type to search|select\.\.\./i.test(text);
      });
    let best = null;
    let bestScore = -1;
    for (const opt of afterOptions) {
      const score = dropdownOptionScore(opt, desiredNorm);
      if (score > bestScore) {
        bestScore = score;
        best = opt;
      }
    }
    if (best && bestScore >= 35) {
      log.steps.push(`option:closest after "${query}" score=${Math.round(bestScore)}`);
      return { option: best };
    }
    return null;
  }

  async function submitSearchInput(input, log) {
    if (!(input instanceof HTMLElement)) return;
    try { input.dispatchEvent(new Event("search", { bubbles: true })); } catch {}
    try {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
      input.dispatchEvent(new KeyboardEvent("keypress", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
      input.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
      log?.steps?.push?.("pressed:enter search");
    } catch {}
  }

  async function waitForDropdownOptionsToChange(trigger, box, beforeTexts, timeoutMs, opts = {}) {
    const deadline = Date.now() + timeoutMs;
    const minSettledMs = Math.max(120, Math.min(1200, Number(opts.minSettledMs || 420)));
    let firstReadyAt = 0;
    while (Date.now() < deadline) {
      const currentBox = findListboxForTrigger(trigger) || box;
      const allTexts = Array.from(currentBox.querySelectorAll('[role="option"], [data-automation-id="promptOption"], li, button, div, span'))
        .map((el) => normalizeText(el.textContent || ""))
        .filter(Boolean);
      const hasLoadingSignal = allTexts.some((text) => /loading|searching|fetching|please wait|finding|results found/i.test(text));
      const texts = allTexts.filter((text) => !/no results|loading|searching|fetching|please wait|type to search|select\.\.\./i.test(text));
      const changed = texts.some((text) => !beforeTexts.has(text)) || (texts.length && texts.length !== beforeTexts.size);
      if (changed && !hasLoadingSignal) {
        if (!firstReadyAt) firstReadyAt = Date.now();
        if (Date.now() - firstReadyAt >= minSettledMs) return true;
      } else {
        firstReadyAt = 0;
      }
      await new Promise((r) => setTimeout(r, 120));
    }
    return false;
  }

  function optionActivationTarget(option) {
    if (!(option instanceof Element)) return option;
    const checkable = option.querySelector('input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"]');
    if (checkable && isVisibleElement(checkable)) return checkable;
    return (
      option.querySelector('[role="button"], button, label') ||
      option
    );
  }

  async function clearAndTypeSearch(input, text) {
    if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement)) return false;
    input.focus();
    input.select?.();
    setNativeValue(input, "");
    try {
      input.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, inputType: "deleteContentBackward" }));
    } catch {
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    input.dispatchEvent(new Event("change", { bubbles: true }));
    let current = "";
    for (const char of String(text || "")) {
      current += char;
      const keyCode = char.charCodeAt(0);
      input.dispatchEvent(new KeyboardEvent("keydown", { key: char, keyCode, which: keyCode, bubbles: true }));
      setNativeValue(input, current);
      try {
        input.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, data: char, inputType: "insertText" }));
      } catch {
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
      input.dispatchEvent(new KeyboardEvent("keyup", { key: char, keyCode, which: keyCode, bubbles: true }));
      await new Promise((r) => setTimeout(r, 8));
    }
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  function isDropdownCommitted(trigger, wrapper, desiredNorm) {
    const triggerText = normalizeText(trigger?.textContent || "");
    if (triggerText && (triggerText === desiredNorm || triggerText.includes(desiredNorm) || desiredNorm.includes(triggerText))) return true;
    const triggerValue = normalizeText(trigger?.value || "");
    if (triggerValue && (triggerValue === desiredNorm || triggerValue.includes(desiredNorm) || desiredNorm.includes(triggerValue))) return true;
    const localContainer = trigger?.closest?.('[data-automation-id], [data-qa], [data-testid], [data-field-name], [id], [class*="question" i], li, fieldset, section') || wrapper;
    const localVals = Array.from(localContainer?.querySelectorAll?.("input, select, textarea") || [])
      .map((el) => normalizeText(el.value || el.selectedOptions?.[0]?.textContent || ""))
      .filter(Boolean)
      .join(" ");
    if (localVals && (localVals.includes(desiredNorm) || desiredNorm.includes(localVals))) return true;
    const selected = wrapper?.querySelector("[aria-selected='true'], [data-selected='true'], [aria-checked='true']");
    const selectedText = normalizeText(selected?.textContent || "");
    return !!selectedText && (selectedText === desiredNorm || selectedText.includes(desiredNorm) || desiredNorm.includes(selectedText));
  }

  function hasAnyDropdownValue(trigger, wrapper) {
    const triggerText = normalizeText(trigger?.value || trigger?.textContent || "");
    if (triggerText && !/^(select|choose|type to search|loading)$/.test(triggerText)) return true;
    const localContainer = trigger?.closest?.('[data-automation-id], [data-qa], [data-testid], [data-field-name], [id], [class*="question" i], li, fieldset, section') || wrapper;
    return Array.from(localContainer?.querySelectorAll?.("input, select, textarea") || [])
      .some((el) => {
        const value = normalizeText(el.value || el.selectedOptions?.[0]?.textContent || "");
        return value && !/^(select|choose|type to search|loading)$/.test(value);
      });
  }

  async function closeDropdown(trigger, listbox) {
    const sendKey = (target, key) => {
      try {
        target?.dispatchEvent?.(new KeyboardEvent("keydown", { key, code: key, bubbles: true, cancelable: true }));
        target?.dispatchEvent?.(new KeyboardEvent("keyup", { key, code: key, bubbles: true, cancelable: true }));
      } catch {}
    };
    const clickOutside = () => {
      try {
        const point = { clientX: 4, clientY: 4, bubbles: true, cancelable: true };
        document.body?.dispatchEvent?.(new PointerEvent("pointerdown", point));
        document.body?.dispatchEvent?.(new MouseEvent("mousedown", point));
        document.body?.dispatchEvent?.(new MouseEvent("mouseup", point));
        document.body?.dispatchEvent?.(new MouseEvent("click", point));
      } catch {
        try { document.body?.click?.(); } catch {}
      }
    };
    const waitClosed = async (ms) => {
      await new Promise((r) => setTimeout(r, ms));
      return !(listbox && isVisibleElement(listbox)) && !findListboxForTrigger(trigger);
    };

    sendKey(document.activeElement, "Escape");
    sendKey(trigger, "Escape");
    sendKey(document, "Escape");
    if (await waitClosed(120)) return true;

    try { document.activeElement?.blur?.(); } catch {}
    clickOutside();
    if (await waitClosed(180)) return true;

    sendKey(trigger, "Tab");
    if (await waitClosed(180)) return true;

    // Some radio-listbox widgets keep the menu open until the trigger is toggled closed.
    try {
      if (findListboxForTrigger(trigger)) firePointerClick(trigger);
    } catch {}
    return waitClosed(220);
  }

  async function detectDropdownLikeInput(control, opts = {}) {
    if (!(control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement)) {
      return { ok: false, reason: "not_text_control" };
    }
    if (!isVisibleElement(control) || control.disabled || control.readOnly) {
      return { ok: false, reason: "not_actionable" };
    }
    const role = String(control.getAttribute("role") || "").toLowerCase();
    const attrs = String(
      [
        control.getAttribute("aria-haspopup"),
        control.getAttribute("aria-autocomplete"),
        control.getAttribute("aria-expanded"),
        control.getAttribute("aria-controls"),
        control.getAttribute("aria-owns"),
        control.getAttribute("autocomplete"),
        control.getAttribute("placeholder"),
        control.getAttribute("name"),
        control.getAttribute("id"),
        control.getAttribute("aria-label"),
        opts?.context || ""
      ]
        .filter(Boolean)
        .join(" ")
    ).toLowerCase();
    if (role === "combobox" || /\blistbox\b/.test(attrs)) {
      return { ok: true, reason: "structural_aria" };
    }
    if (/\b(select|dropdown|type to search|results found|location|city|state|country)\b/.test(attrs)) {
      // Keep probing to avoid false positives, but treat this as strong prior.
    }

    scrollIntoViewMaybe(control);
    const before = findListboxForTrigger(control);
    if (before && isVisibleElement(before)) {
      return { ok: true, reason: "existing_listbox" };
    }

    const waitMs = Math.max(200, Math.min(1600, Number(opts?.timeoutMs || 700)));
    const start = Date.now();
    try { control.focus(); } catch {}
    try {
      control.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", code: "ArrowDown", keyCode: 40, which: 40, bubbles: true, cancelable: true }));
      control.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowDown", code: "ArrowDown", keyCode: 40, which: 40, bubbles: true, cancelable: true }));
    } catch {}
    firePointerClick(control);
    while (Date.now() - start < waitMs) {
      const box = findListboxForTrigger(control);
      if (box && isVisibleElement(box)) {
        await closeDropdown(control, box);
        return { ok: true, reason: "opened_listbox" };
      }
      await new Promise((r) => setTimeout(r, 40));
    }
    try { control.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true })); } catch {}
    try { control.dispatchEvent(new KeyboardEvent("keyup", { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true })); } catch {}
    return { ok: false, reason: "no_dropdown_surface" };
  }

  async function selectCustomDropdown(guess) {
    const locator = String(guess?.autoId || guess?.ref || guess?.label || guess?.target || "").trim();
    const value = String(guess?.value || "").trim();
    const log = { autoId: locator, value, steps: [] };
    if (!locator || !value) return { ok: false, log: { ...log, steps: ["skip:missing locator/value"] } };
    const wrapper = (guess?.element instanceof Element ? guess.element : null) ||
      resolveByToken(guess?.autoId) ||
      resolveByToken(guess?.ref) ||
      resolveByToken(guess?.label) ||
      resolveByToken(guess?.target);
    if (!wrapper) return { ok: false, log: { ...log, steps: ["wrapper:not found"] } };
    const trigger = findDropdownTrigger(wrapper, locator);
    if (!trigger || !isVisibleElement(trigger)) return { ok: false, log: { ...log, steps: ["trigger:not found"] } };
    scrollIntoViewMaybe(trigger);
    const desiredNorm = normalizeText(value);
    const maxWaitMs = Math.max(2000, Math.min(20000, Number(guess?.maxWaitMs || 10000)));
    const openWaitSliceMs = Math.max(220, Math.min(1100, Number(guess?.openWaitSliceMs || 520)));
    const pollIntervalMs = Math.max(80, Math.min(320, Number(guess?.pollIntervalMs || 160)));
    const searchOptionChangeTimeoutMs = Math.max(1400, Math.min(12000, Number(guess?.searchOptionChangeTimeoutMs || 5200)));
    const postSearchPollMs = Math.max(1500, Math.min(12000, Number(guess?.postSearchPollMs || 5200)));
    const minSettledMs = Math.max(120, Math.min(1200, Number(guess?.minSettledMs || 420)));
    const deadline = Date.now() + maxWaitMs;
    let ok = false;
    for (let attempt = 0; Date.now() < deadline && !ok; attempt += 1) {
      log.steps.push(`open:attempt ${attempt + 1}`);
      firePointerClick(trigger);
      const openStart = Date.now();
      let box = null;
      while (Date.now() - openStart < openWaitSliceMs) {
        box = findListboxForTrigger(trigger);
        if (box) break;
        await new Promise((r) => setTimeout(r, pollIntervalMs));
      }
      if (!box) {
        try {
          trigger.focus();
          trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
          trigger.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowDown", bubbles: true }));
        } catch {}
        const keyStart = Date.now();
        while (Date.now() - keyStart < Math.max(180, Math.floor(openWaitSliceMs / 2))) {
          box = findListboxForTrigger(trigger);
          if (box) break;
          await new Promise((r) => setTimeout(r, pollIntervalMs));
        }
      }
      if (!box) {
        log.steps.push("listbox:not found");
        continue;
      }
      const searchInput = trigger.matches("input, textarea")
        ? trigger
        : box.querySelector("input, textarea") || wrapper.querySelector("input, textarea");
      let matched = null;
      const queries = searchInput ? dropdownSearchQueries(value) : [value];
      for (const query of queries) {
        const searchResult = await findBestDropdownOptionAfterSearch(
          trigger,
          wrapper,
          findListboxForTrigger(trigger) || box,
          desiredNorm,
          query,
          log,
          {
            optionChangeTimeoutMs: searchOptionChangeTimeoutMs,
            postSearchPollMs,
            pollIntervalMs,
            minSettledMs
          }
        );
        if (searchResult?.alreadyCommitted) {
          ok = true;
          break;
        }
        matched = searchResult?.option || null;
        if (matched) break;
        if (Date.now() >= deadline) break;
      }
      if (ok) break;
      if (!matched) {
        const fallback = (findListboxForTrigger(trigger) || box).querySelector('[aria-selected="true"], [data-highlighted], [class*="highlight" i], [class*="active" i]');
        const fbText = normalizeText(fallback?.textContent || "");
        if (fbText && (fbText === desiredNorm || fbText.includes(desiredNorm) || desiredNorm.includes(fbText) || fbText.split(/\s+/).some((w) => w.length >= 4 && desiredNorm.includes(w)))) {
          matched = fallback;
          log.steps.push("option:fallback highlighted");
        }
      }
      if (!matched) {
        log.steps.push("option:not matched");
        try { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); } catch {}
        await new Promise((r) => setTimeout(r, 80));
        continue;
      }
      log.steps.push(`option:matched "${(matched.textContent || "").trim().slice(0, 80)}"`);
      firePointerClick(optionActivationTarget(matched));
      await new Promise((r) => setTimeout(r, 180));
      const targetChecked =
        matched instanceof Element &&
        !!matched.querySelector?.('input[type="radio"]:checked, input[type="checkbox"]:checked, [aria-checked="true"], [aria-selected="true"]');
      try {
        trigger.focus();
        trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        trigger.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
        trigger.dispatchEvent(new Event("blur", { bubbles: true }));
      } catch {}
      const committedBeforeClose = isDropdownCommitted(trigger, wrapper, desiredNorm);
      const closed = await closeDropdown(trigger, box);
      log.steps.push(closed ? "dropdown:closed" : "dropdown:still-open");
      await new Promise((r) => setTimeout(r, 220));
      const committed = committedBeforeClose || isDropdownCommitted(trigger, wrapper, desiredNorm);
      const anyCommitted = hasAnyDropdownValue(trigger, wrapper);
      ok = committed || anyCommitted || targetChecked;
      log.steps.push(committed ? "confirm:ok" : targetChecked ? "confirm:ok (option checked)" : anyCommitted ? "confirm:ok (value set)" : "confirm:failed");
    }
    return { ok, log };
  }

  async function selectCustomDropdownBatch(guesses) {
    let applied = 0;
    const logs = [];
    for (const guess of Array.isArray(guesses) ? guesses : []) {
      const result = await selectCustomDropdown(guess);
      if (result.ok) applied += 1;
      logs.push(result.log);
    }
    return { applied, logs };
  }

  async function collectVisibleDropdownOptions(locator) {
    const wrapper = resolveByToken(locator);
    const trigger = findDropdownTrigger(wrapper, locator);
    if (!(trigger instanceof HTMLElement)) return [];
    firePointerClick(trigger);
    await new Promise((r) => setTimeout(r, 120));
    const box = findListboxForTrigger(trigger);
    if (!box) return [];
    const out = [];
    for (const el of Array.from(box.querySelectorAll('[role="option"], [data-automation-id="promptOption"], li, button, div, span'))) {
      const text = String(el.textContent || "").replace(/\s+/g, " ").trim();
      if (!text || /no results|loading|type to search|select\.\.\./i.test(text)) continue;
      out.push(text);
      if (out.length >= 30) break;
    }
    return out;
  }

  function fillControl(control, spec = {}) {
    if (!(control instanceof Element)) return { ok: false, reason: "not_element" };
    const typeHint = String(spec.type || spec.kind || "").toLowerCase();
    const value = spec.value;
    const role = String(control.getAttribute?.("role") || "").toLowerCase();

    if (typeHint === "checkbox" || role === "checkbox" || (control instanceof HTMLInputElement && control.type === "checkbox")) {
      const checked = value === undefined || value === null || value === ""
        ? true
        : value === true || value === "true" || value === "1" || /^(yes|checked|on)$/i.test(String(value).trim());
      return setChecked(control, checked);
    }

    if (typeHint === "radio" || role === "radio" || (control instanceof HTMLInputElement && control.type === "radio")) {
      if (control instanceof HTMLInputElement && control.type === "radio") {
        return value ? selectRadioOption(control, value) : setChecked(control, true);
      }
      return setChecked(control, true);
    }

    if (control instanceof HTMLSelectElement) {
      return selectNativeOption(control, value, spec);
    }

    if (typeHint === "combobox" || role === "combobox" || control.getAttribute?.("aria-haspopup") === "listbox") {
      return selectCustomDropdown({ element: control, target: spec.target, autoId: spec.autoId, label: spec.label, value });
    }

    if (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement) {
      const inputType = control instanceof HTMLInputElement ? (control.type || "text").toLowerCase() : "text";
      if (typeHint === "slider" || inputType === "range") {
        if (!(control instanceof HTMLInputElement) || control.disabled || control.readOnly) return { ok: false, reason: "not_actionable" };
        control.value = String(value ?? "");
        control.dispatchEvent(new Event("input", { bubbles: true }));
        control.dispatchEvent(new Event("change", { bubbles: true }));
        return { ok: true };
      }
      if (role === "spinbutton" || inputType === "number") return fillSpinbutton(control, value);
      return fillTextControl(control, value);
    }

    return { ok: false, reason: "unsupported_control" };
  }

  const browserActions = {
    resolveTarget,
    scrollIntoView: scrollIntoViewMaybe,
    click: (target) => {
      const el = target instanceof Element ? target : resolveTarget(String(target || ""));
      if (!(el instanceof HTMLElement)) return { ok: false, reason: "not_found" };
      scrollIntoViewMaybe(el);
      firePointerClick(el);
      return { ok: true };
    },
    fillText: fillTextControl,
    fillSpinbutton,
    setChecked,
    selectRadioOption,
    selectNativeOption,
    detectDropdownLikeInput,
    selectCustomDropdown,
    selectCustomDropdownBatch,
    collectVisibleDropdownOptions,
    fillControl
  };

  async function toolSnapshot(payload) {
    const target = payload?.target;
    let root = document;
    if (target) {
      const el = resolveTarget(String(target));
      if (!el) return { ok: false, error: `Target not found: ${target}` };
      root = el;
    }
    const { yaml } = buildAriaYamlSnapshot(root, {
      depth: payload?.depth,
      boxes: payload?.boxes,
      highlightRefs: !!payload?.highlightRefs
    });
    return {
      ok: true,
      snapshot: yaml,
      pageUrl: location.href,
      title: document.title,
      highlightApplied: !!payload?.highlightRefs,
      console: { errors: 0, warnings: 0 }
    };
  }

  async function toolClick(payload) {
    const target = payload?.target;
    if (!target) return { ok: false, error: "Missing target" };
    const el = resolveTarget(String(target));
    if (!el) return { ok: false, error: `Element not found for target: ${target}` };
    scrollIntoViewMaybe(el);
    const clickEl = /** @type {HTMLElement} */ (el);
    clickEl.click?.();
    return { ok: true };
  }

  async function toolFillForm(payload) {
    const fields = payload?.fields;
    if (!Array.isArray(fields) || !fields.length) return { ok: false, error: "fields array required" };
    const results = [];
    for (const f of fields) {
      const tgt = f?.target;
      const typ = f?.type || "textbox";
      let value = f?.value;
      const el = resolveTarget(String(tgt || ""));
      if (!el) {
        results.push({ target: tgt, ok: false, error: "not found" });
        continue;
      }
      scrollIntoViewMaybe(el);
      try {
        const filled = await browserActions.fillControl(el, { type: typ, target: String(tgt || ""), value });
        if (!filled.ok) throw new Error(filled.reason || filled.log?.steps?.slice(-1)[0] || "fill failed");
        results.push({ target: tgt, ok: true });
      } catch (e) {
        results.push({
          target: tgt,
          ok: false,
          error: e instanceof Error ? e.message : "fill failed"
        });
      }
    }
    const failed = results.filter((r) => !r.ok);
    return { ok: !failed.length, results, error: failed.length ? `${failed.length} field(s) failed` : undefined };
  }

  async function toolEvaluate(payload) {
    const src = payload?.function;
    if (!src || typeof src !== "string") return { ok: false, error: "function string required" };
    const target = payload?.target;
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    try {
      let result;
      if (target) {
        const el = resolveTarget(String(target));
        if (!el) return { ok: false, error: `Target not found for evaluate: ${target}` };
        const fn = new AsyncFunction("element", `return await (${src})(element);`);
        result = await fn(el);
      } else {
        const fn = new AsyncFunction(`return await (${src})();`);
        result = await fn();
      }
      return { ok: true, result };
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : String(e)
      };
    }
  }

  async function toolWaitFor(payload) {
    const timeSec = payload?.time;
    const text = payload?.text;
    const textGone = payload?.textGone;

    if (typeof timeSec === "number" && timeSec > 0) {
      await new Promise((r) => setTimeout(r, timeSec * 1000));
      return { ok: true };
    }

    const deadline = Date.now() + 30000;
    const bodyText = () => document.body?.innerText || "";

    if (text) {
      while (Date.now() < deadline) {
        if (bodyText().includes(text)) return { ok: true };
        await new Promise((r) => setTimeout(r, 100));
      }
      return { ok: false, error: `Timeout waiting for text: ${text}` };
    }

    if (textGone) {
      while (Date.now() < deadline) {
        if (!bodyText().includes(textGone)) return { ok: true };
        await new Promise((r) => setTimeout(r, 100));
      }
      return { ok: false, error: `Timeout waiting for text gone: ${textGone}` };
    }

    return { ok: false, error: "Provide time, text, or textGone" };
  }

  async function toolFileUpload(payload) {
    const target = payload?.target;
    const paths = payload?.paths;
    const filesPayload = payload?.files;
    const el = resolveTarget(String(target || ""));
    if (!el || !(el instanceof HTMLInputElement) || el.type !== "file") {
      return { ok: false, error: "Target must be a file input (use snapshot ref or selector)" };
    }

    /** @type {File[]} */
    const fileList = [];

    if (Array.isArray(filesPayload)) {
      for (const item of filesPayload) {
        const name = item?.name || "upload.bin";
        const mime = item?.type || "application/octet-stream";
        const b64 = item?.base64;
        if (!b64) continue;
        const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        fileList.push(new File([bin], name, { type: mime }));
      }
    } else if (Array.isArray(paths)) {
      for (const p of paths) {
        const s = String(p);
        if (s.startsWith("chrome-extension://")) {
          try {
            const res = await fetch(s);
            const blob = await res.blob();
            const name = s.split("/").pop() || "file";
            fileList.push(new File([blob], name, { type: blob.type || "application/octet-stream" }));
          } catch (e) {
            return {
              ok: false,
              error: `Could not fetch extension URL: ${e instanceof Error ? e.message : s}`
            };
          }
        } else {
          return {
            ok: false,
            error:
              "Only chrome-extension:// paths or payload.files[{name,type,base64}] are supported in the extension (no raw filesystem paths)."
          };
        }
      }
    }

    if (!fileList.length) return { ok: false, error: "No files resolved" };

    const dt = new DataTransfer();
    for (const f of fileList) dt.items.add(f);
    el.files = dt.files;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, count: fileList.length };
  }

  const TOOLS = {
    browser_snapshot: toolSnapshot,
    browser_click: toolClick,
    browser_fill_form: toolFillForm,
    browser_evaluate: toolEvaluate,
    browser_wait_for: toolWaitFor,
    browser_file_upload: toolFileUpload
  };

  /**
   * @param {{ tool: string, payload?: object }} msg
   */
  globalThis.__dispatchBrowserTool = async function (msg) {
    const tool = msg?.tool;
    const payload = msg?.payload || {};
    const fn = TOOLS[tool];
    if (!fn) return { ok: false, error: `Unknown tool: ${tool}` };
    return fn(payload);
  };

  globalThis.__browserToolRefs = refToElement;
  globalThis.__formFillerBrowserActions = browserActions;
})();
