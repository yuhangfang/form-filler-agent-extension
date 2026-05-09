/**
 * Shared DOM control collection and write helpers.
 *
 * This module owns low-level page operations: finding controls, checking
 * actionability, matching native select options, and writing values through the
 * browser action layer. Higher-level mapping decisions stay in page-fill-engine.
 */
(function attachControlFillTools(global) {
  const fieldDescriptorTools = global.__formFillerFieldDescriptorTools;
  if (!fieldDescriptorTools) {
    throw new Error("control-fill-tools: load field-filling/field-descriptor-tools.js before control-fill-tools.js");
  }

  function normalize(input) {
    return String(input || "").toLowerCase().replace(/\s+/g, " ").trim();
  }

  function monthNumber(month) {
    const months = {
      "01": "01", "1": "01", "02": "02", "2": "02", "03": "03", "3": "03",
      "04": "04", "4": "04", "05": "05", "5": "05", "06": "06", "6": "06",
      "07": "07", "7": "07", "08": "08", "8": "08", "09": "09", "9": "09",
      "10": "10", "11": "11", "12": "12",
      jan: "01", january: "01", feb: "02", february: "02", mar: "03", march: "03",
      apr: "04", april: "04", may: "05", jun: "06", june: "06", jul: "07",
      july: "07", aug: "08", august: "08", sep: "09", sept: "09",
      september: "09", oct: "10", october: "10", nov: "11", november: "11",
      dec: "12", december: "12"
    };
    return months[String(month || "").toLowerCase().replace(/\.$/, "")] || "";
  }

  function collectFormControls(root) {
    const found = [];
    function walk(node) {
      if (!node) return;
      if (
        node instanceof HTMLInputElement ||
        node instanceof HTMLTextAreaElement ||
        node instanceof HTMLSelectElement
      ) {
        found.push(node);
      }
      if (node instanceof Element && node.shadowRoot) {
        walk(node.shadowRoot);
      }
      const children = node.childNodes;
      for (let i = 0; i < children.length; i += 1) {
        const c = children[i];
        if (c.nodeType === 1) walk(c);
      }
    }
    if (root instanceof Document) {
      walk(root.documentElement);
    } else {
      walk(root);
    }
    return found;
  }

  function sortElementsByVisualOrder(elements) {
    const scrollY = window.scrollY || 0;
    const scrollX = window.scrollX || 0;
    const withMeta = elements.map((el, idx) => {
      const r = el.getBoundingClientRect?.() || { top: 0, left: 0, width: 0, height: 0 };
      return {
        el,
        idx,
        top: Math.round(r.top + scrollY),
        left: Math.round(r.left + scrollX)
      };
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

  function ensureActionable(control) {
    if (!(control instanceof Element)) return false;
    const rect = control.getBoundingClientRect?.();
    const isVisible = !!rect && rect.width > 0 && rect.height > 0;
    const isEnabled =
      !(control instanceof HTMLInputElement || control instanceof HTMLSelectElement || control instanceof HTMLTextAreaElement) ||
      (!control.disabled && control.getAttribute("aria-disabled") !== "true");
    if (!isVisible || !isEnabled) return false;
    const style = getComputedStyle(control);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    return true;
  }

  function isVisibleForScrape(control) {
    if (!(control instanceof Element)) return false;
    if (!control.isConnected) return false;
    if (control.closest("[hidden], [aria-hidden='true']")) return false;
    const style = getComputedStyle(control);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    const rect = control.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return false;
    return true;
  }

  function tagFilledControlAfterWrite(control, writtenValue, trackSource) {
    if (!trackSource || !(control instanceof Element)) return;
    const fp = fieldDescriptorTools.computeFieldFingerprint(control);
    control.setAttribute("data-form-filler-fp", fp);
    control.setAttribute("data-form-filler-origin", String(writtenValue ?? ""));
    control.setAttribute("data-form-filler-source", String(trackSource));
    control.removeAttribute("data-form-filler-user-edited");
  }

  function isPlaceholderOptionText(text) {
    const t = normalize(text);
    if (!t) return true;
    if (
      /^(select|choose|please select|please choose|pick one|pick an option|\-\-+|—|n\/a)$/i.test(t)
    ) {
      return true;
    }
    if (/^(select|choose)\b/.test(t) && /\b(one|option|value|answer)\b/.test(t)) return true;
    return false;
  }

  function selectLooksUnfilled(select) {
    const opt = select.selectedOptions[0];
    if (!opt) return true;
    const rawValue = String(select.value || "").trim();
    if (!rawValue && select.selectedIndex <= 0) return true;
    if (isPlaceholderOptionText(opt.textContent) && isPlaceholderOptionText(opt.value)) return true;
    if (select.selectedIndex === 0 && isPlaceholderOptionText(opt.textContent)) return true;
    return false;
  }

  function pickBestOptionScoreResult(select, desired, minScore) {
    const threshold = minScore === undefined ? 55 : minScore;
    const d = normalize(String(desired));
    const dDigits = d.replace(/\D/g, "");
    if (!d && !dDigits) return { index: -1, score: 0 };

    let bestIdx = -1;
    let bestScore = 0;

    for (let i = 0; i < select.options.length; i += 1) {
      const opt = select.options[i];
      if (opt.disabled) continue;
      const vRaw = String(opt.value || "").trim();
      const tRaw = String(opt.textContent || "").trim();
      const vNorm = normalize(vRaw);
      const tNorm = normalize(tRaw);
      if (!vNorm && !tNorm) continue;
      if (isPlaceholderOptionText(tRaw) && !vRaw) continue;

      let score = 0;
      if (vNorm && vNorm === d) score = 100;
      else if (tNorm && tNorm === d) score = 100;
      else if (vNorm && d.includes(vNorm) && vNorm.length >= 3) score = 72;
      else if (vNorm && vNorm.includes(d) && d.length >= 3) score = 68;
      else if (tNorm && (tNorm.includes(d) || d.includes(tNorm)) && Math.min(tNorm.length, d.length) >= 4) {
        score = Math.max(score, 55);
      }

      if (dDigits.length >= 7) {
        const optDigits = `${vRaw}${tRaw}`.replace(/\D/g, "");
        if (optDigits.includes(dDigits) || dDigits.includes(optDigits)) {
          score = Math.max(score, 85);
        }
      }

      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }

    return { index: bestScore >= threshold ? bestIdx : -1, score: bestScore };
  }

  function pickBestOptionIndex(select, desired) {
    return pickBestOptionScoreResult(select, desired, 55).index;
  }

  function applySelectIndex(select, idx, trackSource) {
    if (idx < 0 || idx >= select.options.length) return false;
    if (!ensureActionable(select)) return false;
    select.focus();
    select.selectedIndex = idx;
    for (let i = 0; i < select.options.length; i += 1) {
      select.options[i].selected = i === idx;
    }
    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
    try {
      select.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      select.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
    } catch {}
    try {
      select.dispatchEvent(new Event("blur", { bubbles: true }));
    } catch {}
    if (trackSource) {
      const opt = select.options[idx];
      const written = `${opt?.value ?? ""}|${(opt?.textContent || "").trim()}`.slice(0, 200);
      tagFilledControlAfterWrite(select, written, trackSource);
    }
    return true;
  }

  function fillSelect(select, desiredText, trackSource) {
    const shared = globalThis.__formFillerBrowserActions;
    if (shared && typeof shared.fillControl === "function") {
      const result = shared.fillControl(select, { type: "select", value: desiredText });
      if (result?.ok) {
        if (trackSource) {
          const written = `${result.value ?? select.value ?? ""}|${result.label || select.selectedOptions?.[0]?.textContent?.trim() || ""}`.slice(0, 200);
          tagFilledControlAfterWrite(select, written, trackSource);
        }
        return true;
      }
    }
    if (shared && typeof shared.selectNativeOption === "function") {
      const result = shared.selectNativeOption(select, desiredText);
      if (result?.ok) {
        if (trackSource) {
          const written = `${result.value ?? ""}|${result.label || ""}`.slice(0, 200);
          tagFilledControlAfterWrite(select, written, trackSource);
        }
        return true;
      }
    }
    const idx = pickBestOptionIndex(select, desiredText);
    return applySelectIndex(select, idx, trackSource);
  }

  function fillSpinbutton(input, value, trackSource) {
    const shared = globalThis.__formFillerBrowserActions;
    const result = shared && typeof shared.fillControl === "function"
      ? shared.fillControl(input, { type: "spinbutton", value })
      : shared && typeof shared.fillSpinbutton === "function"
        ? shared.fillSpinbutton(input, value)
        : null;
    if (!result?.ok) return false;
    if (trackSource) tagFilledControlAfterWrite(input, result.value ?? value, trackSource);
    return true;
  }

  function coerceSpinbuttonValue(input, value) {
    const raw = String(value ?? "").trim();
    if (!raw) return "";
    const label = normalize([
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

  /** After a write, DOM value must match (loosely) — catches React clears, wrong node, masked UIs. */
  function textValueAppearsCommitted(input, expectedRaw) {
    if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement)) return true;
    const exp = normalize(expectedRaw);
    const got = normalize(input.value || "");
    if (!exp) return true;
    if (!got) return false;
    return got === exp || got.includes(exp) || exp.includes(got);
  }

  function fillInput(input, value, trackSource) {
    if (!ensureActionable(input)) return false;
    const elementRole = (input.getAttribute?.("role") || "").toLowerCase();
    const inputType = (input instanceof HTMLInputElement ? (input.type || "text") : "text").toLowerCase();
    if (elementRole === "spinbutton" || inputType === "number") {
      return fillSpinbutton(input, value, trackSource);
    }
    const shared = globalThis.__formFillerBrowserActions;
    const result = shared && typeof shared.fillControl === "function"
      ? shared.fillControl(input, { type: "text", value })
      : shared && typeof shared.fillText === "function"
        ? shared.fillText(input, value)
        : null;
    // Custom dropdown path returns a Promise; synchronous fillInput cannot await it.
    if (result instanceof Promise) return false;
    if (!result?.ok) return false;
    if (!textValueAppearsCommitted(input, value)) return false;
    if (trackSource) tagFilledControlAfterWrite(input, value, trackSource);
    return true;
  }

  global.__formFillerControlFillTools = {
    collectFormControls,
    sortElementsByVisualOrder,
    ensureActionable,
    isVisibleForScrape,
    tagFilledControlAfterWrite,
    isPlaceholderOptionText,
    selectLooksUnfilled,
    pickBestOptionScoreResult,
    pickBestOptionIndex,
    applySelectIndex,
    fillSelect,
    fillSpinbutton,
    coerceSpinbuttonValue,
    fillInput
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
