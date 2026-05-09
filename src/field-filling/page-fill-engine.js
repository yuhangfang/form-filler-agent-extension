/**
 * Shared deterministic fill - loaded before floating-bar-controller.js and injected into all frames
 * via chrome.scripting.executeScript(..., { all_frames: true }).
 */
(function attachFillCore(global) {
  const FIELD_ALIASES = globalThis.__formFiller_FIELD_ALIASES;
  if (!FIELD_ALIASES || typeof FIELD_ALIASES !== "object") {
    throw new Error(
      "page-fill-engine: load field-guessing/profile-field-catalog.js before page-fill-engine.js (sets globalThis.__formFiller_FIELD_ALIASES)"
    );
  }
  const profileFieldCatalog = globalThis.__formFillerProfileFieldCatalog || {};
  const demographicFieldTools = global.__formFillerDemographicFieldTools;
  if (!demographicFieldTools) {
    throw new Error("page-fill-engine: load field-filling/demographic-field-tools.js before page-fill-engine.js");
  }
  const fieldDescriptorTools = global.__formFillerFieldDescriptorTools;
  if (!fieldDescriptorTools) {
    throw new Error("page-fill-engine: load field-filling/field-descriptor-tools.js before page-fill-engine.js");
  }
  const getVisualOrderMeta =
    typeof fieldDescriptorTools.getVisualOrderMeta === "function"
      ? (el) => fieldDescriptorTools.getVisualOrderMeta(el)
      : (el) => {
          if (!(el instanceof Element)) return { visualTop: 0, visualLeft: 0 };
          const rect = el.getBoundingClientRect();
          const top = Number(rect?.top || 0) + Number(global.scrollY || 0);
          const left = Number(rect?.left || 0) + Number(global.scrollX || 0);
          return { visualTop: Math.round(top), visualLeft: Math.round(left) };
        };
  const controlFillTools = global.__formFillerControlFillTools;
  if (!controlFillTools) {
    throw new Error("page-fill-engine: load field-filling/control-fill-tools.js before page-fill-engine.js");
  }
  const choiceControlTools = global.__formFillerChoiceControlTools;
  if (!choiceControlTools) {
    throw new Error("page-fill-engine: load field-filling/choice-control-tools.js before page-fill-engine.js");
  }
  const learnedFieldMemory = global.__formFillerLearnedFieldMemory || null;
  let activeStoredHints = [];

  function normalize(input) {
    return (input || "").toLowerCase().replace(/\s+/g, " ").trim();
  }

  function pickProfileKey(candidate) {
    let bestKey = null;
    let bestLen = 0;
    for (const [key, aliases] of Object.entries(FIELD_ALIASES)) {
      for (const alias of aliases) {
        if (candidate.includes(alias) && alias.length > bestLen) {
          bestLen = alias.length;
          bestKey = key;
        }
      }
    }
    return bestKey;
  }

  function pickProfileKeyCandidates(candidate) {
    const hits = [];
    for (const [key, aliases] of Object.entries(FIELD_ALIASES)) {
      for (const alias of aliases) {
        if (candidate.includes(alias)) hits.push({ key, len: alias.length });
      }
    }
    hits.sort((a, b) => b.len - a.len);
    const seen = new Set();
    return hits
      .filter((hit) => {
        if (seen.has(hit.key)) return false;
        seen.add(hit.key);
        return true;
      })
      .map((hit) => hit.key);
  }

  function resolveProfileValue(profileKey, _candidate, profile) {
    if (profileKey === "firstName") {
      return profile.firstName?.trim() || (profile.fullName || "").trim().split(/\s+/)[0] || null;
    }
    if (profileKey === "lastName") {
      if (profile.lastName?.trim()) return profile.lastName.trim();
      const parts = (profile.fullName || "").trim().split(/\s+/);
      return parts.length > 1 ? parts.slice(1).join(" ") : null;
    }
    const v = profile[profileKey];
    return v && String(v).trim() ? String(v).trim() : null;
  }

  function splitDateRangeParts(timeRange) {
    const raw = String(timeRange || "").replace(/\s+/g, " ").trim();
    if (!raw) return {};
    const parts = raw.split(/\s*(?:-|–|—|to)\s*/i).map((part) => part.trim()).filter(Boolean);
    const start = parts[0] || "";
    const end = parts.slice(1).join(" - ") || "";
    const parsePoint = (value) => {
      const text = String(value || "").replace(/\s+/g, " ").trim();
      if (!text) return { month: "", year: "" };
      if (/present|current|now/i.test(text)) return { month: "", year: "Present", present: true };
      const year = text.match(/\b(19\d{2}|20\d{2})\b/)?.[1] || "";
      const monthRaw = text.match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\b/i)?.[1] || "";
      const numericMonth = text.match(/\b(0?[1-9]|1[0-2])\s*[\/.-]\s*(?:19|20)\d{2}\b/)?.[1] || "";
      const month = monthRaw
        ? monthRaw.slice(0, 1).toUpperCase() + monthRaw.slice(1).toLowerCase().replace(/^Sept$/, "Sep")
        : numericMonth.padStart(2, "0");
      return { month, year, present: false };
    };
    const startParts = parsePoint(start);
    const endParts = parsePoint(end);
    return {
      startMonth: startParts.month,
      startYear: startParts.year,
      endMonth: endParts.month,
      endYear: endParts.year,
      isCurrent: !!endParts.present
    };
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

  function formatMonthInputValue(year, month) {
    if (!year || !month || !/^\d{4}$/.test(String(year))) return "";
    const mm = monthNumber(month);
    return mm ? `${year}-${mm}` : "";
  }

  function normalizeStructuredDatePoint(month, year, isCurrent = false) {
    const raw = `${String(month || "")} ${String(year || "")}`.trim();
    if (isCurrent || /\b(present|current|now)\b/i.test(raw)) {
      return { month: "", year: "Present", isCurrent: true };
    }
    if (/\b(mm|yyyy)\b/i.test(raw)) return { month: "", year: "", isCurrent: false };
    const parsed = splitDateRangeParts(raw);
    return {
      month: parsed.startMonth || monthNumber(month) || "",
      year: parsed.startYear || String(year || "").match(/\b(19\d{2}|20\d{2})\b/)?.[1] || "",
      isCurrent: false
    };
  }

  function resolveRepeatableProfileValueFromContext({
    profile,
    context,
    semantic,
    candidateText,
    inputType,
    elementRole,
    buildWebsiteEntries,
    debug
  }) {
    const resumeData = profile?.__resumeData;
    const ctx = normalize(`${context || ""} ${semantic?.section || ""} ${semantic?.name || ""} ${candidateText || ""}`);
    const rowMatch = ctx.match(/\[group:[^\]]+\srow:(\d+)\]/i);
    if (!rowMatch) return null;
    const rowIndex = Math.max(0, Number(rowMatch[1] || 1) - 1);
    const sectionKind = profileFieldCatalog.repeatableKindFromText?.(ctx) || "";
    const isEducation = sectionKind === "education";
    const isExperience = sectionKind === "experience";
    const isWebsite = sectionKind === "website";
    const collectResumeEntries = profileFieldCatalog.collectResumeEntriesForRepeatableSection;
    const entries =
      typeof collectResumeEntries === "function"
        ? collectResumeEntries(sectionKind, resumeData, profile, buildWebsiteEntries)
        : isEducation
          ? (resumeData && Array.isArray(resumeData.education) ? resumeData.education : [])
          : isWebsite
            ? (typeof buildWebsiteEntries === "function" ? buildWebsiteEntries(profile) : [])
            : [
                ...(resumeData && Array.isArray(resumeData.experience) ? resumeData.experience : []),
                ...(resumeData && Array.isArray(resumeData.internships) ? resumeData.internships : [])
              ];
    debug?.("resolveRepeatable", { rowIndex, isEducation, isExperience, entryCount: entries.length, ctx: ctx.slice(0, 200) });
    const entry = entries[rowIndex];
    if (!entry) return { profileKey: "out_of_bounds", value: "", reason: "resume_row_empty", candidate: context };
    if (!isEducation && !isExperience && !isWebsite) return null;

    let dates = isWebsite ? {} : splitDateRangeParts(entry.timeRange);
    if (!isWebsite && (entry.startDate || entry.endDate) && (entry.startDate?.year || entry.endDate?.year || entry.startDate?.month || entry.endDate?.month || entry.endDate?.isCurrent)) {
      const startPoint = normalizeStructuredDatePoint(entry.startDate?.month, entry.startDate?.year);
      const endPoint = normalizeStructuredDatePoint(entry.endDate?.month, entry.endDate?.year, entry.endDate?.isCurrent);
      dates = {
        startMonth: startPoint.month,
        startYear: startPoint.year,
        endMonth: endPoint.month,
        endYear: endPoint.year,
        isCurrent: !!endPoint.isCurrent
      };
    }

    const wantsNumericMonth = inputType === "number" || elementRole === "spinbutton";
    const todayDateParts = () => {
      const now = new Date();
      const month = String(now.getMonth() + 1).padStart(2, "0");
      const year = String(now.getFullYear());
      const monthName = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][now.getMonth()];
      return { month, monthName, year };
    };
    const todayFallbackForDatePart = (part) => {
      const today = todayDateParts();
      if (part === "month") return wantsNumericMonth ? today.month : today.monthName;
      if (part === "year") return today.year;
      if (inputType === "month") return `${today.year}-${today.month}`;
      return `${today.month}/${today.year}`;
    };
    const pickDate = () => {
      const hasFrom = /\bfrom\b|\bstart\b|\bbegin\b/i.test(ctx);
      const hasTo = /\bto\b|\bend\b/i.test(ctx);
      const hasMonth = /\bmonth\b/i.test(ctx);
      const hasYear = /\byear\b/i.test(ctx);
      if (/start\s*month|from\s*month|begin\s*month|from.*month/i.test(ctx) || (hasFrom && hasMonth && !hasTo)) return (wantsNumericMonth ? monthNumber(dates.startMonth) : dates.startMonth) || todayFallbackForDatePart("month");
      if (/start\s*year|from\s*year|begin\s*year|from.*year/i.test(ctx) || (hasFrom && hasYear && !hasTo && !hasMonth)) return dates.startYear || todayFallbackForDatePart("year");
      if (/end\s*month|to\s*month|to.*month/i.test(ctx) || (hasTo && hasMonth && !hasFrom)) return dates.isCurrent ? "" : ((wantsNumericMonth ? monthNumber(dates.endMonth) : dates.endMonth) || todayFallbackForDatePart("month"));
      if (/end\s*year|to\s*year|to.*year/i.test(ctx) || (hasTo && hasYear && !hasFrom && !hasMonth)) return dates.isCurrent ? "" : (dates.endYear || todayFallbackForDatePart("year"));
      if (/graduation\s*year|year\s*of\s*graduation|graduated/i.test(ctx)) return dates.endYear || dates.startYear || todayFallbackForDatePart("year");
      if (/start\s*date|from\s*date|begin\s*date/i.test(ctx)) {
        if (inputType === "month") return formatMonthInputValue(dates.startYear, dates.startMonth) || todayFallbackForDatePart("date");
        return [dates.startMonth, dates.startYear].filter(Boolean).join(" ") || entry.timeRange || todayFallbackForDatePart("date");
      }
      if (/end\s*date|to\s*date/i.test(ctx)) {
        if (dates.isCurrent) return "";
        if (inputType === "month") return formatMonthInputValue(dates.endYear, dates.endMonth) || todayFallbackForDatePart("date");
        return [dates.endMonth, dates.endYear].filter(Boolean).join(" ") || entry.timeRange || todayFallbackForDatePart("date");
      }
      if (/\bdate\b|dates|period|duration/i.test(ctx)) return entry.timeRange || todayFallbackForDatePart("date");
      return "";
    };

    const getFd = (kind) => profileFieldCatalog.getRepeatableFieldDef?.(sectionKind, kind);

    function resolveSlotFromDef(fd) {
      if (!fd) return null;
      if (fd.computed === "date") return { profileKey: fd.slotKey, value: pickDate() };
      if (fd.computed === "current") return { profileKey: fd.slotKey, value: dates.isCurrent ? "Yes" : "No" };
      if (fd.computed === "description") {
        const v =
          entry.description || (Array.isArray(entry.bullets) ? entry.bullets.slice(0, 4).join("; ") : "");
        return { profileKey: fd.slotKey, value: v };
      }
      if (fd.computed === "websiteRow" && fd.resumeProperty) {
        return { profileKey: fd.slotKey, value: String(entry[fd.resumeProperty] ?? "") };
      }
      if (fd.resumeProperty) {
        let v = entry[fd.resumeProperty];
        if ((v == null || v === "") && fd.resumeFallbackProperty) v = entry[fd.resumeFallbackProperty];
        return { profileKey: fd.slotKey, value: v ?? "" };
      }
      return null;
    }

    let profileKey = "";
    let value = "";
    if (isWebsite) {
      const fieldKind = profileFieldCatalog.repeatableFieldKindFromText?.("website", ctx) || "";
      const fd = fieldKind === "name" ? getFd("name") : getFd("url");
      const resolved = resolveSlotFromDef(fd) || resolveSlotFromDef(getFd("url"));
      if (resolved) {
        profileKey = resolved.profileKey;
        value = resolved.value;
      }
    } else if (isEducation || isExperience) {
      const fieldKind = profileFieldCatalog.repeatableFieldKindFromText?.(sectionKind, ctx) || "";
      const hasDateSignal = fieldKind === "date";
      const hasFromTo = /\bfrom\b|\bto\b|\bstart\b|\bend\b/i.test(ctx);
      const isSpinbutton = elementRole === "spinbutton" || inputType === "number";
      let fd = null;
      if (hasDateSignal || (hasFromTo && isSpinbutton)) fd = getFd("date");
      else if (fieldKind) fd = getFd(fieldKind);
      else fd = getFd("date");
      const resolved = resolveSlotFromDef(fd);
      if (resolved) {
        profileKey = resolved.profileKey;
        value = resolved.value;
      }
    }

    const isIntentionalEmpty = profileKey === "out_of_bounds" || (dates && dates.isCurrent && /end|to/i.test(ctx)) || (value === "");
    const vStr = String(value ?? "").trim();
    debug?.("resolvedRepeatable", { profileKey, value: vStr, isIntentionalEmpty });
    if (!vStr && profileKey !== "out_of_bounds" && !isIntentionalEmpty) return null;
    return { profileKey, value: vStr, reason: "resume_row", candidate: context };
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

  function resolveRepeatableProfileValue(control, profile) {
    const context = fieldDescriptorTools.extendedGuessContext(control);
    const semantic = fieldDescriptorTools.getPlaywrightSemanticParts(control);
    const inputType = control instanceof HTMLInputElement ? (control.type || "text").toLowerCase() : "";
    const elementRole = (control.getAttribute?.("role") || "").toLowerCase();
    return resolveRepeatableProfileValueFromContext({
      profile,
      context,
      semantic,
      candidateText: fieldDescriptorTools.candidateTextForControl(control),
      inputType,
      elementRole,
      buildWebsiteEntries,
      debug: (label, data) => console.log(`[FormFiller] ${label}:`, data)
    });
  }

  function describeFieldForMemory(control) {
    if (!(control instanceof Element)) return null;
    const semantic = fieldDescriptorTools.getPlaywrightSemanticParts(control);
    const inputType =
      control instanceof HTMLSelectElement
        ? "select"
        : control instanceof HTMLTextAreaElement
          ? "textarea"
          : control instanceof HTMLInputElement
            ? (control.type || "text").toLowerCase()
            : (control.getAttribute?.("role") || "unknown");
    return {
      fingerprint: fieldDescriptorTools.computeFieldFingerprint(control),
      questionKey: computeQuestionKeyForControl(control),
      kind: inputType,
      label: semantic.name || "",
      name: semantic.name || "",
      section: semantic.section || "",
      helpText: fieldDescriptorTools.collectControlHelpText(control),
      context: fieldDescriptorTools.extendedGuessContext(control),
      candidateText: fieldDescriptorTools.candidateTextForControl(control)
    };
  }

  function resolveLearnedProfileValue(control, profile) {
    if (!learnedFieldMemory || typeof learnedFieldMemory.resolveFieldValue !== "function") return null;
    if (!activeStoredHints.length) return null;
    const mapped = learnedFieldMemory.resolveFieldValue({
      descriptor: describeFieldForMemory(control),
      profile,
      hints: activeStoredHints
    });
    if (!mapped?.value) return null;
    if (textControlShouldRejectChoiceAnswer(control, mapped.value, { canonicalKey: mapped.profileKey })) return null;
    return mapped;
  }

  function resolveMappedValueStrict(control, profile) {
    const learned = resolveLearnedProfileValue(control, profile);
    if (learned) return learned;

    const candidate = fieldDescriptorTools.candidateTextForControl(control);
    let profileKey = null;
    let value = null;
    let reason = "rule";
    for (const key of pickProfileKeyCandidates(candidate)) {
      const candidateValue = resolveProfileValue(key, candidate, profile);
      if (!candidateValue) continue;
      if (textControlShouldRejectChoiceAnswer(control, candidateValue, { canonicalKey: key })) continue;
      profileKey = key;
      value = candidateValue;
      break;
    }

    if (!profileKey || !value) {
      const repeatable = resolveRepeatableProfileValue(control, profile);
      if (repeatable) return repeatable;
      return null;
    }
    if (textControlShouldRejectChoiceAnswer(control, value, { canonicalKey: profileKey })) return null;
    return { profileKey, value, reason, candidate };
  }

  function resolveMappedValueRelaxed(control, profile) {
    const strict = resolveMappedValueStrict(control, profile);
    if (strict) return strict;

    if (control instanceof HTMLSelectElement) {
      return null;
    }

    const t = (control.type || "text").toLowerCase();
    if (t === "email" && profile.email?.trim()) {
      return {
        profileKey: "email",
        value: profile.email.trim(),
        reason: "guess_type_email",
        candidate: fieldDescriptorTools.candidateTextForControl(control)
      };
    }
    if (t === "tel" && profile.phone?.trim()) {
      return {
        profileKey: "phone",
        value: profile.phone.trim(),
        reason: "guess_type_tel",
        candidate: fieldDescriptorTools.candidateTextForControl(control)
      };
    }
    if (t === "url") {
      if (profile.website?.trim()) {
        return {
          profileKey: "website",
          value: profile.website.trim(),
          reason: "guess_type_url",
          candidate: fieldDescriptorTools.candidateTextForControl(control)
        };
      }
      if (profile.linkedin?.trim()) {
        return {
          profileKey: "linkedin",
          value: profile.linkedin.trim(),
          reason: "guess_type_url_linkedin",
          candidate: fieldDescriptorTools.candidateTextForControl(control)
        };
      }
    }

    return null;
  }

  function resolveDisabilityProfileValue(profile) {
    return demographicFieldTools.resolveDisabilityProfileValue(profile, { debug: debugLog });
  }

  function selfIdentifyDatePartValue(control) {
    if (!(control instanceof HTMLInputElement)) return "";
    const role = (control.getAttribute?.("role") || "").toLowerCase();
    const type = (control.type || "text").toLowerCase();
    if (role !== "spinbutton" && type !== "number") return "";
    const semantic = fieldDescriptorTools.getPlaywrightSemanticParts(control);
    const label = normalize([
      semantic.name,
      control.getAttribute("aria-label"),
      control.name,
      control.id
    ].filter(Boolean).join(" "));
    const ctx = normalize([
      semantic.section,
      fieldDescriptorTools.extendedGuessContext(control),
      fieldDescriptorTools.candidateTextForControl(control)
    ].filter(Boolean).join(" "));
    return demographicFieldTools.selfIdentifyDatePartValue({ role, type, label, context: ctx });
  }

  function isEducationChoiceControl(control) {
    const ctx = normalize(`${fieldDescriptorTools.extendedGuessContext(control)} ${fieldDescriptorTools.candidateTextForControl(control)}`);
    const fieldKind = profileFieldCatalog.repeatableFieldKindFromText?.("education", ctx) || "";
    return fieldKind === "degree" || fieldKind === "major";
  }

  function isSelectCommitted(select, desiredText) {
    if (!(select instanceof HTMLSelectElement)) return false;
    const opt = select.selectedOptions[0];
    const label = normalize(opt?.textContent || "");
    const value = normalize(select.value || "");
    const desired = normalize(desiredText || "");
    if (!desired) return false;
    return (
      label === desired ||
      value === desired ||
      label.includes(desired) ||
      desired.includes(label) ||
      value.includes(desired) ||
      desired.includes(value)
    );
  }

  function fillSelfIdentifyDateInput(input, value) {
    if (!(input instanceof HTMLInputElement) || !controlFillTools.ensureActionable(input)) return false;
    const coercedValue = controlFillTools.coerceSpinbuttonValue(input, value);
    if (!String(coercedValue || "").trim()) return false;
    debugLog("self_identify_date:fast_fill:start", {
      value,
      coercedValue,
      before: input.value,
      control: debugElement(input)
    });
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    input.focus();
    try { input.select(); } catch {}
    if (nativeSetter) nativeSetter.call(input, String(coercedValue));
    else input.value = String(coercedValue);
    try {
      input.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        cancelable: true,
        data: String(coercedValue),
        inputType: "insertReplacementText"
      }));
    } catch {
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    input.dispatchEvent(new Event("change", { bubbles: true }));
    try { input.dispatchEvent(new Event("blur", { bubbles: true })); } catch {}
    controlFillTools.tagFilledControlAfterWrite(input, coercedValue, "deterministic:self_identify_date_fast");
    debugLog("self_identify_date:fast_fill:end", {
      after: input.value,
      control: debugElement(input)
    });
    return true;
  }

  function valuesLooselyMatch(a, b) {
    return normalize(String(a)) === normalize(String(b));
  }

  function isLikelyDropdownSearchInput(control, context) {
    if (!(control instanceof HTMLInputElement)) return false;
    const t = (control.type || "").toLowerCase();
    const ctx = normalize(String(context || ""));
    const attrs = [
      control.getAttribute("role"),
      control.getAttribute("aria-autocomplete"),
      control.getAttribute("aria-haspopup"),
      control.getAttribute("aria-expanded"),
      control.getAttribute("aria-controls"),
      control.getAttribute("aria-owns"),
      control.getAttribute("aria-label"),
      control.className,
      control.closest("[role='combobox'], [aria-haspopup='listbox'], [role='listbox'], [class*='select' i], [class*='dropdown' i]")?.getAttribute("role"),
      control.closest("[data-automation-id], [data-qa], [data-testid]")?.getAttribute("data-automation-id")
    ].filter(Boolean).join(" ").toLowerCase();
    return (
      t === "search" ||
      /\bcombobox\b|listbox|dropdown|select/.test(attrs) ||
      /results found|no results found|type to search|select\.\.\.|combobox|listbox/i.test(ctx) ||
      !!control.closest('[role="combobox"], [aria-haspopup="listbox"], [role="listbox"]')
    );
  }

  function getComboboxAutoId(control) {
    if (!(control instanceof Element)) return "";
    const wrapper = control.closest("[data-automation-id], [data-qa], [data-testid], [data-field-name], [id]");
    const ariaLabel = fieldDescriptorTools.sanitizeContextChunk(control.getAttribute("aria-label") || "");
    const semantic = fieldDescriptorTools.getPlaywrightSemanticParts(control);
    const semanticName = fieldDescriptorTools.sanitizeContextChunk(semantic.name || "");
    const contextLabel = fieldDescriptorTools.sanitizeContextChunk(fieldDescriptorTools.extendedGuessContext(control).split("|")[0] || "");
    const fallbackLabel = [ariaLabel, semanticName, contextLabel]
      .find((part) => part && !controlFillTools.isPlaceholderOptionText(part) && !/^search$/i.test(part));
    return (
      wrapper?.getAttribute("data-automation-id") ||
      wrapper?.getAttribute("data-qa") ||
      wrapper?.getAttribute("data-testid") ||
      wrapper?.getAttribute("data-field-name") ||
      control.getAttribute("data-automation-id") ||
      control.getAttribute("data-qa") ||
      control.getAttribute("data-testid") ||
      control.id ||
      wrapper?.id ||
      control.name ||
      fallbackLabel ||
      ""
    );
  }

  function overlapScore(ctx, profileValue) {
    const A = normalize(String(ctx));
    const B = normalize(String(profileValue));
    if (!A || !B) return 0;
    if (A.includes(B) || B.includes(A)) {
      return Math.min(80, 28 + 2 * Math.min(A.length, B.length));
    }
    let s = 0;
    const aw = A.split(/[^a-z0-9@.+]+/i).filter((w) => w.length > 2);
    const bWords = new Set(
      B.split(/[^a-z0-9@.+]+/i)
        .filter((w) => w.length > 2)
        .map((w) => normalize(w))
    );
    for (const w of aw) {
      const nw = normalize(w);
      if (bWords.has(nw)) s += nw.length + 4;
    }
    if (B.includes("@") && A.includes("@")) {
      const tokA = A.split(/\s+/).find((t) => t.includes("@"));
      const tokB = B.split(/\s+/).find((t) => t.includes("@"));
      if (tokA && tokB && tokA === tokB) s += 40;
    }
    return s;
  }

  function isGuessableTextControl(control) {
    if (control instanceof HTMLTextAreaElement) return true;
    if (!(control instanceof HTMLInputElement)) return false;
    const t = (control.type || "text").toLowerCase();
    return ["text", "search", "email", "tel", "url", ""].includes(t);
  }

  function textControlShouldRejectChoiceAnswer(control, value, guess) {
    if (!(control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement)) return false;
    if (control instanceof HTMLInputElement) {
      const t = (control.type || "text").toLowerCase();
      if (t === "radio" || t === "checkbox") return false;
    }
    const semantic = fieldDescriptorTools.getPlaywrightSemanticParts(control);
    const localName = normalize(semantic.name || fieldDescriptorTools.getStrictControlLabel(control));
    const targetText = normalize([
      semantic.name,
      semantic.section,
      fieldDescriptorTools.extendedGuessContext(control),
      fieldDescriptorTools.candidateTextForControl(control)
    ].filter(Boolean).join(" "));
    return demographicFieldTools.shouldRejectChoiceAnswerForText({
      canonicalKey: guess?.canonicalKey,
      value,
      localName,
      targetText
    });
  }

  /**
   * Second pass for Evaluate only: type hints, multi-key &lt;select&gt; scan, overlap greedy match, singleton fallback.
   */
  function runSecondPassGlobalGuess(profile, consumedKeys, decisions, diagnosis, filledCounter) {
    const ORDER = [
      "email", "phone",
      "firstName", "lastName", "fullName",
      "linkedin", "github", "website",
      "address", "city", "state", "zip", "country",
      "currentTitle", "currentCompany", "yearsOfExperience",
      "highestDegree", "major", "university", "graduationYear",
      "workAuthorization", "requiresSponsorship",
      "desiredSalary", "noticePeriod", "willingToRelocate",
      "gender", "ethnicity", "veteranStatus", "disabilityStatus"
    ];
    let added = 0;

    function remainingKeys() {
      return ORDER.filter((k) => profile[k]?.trim() && !consumedKeys.has(k));
    }

    for (const control of controlFillTools.collectFormControls(document)) {
      if (!(control instanceof HTMLInputElement)) continue;
      if (control.disabled || control.readOnly) continue;
      if ((control.value || "").trim()) continue;
      if (!isGuessableTextControl(control)) continue;
      const t = (control.type || "text").toLowerCase();
      if (t === "email" && profile.email?.trim()) {
        controlFillTools.fillInput(control, profile.email.trim(), "evaluate:pass2");
        consumedKeys.add("email");
        added += 1;
        decisions.push({
          profileKey: "email",
          reason: "guess_pass2_type_email",
          candidate: fieldDescriptorTools.extendedGuessContext(control).slice(0, 120),
          field: control.name || control.id || "email"
        });
        diagnosis.push({ state: "filled_guess_pass2", profileKey: "email", control: "input" });
        continue;
      }
      if (t === "tel" && profile.phone?.trim()) {
        controlFillTools.fillInput(control, profile.phone.trim(), "evaluate:pass2");
        consumedKeys.add("phone");
        added += 1;
        decisions.push({
          profileKey: "phone",
          reason: "guess_pass2_type_tel",
          candidate: fieldDescriptorTools.extendedGuessContext(control).slice(0, 120),
          field: control.name || control.id || "tel"
        });
        diagnosis.push({ state: "filled_guess_pass2", profileKey: "phone", control: "input" });
        continue;
      }
      if (t === "url" && (profile.website?.trim() || profile.linkedin?.trim())) {
        const useWeb = Boolean(profile.website?.trim());
        const k = useWeb ? "website" : "linkedin";
        const v = useWeb ? profile.website.trim() : profile.linkedin.trim();
        controlFillTools.fillInput(control, v, "evaluate:pass2");
        consumedKeys.add(k);
        added += 1;
        decisions.push({
          profileKey: k,
          reason: "guess_pass2_type_url",
          candidate: fieldDescriptorTools.extendedGuessContext(control).slice(0, 120),
          field: control.name || control.id || "url"
        });
        diagnosis.push({ state: "filled_guess_pass2", profileKey: k, control: "input" });
      }
    }

    for (const control of controlFillTools.collectFormControls(document)) {
      if (!(control instanceof HTMLSelectElement) || control.disabled) continue;
      if (!controlFillTools.selectLooksUnfilled(control)) continue;

      let bestKey = null;
      let bestIdx = -1;
      let bestScore = 0;
      for (const key of ORDER) {
        if (consumedKeys.has(key)) continue;
        const val = profile[key]?.trim();
        if (!val) continue;
        const r = controlFillTools.pickBestOptionScoreResult(control, val, 48);
        if (r.score > bestScore && r.index >= 0) {
          bestScore = r.score;
          bestIdx = r.index;
          bestKey = key;
        }
      }
      if (bestKey != null && bestIdx >= 0 && bestScore >= 48) {
        controlFillTools.applySelectIndex(control, bestIdx, "evaluate:pass2");
        consumedKeys.add(bestKey);
        added += 1;
        decisions.push({
          profileKey: bestKey,
          reason: "guess_pass2_select_profile_scan",
          candidate: fieldDescriptorTools.extendedGuessContext(control).slice(0, 120),
          field: control.name || control.id || "select"
        });
        diagnosis.push({
          state: "filled_guess_pass2",
          profileKey: bestKey,
          control: "select",
          note: `option score ${Math.round(bestScore)}`
        });
      }
    }

    const textEmpties = [];
    for (const control of controlFillTools.collectFormControls(document)) {
      if (control instanceof HTMLTextAreaElement) {
        if (!control.disabled && !control.readOnly && !(control.value || "").trim()) {
          textEmpties.push(control);
        }
        continue;
      }
      if (!(control instanceof HTMLInputElement)) continue;
      if (control.disabled || control.readOnly) continue;
      if ((control.value || "").trim()) continue;
      if (!isGuessableTextControl(control)) continue;
      const t = (control.type || "text").toLowerCase();
      if (["email", "tel", "url"].includes(t)) continue;
      textEmpties.push(control);
    }

    const rk = remainingKeys();
    const pairs = [];
    for (const c of textEmpties) {
      const ctx = fieldDescriptorTools.extendedGuessContext(c);
      for (const key of rk) {
        const val = profile[key].trim();
        const spacedKey = key.replace(/([A-Z])/g, " $1").trim();
        const s = Math.max(overlapScore(ctx, val), overlapScore(ctx, spacedKey), overlapScore(ctx, key));
        pairs.push({ c, key, score: s });
      }
    }
    pairs.sort((a, b) => b.score - a.score);
    const usedFields = new Set();
    const usedKeysPass3 = new Set();
    for (const p of pairs) {
      if (p.score < 14) break;
      if (usedFields.has(p.c) || usedKeysPass3.has(p.key)) continue;
      if (consumedKeys.has(p.key)) continue;
      usedFields.add(p.c);
      usedKeysPass3.add(p.key);
      controlFillTools.fillInput(p.c, profile[p.key].trim(), "evaluate:pass2");
      consumedKeys.add(p.key);
      added += 1;
      decisions.push({
        profileKey: p.key,
        reason: "guess_pass2_overlap",
        candidate: fieldDescriptorTools.extendedGuessContext(p.c).slice(0, 120),
        field: p.c.name || p.c.id || p.c.type
      });
      diagnosis.push({
        state: "filled_guess_pass2",
        profileKey: p.key,
        control: p.c instanceof HTMLTextAreaElement ? "textarea" : "input"
      });
    }

    const stillEmpty = [];
    for (const control of controlFillTools.collectFormControls(document)) {
      if (control instanceof HTMLTextAreaElement) {
        if (!control.disabled && !control.readOnly && !(control.value || "").trim()) {
          stillEmpty.push(control);
        }
        continue;
      }
      if (!(control instanceof HTMLInputElement)) continue;
      if (control.disabled || control.readOnly) continue;
      if ((control.value || "").trim()) continue;
      if (!isGuessableTextControl(control)) continue;
      stillEmpty.push(control);
    }
    const rk2 = ORDER.filter((k) => profile[k]?.trim() && !consumedKeys.has(k));
    if (stillEmpty.length === 1 && rk2.length === 1) {
      const c = stillEmpty[0];
      const k = rk2[0];
      controlFillTools.fillInput(c, profile[k].trim(), "evaluate:pass2");
      consumedKeys.add(k);
      added += 1;
      decisions.push({
        profileKey: k,
        reason: "guess_pass2_singleton",
        candidate: fieldDescriptorTools.extendedGuessContext(c).slice(0, 120),
        field: c.name || c.id || c.type
      });
      diagnosis.push({
        state: "filled_guess_pass2",
        profileKey: k,
        control: "input",
        note: "singleton"
      });
    }

    filledCounter.filledCount += added;
    return added;
  }

  function splitProfileAndStoredHints(profile) {
    const p = profile || {};
    const raw = p.__storedFieldHints;
    const baseProfile = { ...p };
    delete baseProfile.__storedFieldHints;
    const storedHints = Array.isArray(raw) ? raw : [];
    activeStoredHints = storedHints;
    return { baseProfile, storedHints };
  }

  function normalizeQuestionKey(text) {
    const raw = String(text || "")
      .toLowerCase()
      .replace(/https?:\/\/\S+/g, " ")
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!raw) return "";
    return raw
      .split(" ")
      .filter((w) => w.length > 1)
      .slice(0, 24)
      .join(" ");
  }

  function computeQuestionKeyForControl(control) {
    return normalizeQuestionKey(fieldDescriptorTools.extendedGuessContext(control).slice(0, 400));
  }

  function splitHintCandidates(value) {
    const raw = String(value || "").trim();
    if (!raw) return [];
    const out = [raw];
    const pipe = raw.split("|").map((x) => x.trim()).filter(Boolean);
    for (const p of pipe) out.push(p);
    return Array.from(new Set(out.map((x) => x.trim()).filter(Boolean)));
  }

  function disabilityChoiceAlreadySelected() {
    const labels = [
      "Yes, I have a disability, or have had one in the past",
      "No, I do not have a disability and have not had one in the past",
      "I do not want to answer"
    ];
    const controls = choiceControlTools.collectChoiceControls(document, "checkbox");
    const selected = controls.some((control) => {
      if (!choiceControlTools.checkableChecked(control)) return false;
      const rowText = control.closest?.("[role='cell'], td, [role='row'], tr, label")?.textContent || "";
      const text = normalize(`${choiceControlTools.checkableValue(control)} ${choiceControlTools.checkboxOrRadioLabel(control)} ${rowText}`.trim());
      return labels.some((label) => text.includes(normalize(label)));
    });
    debugLog("checkbox:disability_already_selected", {
      selected,
      controls: controls.slice(0, 8).map((control) => debugElement(control))
    });
    return selected;
  }

  function controlEligibleForStoredHint(control) {
    if (control instanceof HTMLSelectElement || control instanceof HTMLTextAreaElement) return true;
    if (!(control instanceof HTMLInputElement)) return false;
    if (isDateLikeStoredHintTarget(control)) return false;
    const t = (control.type || "text").toLowerCase();
    return !(
      t === "hidden" ||
      t === "file" ||
      t === "submit" ||
      t === "button" ||
      t === "reset" ||
      t === "image"
    );
  }

  function isDateLikeStoredHintTarget(control) {
    if (!(control instanceof HTMLInputElement)) return false;
    const role = (control.getAttribute?.("role") || "").toLowerCase();
    const type = (control.type || "text").toLowerCase();
    const text = normalize([
      control.getAttribute?.("aria-label"),
      control.getAttribute?.("name"),
      control.getAttribute?.("id"),
      control.closest?.("[aria-labelledby]")?.getAttribute?.("aria-labelledby")
    ].filter(Boolean).join(" "));
    if (type === "date" || type === "month") return true;
    if (role !== "spinbutton" && type !== "number") return false;
    return /\b(date|month|year|from|to|start|end)\b|datesection(month|year)/i.test(text);
  }

  function isSocialOrWebsitePromptText(text) {
    const norm = normalize(text);
    if (!norm) return false;
    if (/\b(linkedin|github|twitter|portfolio|personal\s+site|personal\s+website|other\s+website)\b/i.test(norm)) {
      return true;
    }
    if (/\b(website|web\s*site|social(?:\s+media)?)\b/i.test(norm)) return true;
    return /\b(url|link)\b/i.test(norm) && /\b(profile|social|portfolio|personal|website)\b/i.test(norm);
  }

  /** Apply previously saved values (same fingerprints as submit/LLM) to empty controls. */
  function applyStoredDomainHints(hints) {
    const decisions = [];
    const diagnosis = [];
    if (!Array.isArray(hints) || !hints.length) {
      return { applied: 0, decisions, diagnosis };
    }
    const byFp = new Map();
    const byQuestion = new Map();
    for (const h of hints) {
      const fp = h?.fingerprint;
      const qk = normalizeQuestionKey(h?.questionKey || "");
      const v = String(h?.value ?? "").trim();
      if (!v) continue;
      if (fp) byFp.set(fp, v);
      if (qk) byQuestion.set(qk, v);
    }
    if (!byFp.size && !byQuestion.size) return { applied: 0, decisions, diagnosis };

    let applied = 0;
    const usedKey = new Set();

    for (const control of controlFillTools.collectFormControls(document)) {
      if (isSkippableForSubmitSnapshot(control)) continue;
      if (!controlEligibleForStoredHint(control)) continue;

      const fp = fieldDescriptorTools.computeFieldFingerprint(control);
      const qk = computeQuestionKeyForControl(control);
      const key = byFp.has(fp) ? `fp:${fp}` : byQuestion.has(qk) ? `q:${qk}` : "";
      const val = key.startsWith("fp:") ? byFp.get(fp) : key.startsWith("q:") ? byQuestion.get(qk) : "";
      if (!val || usedKey.has(key)) continue;
      const candidates = splitHintCandidates(val);

      if (control instanceof HTMLSelectElement) {
        if (!controlFillTools.selectLooksUnfilled(control)) continue;
        let ok = false;
        for (const c of candidates.length ? candidates : [val]) {
          ok = controlFillTools.fillSelect(control, c, "evaluate:storage");
          if (!ok) {
            const r = controlFillTools.pickBestOptionScoreResult(control, c, 40);
            if (r.index >= 0) ok = controlFillTools.applySelectIndex(control, r.index, "evaluate:storage");
          }
          if (ok) break;
        }
        if (!ok) {
          diagnosis.push({
            state: "storage_hint_no_match",
            control: "select",
            candidateSnippet: fieldDescriptorTools.candidateTextForSelect(control).slice(0, 80)
          });
          continue;
        }
        usedKey.add(key);
        applied += 1;
        decisions.push({
          profileKey: "storageHint",
          reason: "stored_domain_hint",
          candidate: fieldDescriptorTools.extendedGuessContext(control).slice(0, 120),
          field: control.name || control.id || "select"
        });
        diagnosis.push({
          state: "filled_storage_hint",
          profileKey: "storageHint",
          candidateSnippet: fieldDescriptorTools.candidateTextForSelect(control).slice(0, 80),
          control: "select"
        });
        continue;
      }

      if (control instanceof HTMLTextAreaElement) {
        if ((control.value || "").trim()) continue;
        controlFillTools.fillInput(control, val, "evaluate:storage");
        usedKey.add(key);
        applied += 1;
        decisions.push({
          profileKey: "storageHint",
          reason: "stored_domain_hint",
          candidate: fieldDescriptorTools.extendedGuessContext(control).slice(0, 120),
          field: control.name || control.id || "textarea"
        });
        diagnosis.push({
          state: "filled_storage_hint",
          profileKey: "storageHint",
          candidateSnippet: fieldDescriptorTools.candidateTextForField(control).slice(0, 80),
          control: "textarea"
        });
        continue;
      }

      if (!(control instanceof HTMLInputElement)) continue;
      const inputType = (control.type || "text").toLowerCase();
      if (inputType === "radio") {
        const target = choiceControlTools.findMatchingRadioInGroup(control, candidates);
        if (!target) continue;
        if (!choiceControlTools.setChecked(target)) continue;
        usedKey.add(key);
        applied += 1;
        decisions.push({
          profileKey: "storageHint",
          reason: "stored_domain_hint_radio",
          candidate: fieldDescriptorTools.extendedGuessContext(target).slice(0, 120),
          field: target.name || target.id || "radio"
        });
        diagnosis.push({
          state: "filled_storage_hint",
          profileKey: "storageHint",
          candidateSnippet: fieldDescriptorTools.candidateTextForField(target).slice(0, 80),
          control: "radio"
        });
        continue;
      }
      if (inputType === "checkbox") {
        if (control.checked) continue;
        const optionText = normalize(`${control.value || ""} ${choiceControlTools.checkboxOrRadioLabel(control)}`.trim());
        let match = false;
        for (const c of candidates) {
          const n = normalize(c);
          if (!n) continue;
          if (
            choiceControlTools.checkboxCandidateMatchesOption(optionText, n) ||
            ["yes", "true", "checked", "on"].includes(n)
          ) {
            match = true;
            break;
          }
        }
        if (!match) continue;
        if (!choiceControlTools.selectCheckboxChoice(control, candidates)) continue;
        usedKey.add(key);
        applied += 1;
        decisions.push({
          profileKey: "storageHint",
          reason: "stored_domain_hint_checkbox",
          candidate: fieldDescriptorTools.extendedGuessContext(control).slice(0, 120),
          field: control.name || control.id || "checkbox"
        });
        diagnosis.push({
          state: "filled_storage_hint",
          profileKey: "storageHint",
          candidateSnippet: fieldDescriptorTools.candidateTextForField(control).slice(0, 80),
          control: "checkbox"
        });
        continue;
      }
      if ((control.value || "").trim()) continue;

      const fillVal = candidates[0] || val;
      const hasAnyProfileUrl = Boolean(profile?.linkedin?.trim() || profile?.github?.trim() || profile?.website?.trim());
      const controlPromptText = `${fieldDescriptorTools.candidateTextForField(control)} ${fieldDescriptorTools.extendedGuessContext(control)}`;
      if (!hasAnyProfileUrl && isSocialOrWebsitePromptText(controlPromptText)) continue;
      // Never inject raw UUIDs — these are ATS internal option IDs that corrupt state
      if (/^[0-9a-f]{32}$/i.test(fillVal) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(fillVal)) continue;
      // Skip inputs that are backing elements inside an ARIA combobox container
      if (control.closest('[role="combobox"], [aria-haspopup="listbox"]') ||
          control.parentElement?.querySelector('[role="combobox"], [aria-haspopup="listbox"]')) continue;

      controlFillTools.fillInput(control, fillVal, "evaluate:storage");
      usedKey.add(key);
      applied += 1;
      decisions.push({
        profileKey: "storageHint",
        reason: "stored_domain_hint",
        candidate: fieldDescriptorTools.extendedGuessContext(control).slice(0, 120),
        field: control.name || control.id || control.type
      });
      diagnosis.push({
        state: "filled_storage_hint",
        profileKey: "storageHint",
        candidateSnippet: fieldDescriptorTools.candidateTextForField(control).slice(0, 80),
        control: "input"
      });
    }

    return { applied, decisions, diagnosis };
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function buildWebsiteEntries(profile) {
    const entries = [];
    if (profile?.linkedin?.trim()) entries.push({ name: "LinkedIn", url: profile.linkedin.trim() });
    if (profile?.github?.trim()) entries.push({ name: "GitHub", url: profile.github.trim() });
    if (profile?.website?.trim()) entries.push({ name: "Portfolio", url: profile.website.trim() });
    return entries;
  }

  function resumeRepeatableTargets(profile) {
    const resumeData = profile?.__resumeData;
    if (!resumeData || typeof resumeData !== "object") {
      return { education: 1, experience: 1, website: buildWebsiteEntries(profile).length };
    }
    const education = Array.isArray(resumeData.education) ? resumeData.education.length : 0;
    const experience = Array.isArray(resumeData.experience) ? resumeData.experience.length : 0;
    const internships = Array.isArray(resumeData.internships) ? resumeData.internships.length : 0;
    return {
      education: Math.max(1, Math.min(6, education || 1)),
      experience: Math.max(1, Math.min(8, experience + internships || 1)),
      website: Math.min(5, buildWebsiteEntries(profile).length)
    };
  }

  function repeatableKindFromText(text) {
    return profileFieldCatalog.repeatableKindFromText?.(text) || "";
  }

  function isSafeExpandableAddButtonText(text) {
    const label = normalize(text);
    if (!label) return false;
    if (/^(back|previous|prev|next|continue|save(?: and continue)?|submit|cancel|close|done|finish|review)$/i.test(label)) return false;
    if (/\b(delete|remove|upload|select files?|browse)\b/i.test(label)) return false;
    return /\badd\b|add another|add item|add entry|add row/i.test(label);
  }

  function repeatableSectionLabel(section) {
    if (!(section instanceof Element)) return "";
    const directHeading = section.querySelector?.(":scope > legend, :scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > label")?.textContent || "";
    return [
      directHeading,
      section.getAttribute("aria-label"),
      section.getAttribute("data-automation-id"),
      section.getAttribute("data-qa"),
      section.getAttribute("data-testid"),
      section.getAttribute("id"),
      section.className
    ].filter(Boolean).join(" ");
  }

  function closestRepeatableSection(el) {
    let node = el instanceof Element ? el : null;
    let fallback = null;
    for (let depth = 0; depth < 8 && node; depth += 1, node = node.parentElement) {
      if (!node.matches?.("fieldset, section, article, [role='group'], [data-automation-id], div")) continue;
      const label = repeatableSectionLabel(node);
      if (repeatableKindFromText(label)) return node;
      if (!fallback && label) fallback = node;
    }
    return fallback;
  }

  function countRowsByStableId(section, sectionKind) {
    if (!(section instanceof Element)) return 0;
    const prefix = sectionKind === "experience"
      ? "workExperience"
      : sectionKind === "education"
        ? "education"
        : "";
    if (!prefix) return 0;
    const seen = new Set();
    for (const control of controlFillTools.collectFormControls(section)) {
      if (!controlFillTools.isVisibleForScrape(control)) continue;
      const id = String(control.id || "");
      const match = new RegExp(`\\b${prefix}[_-](\\d+)\\b`, "i").exec(id);
      if (match) seen.add(match[1]);
    }
    return seen.size;
  }

  function repeatableControlKind(control, sectionKind) {
    if (sectionKind === "generic") {
      if (!controlFillTools.isVisibleForScrape(control)) return false;
      if (control instanceof HTMLInputElement) {
        const type = (control.type || "text").toLowerCase();
        return !["hidden", "submit", "button", "reset", "image", "file"].includes(type);
      }
      return control instanceof HTMLSelectElement || control instanceof HTMLTextAreaElement;
    }
    const text = normalize(`${fieldDescriptorTools.candidateTextForControl(control)} ${fieldDescriptorTools.extendedGuessContext(control)}`);
    if (sectionKind === "education") {
      return !!profileFieldCatalog.repeatableFieldKindFromText?.("education", text);
    }
    if (sectionKind === "experience") {
      return !!profileFieldCatalog.repeatableFieldKindFromText?.("experience", text);
    }
    if (sectionKind === "website") {
      return !!profileFieldCatalog.repeatableFieldKindFromText?.("website", text);
    }
    return false;
  }

  function countRepeatableRows(section, sectionKind) {
    if (!(section instanceof Element)) return 0;
    const stableIdRows = countRowsByStableId(section, sectionKind);
    if (stableIdRows > 0) return stableIdRows;
    if (sectionKind === "education" || sectionKind === "experience") {
      const explicitRows = Array.from(section.querySelectorAll("fieldset, section, article, [role='group'], [data-automation-id], div"))
        .filter((el) => {
          const heading = fieldDescriptorTools.directGroupHeading(el);
          return repeatableKindFromText(heading) === sectionKind && /\b\d+\b/.test(heading);
        });
      if (explicitRows.length) return explicitRows.length;
    }
    const controls = controlFillTools.collectFormControls(section).filter((control) => repeatableControlKind(control, sectionKind));
    if (!controls.length) return 0;
    const rowContainers = new Set();
    for (const control of controls) {
      let row = control.parentElement;
      for (let depth = 0; depth < 6 && row && section.contains(row); depth += 1, row = row.parentElement) {
        const parent = row.parentElement;
        if (!parent || !section.contains(parent)) continue;
        const siblings = Array.from(parent.children).filter((x) => x instanceof Element && x.querySelector("input, select, textarea"));
        if (siblings.length >= 2 && siblings.includes(row)) {
          rowContainers.add(row);
          break;
        }
      }
    }
    const controlsPerRow = sectionKind === "experience" ? 6 : 5;
    return Math.max(1, rowContainers.size || Math.ceil(controls.length / controlsPerRow));
  }

  function collectRepeatableAddButtonFields(profile) {
    const targets = resumeRepeatableTargets(profile);
    const candidates = [];
    const seenSections = new Set();
    for (const button of Array.from(document.querySelectorAll("button, [role='button'], a"))) {
      if (!(button instanceof HTMLElement)) continue;
      if (!controlFillTools.isVisibleForScrape(button)) continue;
      if (button.disabled || button.getAttribute("aria-disabled") === "true") continue;
      const buttonText = normalize([
        button.textContent,
        button.getAttribute("aria-label"),
        button.getAttribute("title"),
        button.getAttribute("data-automation-id")
      ].filter(Boolean).join(" "));
      if (!isSafeExpandableAddButtonText(buttonText)) continue;
      const section = closestRepeatableSection(button);
      const kind = repeatableKindFromText(repeatableSectionLabel(section)) || repeatableKindFromText(buttonText) || "generic";
      if (!section || !kind || kind === "generic" || seenSections.has(section)) continue;
      const targetRows = kind === "generic" ? 1 : (targets[kind] || 1);
      const rows = countRepeatableRows(section, kind);
      if (rows >= targetRows) continue;
      seenSections.add(section);
      candidates.push({
        kind,
        button,
        section,
        rows,
        targetRows,
        label: repeatableSectionLabel(section)
      });
    }
    return candidates;
  }

  async function runDeterministicFill(profile) {
    const { baseProfile, storedHints } = splitProfileAndStoredHints(profile);
    const decisions = [];
    let filledCount = 0;
    let llmRecommended = false;
    let lastControlCount = 0;
    let disabilityChoiceTouched = false;
    const touchedControls = new WeakSet();
    const completedFieldKeys = new Set();
    const processedRepeatableSections = new WeakSet();
    debugLog("run:start", {
      url: location.href,
      storedHints: storedHints.length,
      hasDisabilityStatus: !!String(baseProfile.disabilityStatus || "").trim()
    });

    function completionKey(mapped, control) {
      if (!mapped?.profileKey) return "";
      const row = control instanceof Element
        ? (fieldDescriptorTools.findExplicitResumeRowContainer(control)?.index || fieldDescriptorTools.getRowIndex(fieldDescriptorTools.findRepeatedRowContainer(control)) || "")
        : "";
      const section = control instanceof Element ? normalize(fieldDescriptorTools.getSemanticSectionPath(control)).slice(0, 80) : "";
      const candidate = normalize(mapped.candidate || "").slice(0, 160);
      return [mapped.profileKey, row, section, candidate].filter(Boolean).join("|");
    }

    function isCompletedField(mapped, control) {
      const key = completionKey(mapped, control);
      return !!key && completedFieldKeys.has(key);
    }

    function markCompletedField(mapped, control) {
      const key = completionKey(mapped, control);
      if (key) completedFieldKeys.add(key);
      if (control instanceof Element) touchedControls.add(control);
    }

    function isInsideProcessedRepeatableSection(el) {
      if (!(el instanceof Element)) return false;
      let node = el;
      while (node && node instanceof Element) {
        if (processedRepeatableSections.has(node)) return true;
        node = node.parentElement;
      }
      return false;
    }

    if (storedHints.length) {
      const hintResult = applyStoredDomainHints(storedHints);
      filledCount += hintResult.applied;
      decisions.push(...hintResult.decisions);
    }

    // Fill a specific list of controls in visual (document) order.
    async function fillControlsList(controls, options = {}) {
      const sorted = controlFillTools.sortElementsByVisualOrder(controls);
      lastControlCount += sorted.length;
      for (const control of sorted) {
        if (control instanceof Element && touchedControls.has(control)) continue;
        if (options.skipProcessedRepeatables && isInsideProcessedRepeatableSection(control)) continue;
        if (!(control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement || control instanceof HTMLSelectElement)) {
          if (control instanceof Element && choiceControlTools.checkableType(control) === "checkbox") {
            if (choiceControlTools.checkableChecked(control)) continue;
            const context = normalize([
              fieldDescriptorTools.getSemanticSectionPath(control),
              choiceControlTools.choiceGroupLabel(choiceControlTools.choiceGroupRoot(control, "checkbox"), control),
              choiceControlTools.checkboxOrRadioLabel(control)
            ].filter(Boolean).join(" "));
            if (!demographicFieldTools.isDisabilityContext(context)) continue;
            const value = resolveDisabilityProfileValue(baseProfile);
            const candidates = demographicFieldTools.choiceCandidatesForProfileValue(value, "disabilityStatus");
            await sleep(5);
            if (choiceControlTools.selectCheckboxChoice(control, candidates)) {
              const target = choiceControlTools.findMatchingCheckboxInGroup(control, candidates) || control;
              disabilityChoiceTouched = true;
              filledCount += 1;
              markCompletedField({ profileKey: "disabilityStatus", candidate: context }, target);
              decisions.push({
                profileKey: "disabilityStatus",
                reason: "rule+role_checkbox_group_or_label",
                candidate: context.slice(0, 160),
                field: target.getAttribute?.("aria-label") || target.id || "checkbox"
              });
            }
            continue;
          }
          await fillCustomDropdownTrigger(control, options);
          continue;
        }
        if (control instanceof HTMLSelectElement) {
          if (control.disabled) continue;
          if (!controlFillTools.selectLooksUnfilled(control)) continue;
          const mapped = resolveMappedValueStrict(control, baseProfile);
          if (!mapped) continue;
          if (isCompletedField(mapped, control)) continue;
          control.scrollIntoView?.({ behavior: "smooth", block: "center", inline: "nearest" });
          await sleep(5);
          let selected = controlFillTools.fillSelect(control, mapped.value, "deterministic");
          let reason = `${mapped.reason}+select`;
          if (!selected && isEducationChoiceControl(control)) {
            const near = controlFillTools.pickBestOptionScoreResult(control, mapped.value, 38);
            if (near.index >= 0) {
              selected = controlFillTools.applySelectIndex(control, near.index, "deterministic:closest");
              if (selected) reason = `${mapped.reason}+select_closest`;
            }
          }
          if (!selected) {
            if (isEducationChoiceControl(control)) {
              llmRecommended = true;
              decisions.push({
                profileKey: mapped.profileKey,
                reason: "needs_llm_closest_match",
                candidate: mapped.candidate,
                field: control.name || control.id || "select"
              });
            }
            continue;
          }
          filledCount += 1;
          markCompletedField(mapped, control);
          decisions.push({
            profileKey: mapped.profileKey,
            reason,
            candidate: mapped.candidate,
            field: control.name || control.id || "select"
          });
          continue;
        }

        if (!(control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement)) {
          continue;
        }
        if (control.disabled || control.readOnly) continue;

        if (control instanceof HTMLInputElement && (control.type || "").toLowerCase() === "password") {
          control.scrollIntoView?.({ behavior: "smooth", block: "center", inline: "nearest" });
          await sleep(5);
          if (!fillRegisterPasswordIfApplicable(control, baseProfile, "deterministic:register")) continue;
          const isConfirm = isConfirmPasswordControl(control);
          filledCount += 1;
          markCompletedField(
            { profileKey: "registerPassword", candidate: isConfirm ? "confirm_password" : "password" },
            control
          );
          decisions.push({
            profileKey: "registerPassword",
            reason: isConfirm ? "register_password_confirm" : "register_password",
            candidate: isConfirm ? "confirm_password" : "password",
            field: control.name || control.id || "password"
          });
          continue;
        }

        if (control.type === "hidden" || control.type === "submit" || control.type === "button") continue;
        if (control instanceof HTMLInputElement && (control.type || "").toLowerCase() === "checkbox") {
          if (control.checked) continue;
          let mapped = resolveMappedValueStrict(control, baseProfile);
          let target = null;
          if (!mapped) {
            const context = normalize([
              fieldDescriptorTools.getSemanticSectionPath(control),
              choiceControlTools.choiceGroupLabel(choiceControlTools.choiceGroupRoot(control, "checkbox"), control),
              choiceControlTools.checkboxOrRadioLabel(control)
            ].filter(Boolean).join(" "));
            if (demographicFieldTools.isDisabilityContext(context)) {
              mapped = { profileKey: "disabilityStatus", value: resolveDisabilityProfileValue(baseProfile), reason: "rule", candidate: context };
              target = choiceControlTools.findMatchingCheckboxInGroup(control, demographicFieldTools.choiceCandidatesForProfileValue(mapped.value, mapped.profileKey));
            }
          }
          if (!mapped) continue;
          if (isCompletedField(mapped, control)) continue;
          if (!target && /^(yes|true|checked|on|1)$/i.test(String(mapped.value || "").trim())) target = control;
          if (!target) target = choiceControlTools.findMatchingCheckboxInGroup(control, demographicFieldTools.choiceCandidatesForProfileValue(mapped.value, mapped.profileKey));
          await sleep(180);
          if (choiceControlTools.selectCheckboxChoice(target || control, demographicFieldTools.choiceCandidatesForProfileValue(mapped.value, mapped.profileKey))) {
            const filledTarget = target || choiceControlTools.findMatchingCheckboxInGroup(control, demographicFieldTools.choiceCandidatesForProfileValue(mapped.value, mapped.profileKey)) || control;
            if (mapped.profileKey === "disabilityStatus") disabilityChoiceTouched = true;
            filledCount += 1;
            markCompletedField(mapped, filledTarget);
            decisions.push({
              profileKey: mapped.profileKey,
              reason: `${mapped.reason}+checkbox_or_label`,
              candidate: mapped.candidate,
              field: filledTarget.name || filledTarget.id || "checkbox"
            });
          }
          continue;
        }
        if (control.value?.trim()) continue;

        if (control instanceof HTMLTextAreaElement) {
          const largeAssist = globalThis.__formFillerPageFormTools?.isLargeTextareaForAiAssist;
          if (typeof largeAssist === "function" && largeAssist(control)) continue;
        }

        const selfIdDateValue = selfIdentifyDatePartValue(control);
        if (selfIdDateValue) {
          debugLog("self_identify_date:fill", {
            value: selfIdDateValue,
            label: control.getAttribute("aria-label") || "",
            id: control.id || "",
            context: fieldDescriptorTools.extendedGuessContext(control).slice(0, 180)
          });
          if (fillSelfIdentifyDateInput(control, selfIdDateValue)) {
            filledCount += 1;
            markCompletedField({ profileKey: "selfIdentifyDate", candidate: fieldDescriptorTools.extendedGuessContext(control) }, control);
            decisions.push({
              profileKey: "selfIdentifyDate",
              reason: "rule+self_identify_date",
              candidate: fieldDescriptorTools.extendedGuessContext(control).slice(0, 160),
              field: control.name || control.id || control.type
            });
          }
          continue;
        }

        const mapped = resolveMappedValueStrict(control, baseProfile);
        if (!mapped) continue;
        if (isCompletedField(mapped, control)) continue;
        if (control instanceof HTMLInputElement && isLikelyDropdownSearchInput(control, fieldDescriptorTools.extendedGuessContext(control))) {
          const shared = globalThis.__formFillerBrowserActions;
          if (shared && typeof shared.selectCustomDropdown === "function") {
            control.scrollIntoView?.({ behavior: "smooth", block: "center", inline: "nearest" });
            await sleep(180);
            const selected = await shared.selectCustomDropdown({
              element: control,
              autoId: getComboboxAutoId(control),
              label: fieldDescriptorTools.getPlaywrightSemanticParts(control).name || mapped.candidate,
              value: mapped.value
            });
            if (selected?.ok) {
              controlFillTools.tagFilledControlAfterWrite(control, mapped.value, "deterministic:custom_dropdown");
              filledCount += 1;
              markCompletedField(mapped, control);
              decisions.push({
                profileKey: mapped.profileKey,
                reason: `${mapped.reason}+custom_dropdown`,
                candidate: mapped.candidate,
                field: control.name || control.id || control.type
              });
              continue;
            }
          }
          llmRecommended = true;
          decisions.push({
            profileKey: mapped.profileKey,
            reason: "needs_dropdown_option_selection",
            candidate: mapped.candidate,
            field: control.name || control.id || control.type
          });
          continue;
        }

        control.scrollIntoView?.({ behavior: "smooth", block: "center", inline: "nearest" });
        await sleep(180);
        if (!controlFillTools.fillInput(control, mapped.value, "deterministic")) continue;
        filledCount += 1;
        markCompletedField(mapped, control);
        decisions.push({
          profileKey: mapped.profileKey,
          reason: mapped.reason,
          candidate: mapped.candidate,
          field: control.name || control.id || control.type
        });
      }
    }

    function isCustomDropdownTriggerElement(trigger) {
      if (!(trigger instanceof HTMLElement)) return false;
      if (trigger instanceof HTMLInputElement || trigger instanceof HTMLTextAreaElement || trigger instanceof HTMLSelectElement) return false;
      if (!controlFillTools.isVisibleForScrape(trigger) || trigger.disabled || trigger.getAttribute("aria-disabled") === "true") return false;
      if (trigger.closest('header, nav, [role="navigation"], [role="banner"], [role="toolbar"], [role="menubar"]')) return false;
      const displayText = normalize(String(trigger.textContent || ""));
      if (!controlFillTools.isPlaceholderOptionText(displayText)) return false;
      const ctx = normalize(`${fieldDescriptorTools.extendedGuessContext(trigger)} ${fieldDescriptorTools.candidateTextForControl(trigger)}`);
      const fieldKind = profileFieldCatalog.repeatableFieldKindFromText?.("education", ctx) || "";
      return fieldKind === "degree" || fieldKind === "major";
    }

    function collectCustomDropdownTriggers(root) {
      return Array.from((root || document).querySelectorAll(
        '[role="combobox"]:not(input):not(textarea):not(select), button[aria-haspopup="listbox"], [aria-haspopup="listbox"]:not(input):not(textarea):not(select), button'
      )).filter(isCustomDropdownTriggerElement);
    }

    async function fillCustomDropdownTrigger(trigger, options = {}) {
      const shared = globalThis.__formFillerBrowserActions;
      if (!shared || typeof shared.selectCustomDropdown !== "function") return false;
      if (!isCustomDropdownTriggerElement(trigger)) return false;
      if (options.skipProcessedRepeatables && isInsideProcessedRepeatableSection(trigger)) return false;
      const mapped = resolveMappedValueStrict(trigger, baseProfile);
      if (!mapped?.value) return false;
      if (isCompletedField(mapped, trigger)) return false;
      trigger.scrollIntoView?.({ behavior: "smooth", block: "center", inline: "nearest" });
      await sleep(180);
      const selected = await shared.selectCustomDropdown({
        element: trigger,
        autoId: getComboboxAutoId(trigger),
        label: fieldDescriptorTools.getPlaywrightSemanticParts(trigger).name || mapped.candidate,
        value: mapped.value
      });
      if (!selected?.ok) {
        llmRecommended = true;
        decisions.push({
          profileKey: mapped.profileKey,
          reason: "needs_dropdown_option_selection",
          candidate: mapped.candidate,
          field: trigger.getAttribute("name") || trigger.id || "button"
        });
        return false;
      }
      controlFillTools.tagFilledControlAfterWrite(trigger, mapped.value, "deterministic:custom_dropdown_trigger");
      filledCount += 1;
      markCompletedField(mapped, trigger);
      decisions.push({
        profileKey: mapped.profileKey,
        reason: `${mapped.reason}+custom_dropdown_trigger`,
        candidate: mapped.candidate,
        field: trigger.getAttribute("name") || trigger.id || "button"
      });
      return true;
    }

    async function fillCustomDropdownTriggers(root) {
      await fillControlsList(collectCustomDropdownTriggers(root));
    }

    async function fillContainer(root, options = {}) {
      const controls = choiceControlTools.collectFormControlsAndRoleCheckables(root || document);
      const triggers = collectCustomDropdownTriggers(root || document);
      const seen = new Set();
      const combined = [];
      for (const el of [...controls, ...triggers]) {
        if (!el || seen.has(el)) continue;
        seen.add(el);
        combined.push(el);
      }
      await fillControlsList(combined, options);
    }

    async function fillDisabilitySelfIdentifyByVisibleText() {
      const pageText = normalize(document.body?.innerText || "");
      if (!demographicFieldTools.isDisabilitySelfIdentifyPage(pageText)) return false;
      if (disabilityChoiceTouched) {
        debugLog("checkbox:disability_visible_fallback:skip_touched_this_run");
        return false;
      }
      debugLog("checkbox:disability_visible_fallback:seen_page");
      if (disabilityChoiceAlreadySelected()) {
        debugLog("checkbox:disability_visible_fallback:skip_already_selected");
        return false;
      }
      const candidates = demographicFieldTools.choiceCandidatesForProfileValue(resolveDisabilityProfileValue(baseProfile), "disabilityStatus");
      debugLog("checkbox:disability_visible_fallback:candidates", {
        resolvedValue: resolveDisabilityProfileValue(baseProfile),
        candidates
      });
      if (!candidates.length) return false;
      await sleep(40);
      if (disabilityChoiceAlreadySelected()) {
        debugLog("checkbox:disability_visible_fallback:skip_selected_after_wait");
        return false;
      }
      if (!choiceControlTools.clickMatchingChoiceLabel(document, candidates)) return false;
      filledCount += 1;
      decisions.push({
        profileKey: "disabilityStatus",
        reason: "rule+visible_disability_option_text",
        candidate: candidates[0].slice(0, 160),
        field: "checkbox"
      });
      return true;
    }

    const repeatableFieldPosition = (field) => {
      const target = field.section instanceof Element ? field.section : field.button;
      const rect = target?.getBoundingClientRect?.() || field.button.getBoundingClientRect?.() || { top: 0, left: 0 };
      return {
        top: rect.top + (window.scrollY || 0),
        left: rect.left + (window.scrollX || 0)
      };
    };
    const sortByPagePosition = (a, b) => {
      const ar = repeatableFieldPosition(a);
      const br = repeatableFieldPosition(b);
      return (ar.top - br.top) || (ar.left - br.left);
    };

    async function processRepeatablesInPageOrder() {
      let addGuard = 0;
      while (addGuard <= 16) {
        const needsExpand = collectRepeatableAddButtonFields(baseProfile)
          .sort(sortByPagePosition);
        if (!needsExpand.length) break;

        const field = needsExpand.find((candidate) => candidate.rows < candidate.targetRows);
        if (!field) break;

        // Process only the topmost incomplete section. On the next loop, if it still
        // needs rows, it remains topmost and gets the next add/fill before lower sections.
        await fillContainer(field.section);
        if (field.section instanceof Element) processedRepeatableSections.add(field.section);

        const prevControlSet = new Set(controlFillTools.collectFormControls(document));
        const prevTriggerSet = new Set(collectCustomDropdownTriggers(document));
        field.button.scrollIntoView?.({ block: "center", inline: "center" });
        field.button.click();
        addGuard += 1;
        decisions.push({
          profileKey: `${field.kind}Rows`,
          reason: "repeatable_add_button_expand",
          candidate: `[group:${field.label || field.kind}] add button`,
          field: "button:Add"
        });
        await sleep(450);

        const newControls = controlFillTools.collectFormControls(document).filter((control) => !prevControlSet.has(control));
        const newTriggers = collectCustomDropdownTriggers(document).filter((trigger) => !prevTriggerSet.has(trigger));
        const newFillables = [...newControls, ...newTriggers];
        if (newFillables.length) {
          await fillControlsList(newFillables);
        } else {
          await fillContainer(field.section);
          if (field.section instanceof Element) processedRepeatableSections.add(field.section);
        }
      }
    }

    // Interleave by page order: process whichever repeatable section appears first,
    // fill its visible row(s), add the next row, fill it, then continue downward.
    await processRepeatablesInPageOrder();
    await fillContainer(document, { skipProcessedRepeatables: true });
    await fillDisabilitySelfIdentifyByVisibleText();
    debugLog("run:end", {
      filledCount,
      decisions,
      llmRecommended
    });

    return {
      filledCount,
      decisions,
      unresolved: Math.max(0, lastControlCount - filledCount),
      llmRecommended,
      timestamp: new Date().toISOString()
    };
  }

  const REGISTER_DEFAULT_PASSWORD = "FormFiller#2026!";

  function detectRegisterIntentForPage() {
    const pageContext = normalize(`${document.title || ""} ${location.pathname || ""} ${location.search || ""}`);
    const bodyText = normalize(document.body?.innerText || "").slice(0, 8000);
    const combined = `${pageContext} ${bodyText}`;
    const hasRegister = /\bregister\b/.test(combined) || /\bcreate account|create an account|new account\b/.test(combined);
    const hasSignup = /\bsign[\s-]?up\b/.test(combined);
    const hasSignin = /\bsign[\s-]?in|log[\s-]?in|login\b/.test(combined);
    const hasNewPasswordField = !!document.querySelector('input[autocomplete="new-password"]');
    const registerScore = (hasRegister ? 2 : 0) + (hasSignup ? 2 : 0) + (hasNewPasswordField ? 1 : 0);
    const signinScore = hasSignin ? 1 : 0;
    return registerScore >= 2 && registerScore >= signinScore;
  }

  function isConfirmPasswordControl(control) {
    if (!(control instanceof HTMLInputElement)) return false;
    const hay = normalize(
      [
        control.name,
        control.id,
        control.getAttribute("aria-label"),
        control.getAttribute("placeholder")
      ]
        .filter(Boolean)
        .join(" ")
    );
    return /\b(confirm|re-enter|reenter|repeat|verify)\b/.test(hay) && /\bpassword|passcode\b/.test(hay);
  }

  /**
   * Fill empty password / confirm-password on sign-up style pages only (same guard as runRegisterFill).
   * Used by unified Fill / deterministic pass so Fill covers registration flows.
   */
  function fillRegisterPasswordIfApplicable(control, baseProfile, traceTag) {
    if (!(control instanceof HTMLInputElement) || (control.type || "").toLowerCase() !== "password") {
      return false;
    }
    if (!detectRegisterIntentForPage()) return false;
    if (control.disabled || control.readOnly || control.value?.trim()) return false;
    const registerPassword = resolveRegisterPassword(baseProfile);
    const isConfirm = isConfirmPasswordControl(control);
    const tag = isConfirm ? `${traceTag}:confirm` : traceTag;
    return !!controlFillTools.fillInput(control, registerPassword, tag);
  }

  function resolveRegisterPassword(profile) {
    const explicit = String(profile?.registerPassword || "").trim();
    if (explicit) return explicit;
    return REGISTER_DEFAULT_PASSWORD;
  }

  function runRegisterFill(profile) {
    const { baseProfile, storedHints } = splitProfileAndStoredHints(profile);
    const controls = controlFillTools.collectFormControls(document);
    const decisions = [];
    let filledCount = 0;
    const isRegisterContext = detectRegisterIntentForPage();
    const registerPassword = resolveRegisterPassword(baseProfile);
    if (!isRegisterContext) {
      return {
        filledCount: 0,
        decisions: [],
        unresolved: controls.length,
        timestamp: new Date().toISOString(),
        skipped: true,
        reason: "not_register_context"
      };
    }

    if (storedHints.length) {
      const hintResult = applyStoredDomainHints(storedHints);
      filledCount += hintResult.applied;
      decisions.push(...hintResult.decisions);
    }

    for (const control of controls) {
      if (control instanceof HTMLSelectElement) {
        if (control.disabled || !controlFillTools.selectLooksUnfilled(control)) continue;
        const mapped = resolveMappedValueStrict(control, baseProfile);
        if (!mapped) continue;
        if (!controlFillTools.fillSelect(control, mapped.value, "register")) continue;
        filledCount += 1;
        decisions.push({
          profileKey: mapped.profileKey,
          reason: `${mapped.reason}+register`,
          candidate: mapped.candidate,
          field: control.name || control.id || "select"
        });
        continue;
      }
      if (!(control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement)) continue;
      if (control.disabled || control.readOnly) continue;
      if (control.type === "hidden" || control.type === "submit" || control.type === "button") continue;
      if (control.value?.trim()) continue;

      if (control instanceof HTMLInputElement && control.type === "password") {
        const isConfirm = isConfirmPasswordControl(control);
        if (!controlFillTools.fillInput(control, registerPassword, isConfirm ? "register:password:confirm" : "register:password")) continue;
        filledCount += 1;
        decisions.push({
          profileKey: "registerPassword",
          reason: isConfirm ? "register_password_confirm" : "register_password",
          candidate: isConfirm ? "confirm_password" : "password",
          field: control.name || control.id || control.type
        });
        continue;
      }

      const mapped = resolveMappedValueStrict(control, baseProfile);
      if (!mapped) continue;
      if (!controlFillTools.fillInput(control, mapped.value, "register")) continue;
      filledCount += 1;
      decisions.push({
        profileKey: mapped.profileKey,
        reason: `${mapped.reason}+register`,
        candidate: mapped.candidate,
        field: control.name || control.id || control.type
      });
    }

    return {
      filledCount,
      decisions,
      unresolved: Math.max(0, controls.length - filledCount),
      timestamp: new Date().toISOString()
    };
  }

  function selectMatchesProfileValue(select, profileValue) {
    const idx = controlFillTools.pickBestOptionIndex(select, profileValue);
    return idx >= 0 && idx === select.selectedIndex;
  }

  function runEvaluateAndFillBestGuess(profile) {
    const { baseProfile, storedHints } = splitProfileAndStoredHints(profile);
    const controls = controlFillTools.collectFormControls(document);
    const diagnosis = [];
    const decisions = [];
    let filledCount = 0;
    const consumedKeys = new Set();

    if (storedHints.length) {
      const hintResult = applyStoredDomainHints(storedHints);
      filledCount += hintResult.applied;
      decisions.push(...hintResult.decisions);
      diagnosis.push(...hintResult.diagnosis);
    }

    for (const control of controls) {
      if (control instanceof HTMLSelectElement) {
        if (control.disabled) {
          diagnosis.push({ state: "skipped", detail: "select_disabled" });
          continue;
        }

        const mapped = resolveMappedValueRelaxed(control, baseProfile);
        const currentVal = (control.value || "").trim();
        const currentLabel = control.selectedOptions[0]?.textContent?.trim() || "";
        const currentSnippet = `${currentVal} ${currentLabel}`.trim().slice(0, 60);
        const candidateSnippet = (mapped?.candidate || fieldDescriptorTools.candidateTextForSelect(control)).slice(0, 80);

        if (!mapped) {
          diagnosis.push({
            state: currentVal ? "nonempty_unmapped" : "empty_unmapped",
            candidateSnippet,
            currentSnippet,
            control: "select"
          });
          continue;
        }

        const { profileKey, value, reason } = mapped;
        if (!value) {
          diagnosis.push({
            state: "empty_no_profile_data",
            profileKey,
            candidateSnippet,
            control: "select"
          });
          continue;
        }

        if (selectMatchesProfileValue(control, value)) {
          consumedKeys.add(profileKey);
          diagnosis.push({
            state: "already_ok",
            profileKey,
            candidateSnippet,
            control: "select"
          });
          continue;
        }

        if (!controlFillTools.selectLooksUnfilled(control)) {
          diagnosis.push({
            state: "skipped_nonempty",
            profileKey,
            candidateSnippet,
            control: "select",
            note: "Evaluate only fills empty dropdowns."
          });
          continue;
        }

        if (!controlFillTools.fillSelect(control, value, "evaluate:pass1")) {
          diagnosis.push({
            state: "select_no_matching_option",
            profileKey,
            candidateSnippet,
            control: "select"
          });
          continue;
        }

        filledCount += 1;
        consumedKeys.add(profileKey);
        decisions.push({
          profileKey,
          reason: `${reason}+select`,
          candidate: mapped.candidate,
          field: control.name || control.id || "select"
        });
        diagnosis.push({
          state: "filled_gap",
          profileKey,
          candidateSnippet,
          control: "select"
        });
        continue;
      }

      if (!(control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement)) {
        continue;
      }
      if (control.type === "password" || control.disabled || control.readOnly) {
        diagnosis.push({
          state: "skipped",
          detail: control.type === "password" ? "password" : "disabled_or_readonly"
        });
        continue;
      }
      if (control.type === "hidden" || control.type === "submit" || control.type === "button") {
        diagnosis.push({ state: "skipped", detail: control.type });
        continue;
      }

      const mapped = resolveMappedValueRelaxed(control, baseProfile);
      const current = (control.value || "").trim();
      const candidateSnippet = (mapped?.candidate || fieldDescriptorTools.candidateTextForField(control)).slice(0, 80);

      if (!mapped) {
        diagnosis.push({
          state: current ? "nonempty_unmapped" : "empty_unmapped",
          candidateSnippet,
          currentSnippet: current.slice(0, 60)
        });
        continue;
      }

      const { profileKey, value, reason } = mapped;
      if (!value) {
        diagnosis.push({
          state: "empty_no_profile_data",
          profileKey,
          candidateSnippet
        });
        continue;
      }

      if (current && valuesLooselyMatch(current, value)) {
        consumedKeys.add(profileKey);
        diagnosis.push({
          state: "already_ok",
          profileKey,
          candidateSnippet
        });
        continue;
      }

      if (current) {
        diagnosis.push({
          state: "skipped_nonempty",
          profileKey,
          candidateSnippet,
          currentSnippet: current.slice(0, 60),
          note: "Evaluate only fills empty fields."
        });
        continue;
      }

      if (!controlFillTools.fillInput(control, value, "evaluate:pass1")) continue;
      filledCount += 1;
      consumedKeys.add(profileKey);
      decisions.push({
        profileKey,
        reason,
        candidate: mapped.candidate,
        field: control.name || control.id || control.type
      });
      diagnosis.push({
        state: "filled_gap",
        profileKey,
        candidateSnippet
      });
    }

    const filledCounter = { filledCount };
    runSecondPassGlobalGuess(baseProfile, consumedKeys, decisions, diagnosis, filledCounter);
    filledCount = filledCounter.filledCount;

    const missingNotes = [];
    const profileKeys = [
      "fullName", "firstName", "lastName", "email", "phone",
      "linkedin", "github", "website",
      "address", "city", "state", "zip", "country",
      "currentTitle", "currentCompany", "yearsOfExperience",
      "highestDegree", "major", "university", "graduationYear",
      "workAuthorization", "desiredSalary", "noticePeriod"
    ];
    for (const key of profileKeys) {
      if (!baseProfile[key]?.trim()) continue;
      if (!consumedKeys.has(key)) {
        missingNotes.push(`Profile ${key} not applied in this frame (no confident field).`);
      }
    }

    return {
      filledCount,
      decisions,
      diagnosis,
      missingNotes,
      unresolved: Math.max(0, controls.length - filledCount),
      timestamp: new Date().toISOString(),
      frameHost: typeof location !== "undefined" ? location.hostname : ""
    };
  }

  function isSkippableForSubmitSnapshot(control) {
    if (control.disabled || control.readOnly) return true;
    if (control instanceof HTMLInputElement) {
      const t = (control.type || "text").toLowerCase();
      if (
        t === "password" ||
        t === "file" ||
        t === "hidden" ||
        t === "submit" ||
        t === "button" ||
        t === "reset" ||
        t === "image"
      ) {
        return true;
      }
    }
    return false;
  }

  function getSubmitSnapshotValue(control) {
    if (control instanceof HTMLSelectElement) {
      const opt = control.selectedOptions[0];
      return `${control.value || ""}|${(opt?.textContent || "").trim()}`.trim();
    }
    if (control instanceof HTMLInputElement) {
      const t = (control.type || "text").toLowerCase();
      if (t === "checkbox" || t === "radio") {
        if (!control.checked) return "";
        const label = choiceControlTools.checkboxOrRadioLabel(control);
        return `${String(control.value || "on").trim()}|${label}`.trim();
      }
      return (control.value || "").trim();
    }
    if (control instanceof HTMLTextAreaElement) return (control.value || "").trim();
    return "";
  }

  /** Snapshot field values from a submitted form for persistence (same fingerprints as fill/LLM). */
  function collectFormSubmitHintEntries(form) {
    if (!(form instanceof HTMLFormElement)) return [];
    const entries = [];
    const seen = new Set();
    for (const control of controlFillTools.collectFormControls(form)) {
      if (isSkippableForSubmitSnapshot(control)) continue;
      const val = getSubmitSnapshotValue(control);
      if (!String(val || "").trim()) continue;
      // Don't snapshot UUID values — these are ATS internal option IDs, not user data
      if (/^[0-9a-f]{32}$/i.test(val) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val)) continue;
      const fp = fieldDescriptorTools.computeFieldFingerprint(control);
      if (!fp || seen.has(fp)) continue;
      seen.add(fp);
      const ctx = fieldDescriptorTools.extendedGuessContext(control).slice(0, 400);
      const controlKind =
        control instanceof HTMLSelectElement
          ? "select"
          : control instanceof HTMLTextAreaElement
            ? "textarea"
            : control instanceof HTMLInputElement
              ? (control.type || "text").toLowerCase()
              : "unknown";
      const fillSource = String(control.getAttribute("data-form-filler-source") || "").trim();
      const fillOrigin = String(control.getAttribute("data-form-filler-origin") || "").trim();
      const userEdited = control.getAttribute("data-form-filler-user-edited") === "true";
      entries.push({
        fingerprint: fp,
        value: String(val).slice(0, 500),
        labelContext: ctx,
        controlKind,
        fillSource,
        fillOrigin,
        userEdited
      });
    }
    return entries;
  }

  function collectUnfilledCandidates(profile) {
    const frameHost = typeof location !== "undefined" ? location.hostname : "";
    const candidates = [];
    const seen = new Set();

    for (const control of controlFillTools.sortElementsByVisualOrder(controlFillTools.collectFormControls(document))) {
      if (!controlFillTools.isVisibleForScrape(control)) continue;
      if (control.disabled || control.readOnly) continue;

      if (control instanceof HTMLSelectElement) {
        if (!controlFillTools.selectLooksUnfilled(control)) continue;
        // Do NOT skip selects that have a strict alias mapping — the deterministic pass
        // may have failed to fill them when the profile value doesn't lexically match
        // any option text (e.g. profile "Authorized to work in US" vs option "Yes").
        // Any select still empty at this point is a genuine gap for the LLM.
        const semantic = fieldDescriptorTools.getPlaywrightSemanticParts(control);
        const ctx = fieldDescriptorTools.extendedGuessContext(control);
        const ctxTrim = ctx.trim();
        if (
          !fieldDescriptorTools.hasEnoughSemanticSignal(semantic, 8) &&
          ctxTrim.length < 24
        ) {
          continue;
        }
        const fp = fieldDescriptorTools.computeFieldFingerprint(control);
        if (seen.has(fp)) continue;
        seen.add(fp);
        const opts = Array.from(control.options || [])
          .slice(0, 45)
          .map((o) => `${(o.value || "").trim()}: ${(o.textContent || "").trim()}`.slice(0, 72))
          .join(" | ");
        const optionLabels = Array.from(control.options || [])
          .slice(0, 45)
          .map((o) => String(o.textContent || "").trim())
          .filter(Boolean);
        candidates.push({
          fingerprint: fp,
          elementId: control.id || "",
          elementName: control.name || "",
          context: ctx.slice(0, 900),
          role: semantic.role,
          name: semantic.name,
          section: semantic.section,
          type: semantic.inputType || "select",
          helpText: fieldDescriptorTools.collectControlHelpText(control),
          kind: "select",
          options: optionLabels,
          optionsSummary: opts.slice(0, 1500),
          ...getVisualOrderMeta(control),
          frameHost
        });
        continue;
      }

      if (control instanceof HTMLTextAreaElement) {
        if ((control.value || "").trim()) continue;
        const largeAssist = globalThis.__formFillerPageFormTools?.isLargeTextareaForAiAssist;
        if (typeof largeAssist === "function" && largeAssist(control)) continue;
        if (resolveMappedValueStrict(control, profile)) continue;
        const semantic = fieldDescriptorTools.getPlaywrightSemanticParts(control);
        const ctx = fieldDescriptorTools.extendedGuessContext(control);
        const ctxTrimTa = ctx.trim();
        if (
          !fieldDescriptorTools.hasEnoughSemanticSignal(semantic, 10) &&
          ctxTrimTa.length < 24
        ) {
          continue;
        }
        const fp = fieldDescriptorTools.computeFieldFingerprint(control);
        if (seen.has(fp)) continue;
        seen.add(fp);
        candidates.push({
          fingerprint: fp,
          elementId: control.id || "",
          elementName: control.name || "",
          context: ctx.slice(0, 900),
          role: semantic.role,
          name: semantic.name,
          section: semantic.section,
          type: semantic.inputType || "textarea",
          helpText: fieldDescriptorTools.collectControlHelpText(control),
          kind: "textarea",
          ...getVisualOrderMeta(control),
          frameHost
        });
        continue;
      }

      if (!(control instanceof HTMLInputElement)) continue;
      if (!isGuessableTextControl(control)) continue;
      if ((control.value || "").trim()) continue;
      const t = (control.type || "text").toLowerCase();
      if (["email", "tel", "url"].includes(t)) continue;
      const semantic = fieldDescriptorTools.getPlaywrightSemanticParts(control);
      const ctx = fieldDescriptorTools.extendedGuessContext(control);
      const ctxTrim = ctx.trim();
      if (
        !fieldDescriptorTools.hasEnoughSemanticSignal(semantic, 10) &&
        ctxTrim.length < 24
      ) {
        continue;
      }
      const fp = fieldDescriptorTools.computeFieldFingerprint(control);
      if (seen.has(fp)) continue;
      seen.add(fp);
      if (isLikelyDropdownSearchInput(control, ctx)) {
        const autoId = getComboboxAutoId(control);
        if (autoId) {
          candidates.push({
            fingerprint: fp,
            elementId: control.id || "",
            elementName: control.name || "",
            context: ctx.slice(0, 900),
            role: semantic.role,
            name: semantic.name,
            section: semantic.section,
            type: semantic.inputType || "text",
            helpText: fieldDescriptorTools.collectControlHelpText(control),
            kind: "ariacombobox",
            autoId,
            ...getVisualOrderMeta(control),
            frameHost
          });
          continue;
        }
      }
      if (resolveMappedValueStrict(control, profile)) continue;
      candidates.push({
        fingerprint: fp,
        elementId: control.id || "",
        elementName: control.name || "",
        context: ctx.slice(0, 900),
        role: semantic.role,
        name: semantic.name,
        section: semantic.section,
        type: semantic.inputType || t,
        helpText: fieldDescriptorTools.collectControlHelpText(control),
        kind: t,
        ...getVisualOrderMeta(control),
        frameHost
      });
    }

    // Collect unanswered radio groups — demographic and other single-choice questions
    const seenGroups = new Set();
    for (const control of controlFillTools.sortElementsByVisualOrder(controlFillTools.collectFormControls(document))) {
      if (!controlFillTools.isVisibleForScrape(control)) continue;
      if (!(control instanceof HTMLInputElement)) continue;
      if ((control.type || "").toLowerCase() !== "radio") continue;
      if (control.disabled) continue;
      const groupName = (control.name || "").trim();
      if (!groupName || seenGroups.has(groupName)) continue;
      seenGroups.add(groupName);

      const root = control.form || control.closest("form") || document;
      const groupRadios = controlFillTools.sortElementsByVisualOrder(controlFillTools.collectFormControls(root)).filter(
        (x) =>
          x instanceof HTMLInputElement &&
          controlFillTools.isVisibleForScrape(x) &&
          (x.type || "").toLowerCase() === "radio" &&
          (x.name || "").trim() === groupName
      );
      if (groupRadios.some((r) => r.checked)) continue;

      const fp = fieldDescriptorTools.computeFieldFingerprint(control);
      const semantic = fieldDescriptorTools.getPlaywrightSemanticParts(control);
      if (seen.has(fp)) continue;
      seen.add(fp);

      const ctx = fieldDescriptorTools.extendedGuessContext(control);
      if (!fieldDescriptorTools.hasEnoughSemanticSignal(semantic, 6)) continue;

      const optsSummary = groupRadios
        .slice(0, 20)
        .map((r) => `${(r.value || "").trim()}: ${choiceControlTools.checkboxOrRadioLabel(r)}`.slice(0, 80))
        .join(" | ");
      const optionLabels = groupRadios
        .slice(0, 20)
        .map((r) => choiceControlTools.checkboxOrRadioLabel(r))
        .filter(Boolean);

      candidates.push({
        fingerprint: fp,
        elementId: control.id || "",
        elementName: control.name || "",
        context: ctx.slice(0, 900),
        role: semantic.role,
        name: semantic.name,
        section: semantic.section,
        type: semantic.inputType || "radio",
        helpText: fieldDescriptorTools.collectControlHelpText(control),
        kind: "radio",
        options: optionLabels,
        optionsSummary: optsSummary.slice(0, 1500),
        ...getVisualOrderMeta(control),
        frameHost
      });
    }

    // Workday renders some single-choice questions (for example disability self-ID)
    // as checkbox lists instead of radio groups. Treat the enclosing group as one field.
    const seenCheckboxGroups = new Set();
    for (const control of choiceControlTools.collectChoiceControls(document, "checkbox")) {
      if (!controlFillTools.isVisibleForScrape(control)) continue;
      if (choiceControlTools.checkableType(control) !== "checkbox") continue;
      if (choiceControlTools.checkableDisabled(control)) continue;

      const root = choiceControlTools.choiceGroupRoot(control, "checkbox");
      if (!root) continue;
      const groupLabel = choiceControlTools.choiceGroupLabel(root, control);
      if (!groupLabel) continue;
      const groupKey = `${fieldDescriptorTools.simpleHash(groupLabel)}|${getVisualOrderMeta(root).visualTop}`;
      if (seenCheckboxGroups.has(groupKey)) continue;
      seenCheckboxGroups.add(groupKey);

      const groupCheckboxes = choiceControlTools.collectChoiceControls(root, "checkbox");
      if (groupCheckboxes.length < 2 || groupCheckboxes.some((box) => choiceControlTools.checkableChecked(box))) continue;

      const first = groupCheckboxes[0];
      const fp = fieldDescriptorTools.computeFieldFingerprint(first);
      if (seen.has(fp)) continue;
      seen.add(fp);

      const semantic = fieldDescriptorTools.getPlaywrightSemanticParts(first);
      const optionLabels = groupCheckboxes
        .slice(0, 20)
        .map((box) => choiceControlTools.checkboxOrRadioLabel(box))
        .filter(Boolean);
      if (optionLabels.length < 2) continue;
      const optsSummary = groupCheckboxes
        .slice(0, 20)
        .map((box) => `${String(choiceControlTools.checkableValue(box) || "").trim()}: ${choiceControlTools.checkboxOrRadioLabel(box)}`.slice(0, 100))
        .join(" | ");

      candidates.push({
        fingerprint: fp,
        elementId: first.id || first.getAttribute?.("id") || "",
        elementName: first.name || first.getAttribute?.("name") || "",
        context: groupLabel.slice(0, 900),
        role: "group",
        name: groupLabel,
        section: semantic.section,
        type: "checkbox",
        helpText: fieldDescriptorTools.collectControlHelpText(first),
        kind: "checkbox",
        options: optionLabels,
        optionsSummary: optsSummary.slice(0, 1500),
        ...getVisualOrderMeta(root),
        frameHost
      });
    }

    return { candidates, frameHost };
  }

  /**
   * Collect unfilled custom ARIA dropdown widgets — any site that uses
   * role="combobox" / aria-haspopup="listbox" instead of native <select>.
   * Called only when the site skill signals needsAriaCombobox=true.
   */
  function collectAriaComboboxGaps() {
    const frameHost = typeof location !== "undefined" ? location.hostname : "";
    const candidates = [];
    const seen = new Set();
    const idSeen = new Set();
    const getDisplayText = (node) => {
      const clone = node.cloneNode(true);
      for (const icon of clone.querySelectorAll(
        'svg, [class*="icon"], [class*="arrow"], [class*="chevron"], [class*="caret"]'
      )) icon.remove();
      return clone.textContent.trim();
    };
    const isPlainSelectButton = (el, displayText, labelText) => {
      if (!(el instanceof HTMLButtonElement)) return false;
      if (el.matches('[role="combobox"], button[aria-haspopup], [aria-haspopup="listbox"]')) return false;
      if (!controlFillTools.isPlaceholderOptionText(displayText)) return false;
      const bag = normalize([
        displayText,
        labelText,
        el.getAttribute("aria-label"),
        el.getAttribute("id"),
        el.getAttribute("name"),
        el.className,
        fieldDescriptorTools.extendedGuessContext(el)
      ].filter(Boolean).join(" "));
      if (/\b(back|previous|prev|next|continue|save|submit|cancel|close|done|finish|review|delete|remove|upload|browse|select files?)\b/i.test(bag)) return false;
      const fieldKind = profileFieldCatalog.repeatableFieldKindFromText?.("education", bag) || "";
      return fieldKind === "degree" || fieldKind === "major";
    };

    // General selector: any trigger element for a custom dropdown
    for (const el of controlFillTools.sortElementsByVisualOrder(Array.from(document.querySelectorAll(
      '[role="combobox"], button[aria-haspopup="listbox"], [aria-haspopup="listbox"], button'
    )))) {
      if (!controlFillTools.isVisibleForScrape(el)) continue;
      if (el.disabled || el.getAttribute("aria-disabled") === "true") continue;
      if (el.closest('header, nav, [role="navigation"], [role="banner"], [role="toolbar"], [role="menubar"]')) continue;

      // Determine the displayed text, stripping icon/arrow child nodes
      const displayText = getDisplayText(el);

      if (!controlFillTools.isPlaceholderOptionText(displayText)) continue; // already has a value

      // Find the closest identifying wrapper (any data-* attribute system)
      const wrapper =
        el.closest("[data-automation-id]") ||
        el.closest("[data-qa]") ||
        el.closest("[data-testid]") ||
        el.closest("[data-field-name]") ||
        el.parentElement;
      const labelEl = (wrapper || el.parentElement)?.querySelector("label, legend, [class*='label']");
      const labelText = labelEl?.textContent?.trim() || "";
      if (!isPlainSelectButton(el, displayText, labelText) && !el.matches('[role="combobox"], button[aria-haspopup="listbox"], [aria-haspopup="listbox"]')) continue;

      const autoId =
        el.getAttribute("data-automation-id") ||
        el.getAttribute("data-qa") ||
        el.getAttribute("data-testid") ||
        el.id ||
        wrapper?.getAttribute("data-automation-id") ||
        wrapper?.getAttribute("data-qa") ||
        wrapper?.getAttribute("data-testid") ||
        fieldDescriptorTools.sanitizeContextChunk(el.getAttribute("aria-label") || "") ||
        fieldDescriptorTools.sanitizeContextChunk(labelText) ||
        "";

      if (!autoId || idSeen.has(autoId)) continue;
      idSeen.add(autoId);

      const fp = fieldDescriptorTools.simpleHash(`${frameHost}|ariacombo|${autoId}`);
      if (seen.has(fp)) continue;
      seen.add(fp);

      // Build context: human-readable label text + identifier hint
      const idHint = autoId.replace(/--|_/g, " ").replace(/([A-Z])/g, " $1").toLowerCase();
      const ctx = normalize(`${idHint} ${labelText}`.trim());
      const semantic = fieldDescriptorTools.getPlaywrightSemanticParts(el);
      if (!fieldDescriptorTools.hasEnoughSemanticSignal(semantic, 6) && ctx.length < 4) continue;
      candidates.push({
        fingerprint: fp,
        context: ctx.slice(0, 900),
        role: semantic.role || "combobox",
        name: semantic.name || ctx.slice(0, 140),
        section: semantic.section || "",
        type: semantic.inputType || "combobox",
        helpText: fieldDescriptorTools.collectControlHelpText(el),
        kind: "ariacombobox",
        autoId,
        ...getVisualOrderMeta(el),
        frameHost
      });
    }

    return { candidates, frameHost };
  }

  function applyFieldGuessesFromPage(guesses) {
    let applied = 0;
    const host = typeof location !== "undefined" ? location.hostname : "";
    for (const g of Array.isArray(guesses) ? guesses : []) {
      const fp = g.fingerprint;
      const val = String(g.value || "").trim();
      if (!fp || !val) continue;
      if (g.frameHost && g.frameHost !== host) continue;
      for (const control of choiceControlTools.collectFormControlsAndRoleCheckables(document)) {
        if (fieldDescriptorTools.computeFieldFingerprint(control) !== fp) continue;
        if (control instanceof HTMLSelectElement) {
          if (!controlFillTools.selectLooksUnfilled(control)) break;
          // Try exact label match first (LLM is instructed to copy labels verbatim)
          let ok = false;
          const valNorm = normalize(val);
          for (let i = 0; i < control.options.length; i += 1) {
            const opt = control.options[i];
            if (opt.disabled) continue;
            const label = (opt.textContent || "").trim();
            if (normalize(label) === valNorm || normalize(opt.value || "") === valNorm) {
              ok = controlFillTools.applySelectIndex(control, i, "evaluate:llm");
              break;
            }
          }
          if (!ok) ok = controlFillTools.fillSelect(control, val, "evaluate:llm");
          if (!ok) {
            const r = controlFillTools.pickBestOptionScoreResult(control, val, 40);
            if (r.index >= 0) ok = controlFillTools.applySelectIndex(control, r.index, "evaluate:llm");
          }
          if (ok) applied += 1;
          break;
        }
        if (control instanceof HTMLInputElement) {
          const inputType = (control.type || "text").toLowerCase();
          if (inputType === "radio") {
            const target = choiceControlTools.findMatchingRadioInGroup(control, [val]);
            if (target) { choiceControlTools.setChecked(target); applied += 1; }
            break;
          }
          if (inputType === "checkbox") {
            if (choiceControlTools.selectCheckboxChoice(control, demographicFieldTools.choiceCandidatesForProfileValue(val, g.canonicalKey))) applied += 1;
            break;
          }
          if (textControlShouldRejectChoiceAnswer(control, val, g)) break;
          if ((control.value || "").trim()) break;
          if (controlFillTools.fillInput(control, val, "evaluate:llm")) applied += 1;
          break;
        }
        if (control instanceof HTMLTextAreaElement) {
          if (textControlShouldRejectChoiceAnswer(control, val, g)) break;
          if ((control.value || "").trim()) break;
          if (controlFillTools.fillInput(control, val, "evaluate:llm")) applied += 1;
        }
        if (control instanceof Element && choiceControlTools.checkableType(control) === "radio") {
          const target = choiceControlTools.findMatchingRadioInGroup(control, [val]);
          if (target) {
            choiceControlTools.setChecked(target);
            applied += 1;
          }
          break;
        }
        if (control instanceof Element && choiceControlTools.checkableType(control) === "checkbox") {
          if (choiceControlTools.selectCheckboxChoice(control, demographicFieldTools.choiceCandidatesForProfileValue(val, g.canonicalKey))) applied += 1;
        }
        break;
      }
    }
    return { applied };
  }

  /**
   * Async: Lever-style "location" fields use combobox + async `selectCustomDropdown`;
   * sync `fillInput` treats that Promise as failure, so we await the dropdown path first.
   */
  async function applyFieldGuessVerbose(guess) {
    const fp = String(guess?.fingerprint || "");
    const val = String(guess?.value || "").trim();
    const host = typeof location !== "undefined" ? location.hostname : "";
    const steps = [];
    if (!fp || !val) return { applied: 0, steps: ["skip:missing fingerprint/value"] };
    if (guess?.frameHost && guess.frameHost !== host) {
      return { applied: 0, steps: [`skip:frame mismatch ${guess.frameHost} != ${host}`] };
    }
    for (const control of choiceControlTools.collectFormControlsAndRoleCheckables(document)) {
      if (fieldDescriptorTools.computeFieldFingerprint(control) !== fp) continue;
      if (control instanceof HTMLSelectElement) {
        steps.push("dropdown:open");
        let ok = false;
        const valNorm = normalize(val);
        for (let i = 0; i < control.options.length; i += 1) {
          const opt = control.options[i];
          if (opt.disabled) continue;
          const label = (opt.textContent || "").trim();
          if (normalize(label) === valNorm || normalize(opt.value || "") === valNorm) {
            ok = controlFillTools.applySelectIndex(control, i, "evaluate:llm");
            steps.push(`dropdown:match exact -> ${label || opt.value || i}`);
            break;
          }
        }
        if (!ok) {
          ok = controlFillTools.fillSelect(control, val, "evaluate:llm");
          if (ok) steps.push("dropdown:match fuzzy");
        }
        if (!ok) {
          const r = controlFillTools.pickBestOptionScoreResult(control, val, 40);
          if (r.index >= 0) {
            ok = controlFillTools.applySelectIndex(control, r.index, "evaluate:llm");
            if (ok) steps.push(`dropdown:match low-threshold score=${r.score}`);
          }
        }
        const committed = ok && isSelectCommitted(control, val);
        steps.push(committed ? "dropdown:confirm ok" : "dropdown:confirm failed");
        return { applied: committed ? 1 : 0, steps };
      }
      if (control instanceof HTMLInputElement) {
        const inputType = (control.type || "text").toLowerCase();
        if (inputType === "radio") {
          const target = choiceControlTools.findMatchingRadioInGroup(control, [val]);
          if (target) {
            choiceControlTools.setChecked(target);
            return { applied: 1, steps: ["radio:matched", "radio:confirm ok"] };
          }
          return { applied: 0, steps: ["radio:no option matched"] };
        }
        if (inputType === "checkbox") {
          if (choiceControlTools.selectCheckboxChoice(control, demographicFieldTools.choiceCandidatesForProfileValue(val, guess.canonicalKey))) {
            return { applied: 1, steps: ["checkbox:matched", "checkbox:confirm ok"] };
          }
          return { applied: 0, steps: ["checkbox:no option matched"] };
        }
        if (textControlShouldRejectChoiceAnswer(control, val, guess)) {
          return { applied: 0, steps: ["input:skip demographic choice for text field"] };
        }
        if ((control.value || "").trim()) return { applied: 0, steps: ["input:skip nonempty"] };

        const fieldContext = fieldDescriptorTools.extendedGuessContext(control);
        const wantsCombo =
          String(control.getAttribute("role") || "").toLowerCase() === "combobox" ||
          control.getAttribute("aria-haspopup") === "listbox" ||
          isLikelyDropdownSearchInput(control, fieldContext);
        const locationLikeInput = /\b(current\s+)?location\b|\bcity\b|\bstate\b|\bcountry\b/i.test(
          [
            control.getAttribute("aria-label"),
            control.getAttribute("name"),
            control.getAttribute("id"),
            control.getAttribute("placeholder"),
            fieldContext
          ]
            .filter(Boolean)
            .join(" ")
        );
        let shouldTryCombo = wantsCombo || locationLikeInput;
        const shared = globalThis.__formFillerBrowserActions;
        let comboErr = "";
        let comboProbe = "";
        if (!shouldTryCombo && shared && typeof shared.detectDropdownLikeInput === "function") {
          try {
            const probe = await shared.detectDropdownLikeInput(control, {
              timeoutMs: 260,
              context: fieldContext
            });
            if (probe?.ok) {
              shouldTryCombo = true;
              comboProbe = String(probe.reason || "behavioral_probe").slice(0, 80);
            }
          } catch (e) {
            comboErr = `probe:${String(e instanceof Error ? e.message : e).slice(0, 120)}`;
          }
        }
        if (shouldTryCombo && shared && typeof shared.selectCustomDropdown === "function") {
          try {
            const dd = await shared.selectCustomDropdown({
              element: control,
              value: val,
              autoId: String(guess?.autoId || "").trim() || getComboboxAutoId(control),
              label: String(guess?.label || "").trim(),
              maxWaitMs: 12000,
              openWaitSliceMs: 700,
              searchOptionChangeTimeoutMs: 6500,
              postSearchPollMs: 6500,
              pollIntervalMs: 180,
              minSettledMs: 500
            });
            const subSteps = Array.isArray(dd?.log?.steps)
              ? dd.log.steps.map((s) => `combo:${String(s).slice(0, 120)}`)
              : [];
            if (dd?.ok) {
              return {
                applied: 1,
                steps: [
                  "combobox:filled",
                  comboProbe ? `combo:detected_by:${comboProbe}` : "",
                  ...subSteps.slice(0, 22)
                ].filter(Boolean)
              };
            }
          } catch (e) {
            comboErr = String(e instanceof Error ? e.message : e).slice(0, 160);
          }
        }

        if (controlFillTools.fillInput(control, val, "evaluate:llm")) {
          return { applied: 1, steps: ["input:filled", `committed:${String(control.value || "").slice(0, 80)}`] };
        }
        return {
          applied: 0,
          steps: [
            "input:fill_failed_or_uncommitted",
            `wanted:${String(val || "").slice(0, 80)}`,
            `have:${String(control.value || "").slice(0, 80)}`,
            comboProbe ? `combo:detected_by:${comboProbe}` : "",
            shouldTryCombo ? "note:combobox_async_tried_then_plain_fill_failed" : "",
            comboErr ? `combobox:exception:${comboErr}` : ""
          ].filter(Boolean)
        };
      }
      if (control instanceof HTMLTextAreaElement) {
        if (textControlShouldRejectChoiceAnswer(control, val, guess)) {
          return { applied: 0, steps: ["textarea:skip demographic choice for text field"] };
        }
        if ((control.value || "").trim()) return { applied: 0, steps: ["textarea:skip nonempty"] };
        if (controlFillTools.fillInput(control, val, "evaluate:llm")) {
          return { applied: 1, steps: ["textarea:filled", `committed:${String(control.value || "").slice(0, 80)}`] };
        }
        return {
          applied: 0,
          steps: ["textarea:fill_failed_or_uncommitted", `wanted:${String(val || "").slice(0, 80)}`, `have:${String(control.value || "").slice(0, 80)}`]
        };
      }
      if (control instanceof Element && choiceControlTools.checkableType(control) === "radio") {
        const target = choiceControlTools.findMatchingRadioInGroup(control, [val]);
        if (target) {
          choiceControlTools.setChecked(target);
          return { applied: 1, steps: ["radio:matched", "radio:confirm ok"] };
        }
        return { applied: 0, steps: ["radio:no option matched"] };
      }
      if (control instanceof Element && choiceControlTools.checkableType(control) === "checkbox") {
        if (choiceControlTools.selectCheckboxChoice(control, demographicFieldTools.choiceCandidatesForProfileValue(val, guess.canonicalKey))) {
          return { applied: 1, steps: ["checkbox:matched", "checkbox:confirm ok"] };
        }
        return { applied: 0, steps: ["checkbox:no option matched"] };
      }
      return { applied: 0, steps: ["unsupported control"] };
    }
    return { applied: 0, steps: ["control not found"] };
  }

  function collectFilledForReview() {
    const frameHost = typeof location !== "undefined" ? location.hostname : "";
    const candidates = [];
    const seen = new Set();

    for (const control of controlFillTools.sortElementsByVisualOrder(controlFillTools.collectFormControls(document))) {
      if (!controlFillTools.isVisibleForScrape(control)) continue;
      if (control.disabled || control.readOnly) continue;

      if (control instanceof HTMLSelectElement) {
        if (controlFillTools.selectLooksUnfilled(control)) continue;
        const opt = control.selectedOptions[0];
        const currentValue = (opt?.textContent || "").trim() || (control.value || "").trim();
        if (!currentValue) continue;
        const semantic = fieldDescriptorTools.getPlaywrightSemanticParts(control);
        const ctx = fieldDescriptorTools.extendedGuessContext(control);
        if (!fieldDescriptorTools.hasEnoughSemanticSignal(semantic, 8)) continue;
        const fp = fieldDescriptorTools.computeFieldFingerprint(control);
        if (seen.has(fp)) continue;
        seen.add(fp);
        const opts = Array.from(control.options || [])
          .slice(0, 45)
          .map((o) => `${(o.value || "").trim()}: ${(o.textContent || "").trim()}`.slice(0, 72))
          .join(" | ");
        const optionLabels = Array.from(control.options || [])
          .slice(0, 45)
          .map((o) => String(o.textContent || "").trim())
          .filter(Boolean);
        candidates.push({
          fingerprint: fp,
          context: ctx.slice(0, 900),
          role: semantic.role,
          name: semantic.name,
          section: semantic.section,
          type: semantic.inputType || "select",
          kind: "select",
          currentValue: currentValue.slice(0, 200),
          options: optionLabels,
          optionsSummary: opts.slice(0, 1500),
          ...getVisualOrderMeta(control),
          frameHost
        });
        continue;
      }

      if (control instanceof HTMLTextAreaElement) {
        const currentValue = (control.value || "").trim();
        if (!currentValue) continue;
        const semantic = fieldDescriptorTools.getPlaywrightSemanticParts(control);
        const ctx = fieldDescriptorTools.extendedGuessContext(control);
        if (!fieldDescriptorTools.hasEnoughSemanticSignal(semantic, 10)) continue;
        const fp = fieldDescriptorTools.computeFieldFingerprint(control);
        if (seen.has(fp)) continue;
        seen.add(fp);
        candidates.push({
          fingerprint: fp,
          context: ctx.slice(0, 900),
          role: semantic.role,
          name: semantic.name,
          section: semantic.section,
          type: semantic.inputType || "textarea",
          kind: "textarea",
          currentValue: currentValue.slice(0, 300),
          ...getVisualOrderMeta(control),
          frameHost
        });
        continue;
      }

      if (!(control instanceof HTMLInputElement)) continue;
      const inputType = (control.type || "text").toLowerCase();
      if (inputType === "radio") continue; // handled separately below
      if (!isGuessableTextControl(control)) continue;
      const currentValue = (control.value || "").trim();
      if (!currentValue) continue;
      const semantic = fieldDescriptorTools.getPlaywrightSemanticParts(control);
      const ctx = fieldDescriptorTools.extendedGuessContext(control);
      if (!fieldDescriptorTools.hasEnoughSemanticSignal(semantic, 10)) continue;
      const fp = fieldDescriptorTools.computeFieldFingerprint(control);
      if (seen.has(fp)) continue;
      seen.add(fp);
      candidates.push({
        fingerprint: fp,
        context: ctx.slice(0, 900),
        role: semantic.role,
        name: semantic.name,
        section: semantic.section,
        type: semantic.inputType || inputType,
        kind: inputType,
        currentValue: currentValue.slice(0, 200),
        ...getVisualOrderMeta(control),
        frameHost
      });
    }

    // Collect checked radio groups
    const seenGroups = new Set();
    for (const control of controlFillTools.sortElementsByVisualOrder(controlFillTools.collectFormControls(document))) {
      if (!controlFillTools.isVisibleForScrape(control)) continue;
      if (!(control instanceof HTMLInputElement)) continue;
      if ((control.type || "").toLowerCase() !== "radio") continue;
      if (control.disabled) continue;
      const groupName = (control.name || "").trim();
      if (!groupName || seenGroups.has(groupName)) continue;
      seenGroups.add(groupName);

      const root = control.form || control.closest("form") || document;
      const groupRadios = controlFillTools.sortElementsByVisualOrder(controlFillTools.collectFormControls(root)).filter(
        (x) =>
          x instanceof HTMLInputElement &&
          controlFillTools.isVisibleForScrape(x) &&
          (x.type || "").toLowerCase() === "radio" &&
          (x.name || "").trim() === groupName
      );
      const checkedRadio = groupRadios.find((r) => r.checked);
      if (!checkedRadio) continue;

      const fp = fieldDescriptorTools.computeFieldFingerprint(control);
      if (seen.has(fp)) continue;
      seen.add(fp);

      const semantic = fieldDescriptorTools.getPlaywrightSemanticParts(control);
      const ctx = fieldDescriptorTools.extendedGuessContext(control);
      if (!fieldDescriptorTools.hasEnoughSemanticSignal(semantic, 6)) continue;

      const currentValue =
        (checkedRadio.value || "").trim() || choiceControlTools.checkboxOrRadioLabel(checkedRadio);
      const optsSummary = groupRadios
        .slice(0, 20)
        .map((r) => `${(r.value || "").trim()}: ${choiceControlTools.checkboxOrRadioLabel(r)}`.slice(0, 80))
        .join(" | ");
      const optionLabels = groupRadios
        .slice(0, 20)
        .map((r) => choiceControlTools.checkboxOrRadioLabel(r))
        .filter(Boolean);

      candidates.push({
        fingerprint: fp,
        context: ctx.slice(0, 900),
        role: semantic.role,
        name: semantic.name,
        section: semantic.section,
        type: semantic.inputType || "radio",
        kind: "radio",
        currentValue: currentValue.slice(0, 200),
        options: optionLabels,
        optionsSummary: optsSummary.slice(0, 1500),
        ...getVisualOrderMeta(control),
        frameHost
      });
    }

    return { candidates, frameHost };
  }

  function applyFieldCorrectionsFromPage(corrections) {
    let applied = 0;
    const host = typeof location !== "undefined" ? location.hostname : "";
    for (const g of Array.isArray(corrections) ? corrections : []) {
      const fp = g.fingerprint;
      const val = String(g.value || "").trim();
      if (!fp || !val) continue;
      if (g.frameHost && g.frameHost !== host) continue;
      for (const control of choiceControlTools.collectFormControlsAndRoleCheckables(document)) {
        if (fieldDescriptorTools.computeFieldFingerprint(control) !== fp) continue;
        if (control instanceof HTMLSelectElement) {
          let ok = false;
          const valNorm = normalize(val);
          for (let i = 0; i < control.options.length; i += 1) {
            const opt = control.options[i];
            if (opt.disabled) continue;
            const label = (opt.textContent || "").trim();
            if (normalize(label) === valNorm || normalize(opt.value || "") === valNorm) {
              if (control.selectedIndex === i) break; // already correct
              ok = controlFillTools.applySelectIndex(control, i, "evaluate:llm:correction");
              break;
            }
          }
          if (!ok) ok = controlFillTools.fillSelect(control, val, "evaluate:llm:correction");
          if (!ok) {
            const r = controlFillTools.pickBestOptionScoreResult(control, val, 40);
            if (r.index >= 0) ok = controlFillTools.applySelectIndex(control, r.index, "evaluate:llm:correction");
          }
          if (ok) applied += 1;
          break;
        }
        if (control instanceof HTMLInputElement) {
          const inputType = (control.type || "text").toLowerCase();
          if (inputType === "radio") {
            const target = choiceControlTools.findMatchingRadioInGroup(control, [val]);
            if (target && !choiceControlTools.checkableChecked(target)) {
              choiceControlTools.setChecked(target);
              applied += 1;
            }
            break;
          }
          if (inputType === "checkbox") {
            if (choiceControlTools.selectCheckboxChoice(control, demographicFieldTools.choiceCandidatesForProfileValue(val, g.canonicalKey))) applied += 1;
            break;
          }
          if (textControlShouldRejectChoiceAnswer(control, val, g)) break;
          if (normalize(control.value || "") === normalize(val)) break;
          controlFillTools.fillInput(control, val, "evaluate:llm:correction");
          applied += 1;
          break;
        }
        if (control instanceof HTMLTextAreaElement) {
          if (textControlShouldRejectChoiceAnswer(control, val, g)) break;
          if (normalize(control.value || "") === normalize(val)) break;
          controlFillTools.fillInput(control, val, "evaluate:llm:correction");
          applied += 1;
        }
        if (control instanceof Element && choiceControlTools.checkableType(control) === "radio") {
          const target = choiceControlTools.findMatchingRadioInGroup(control, [val]);
          if (target && !choiceControlTools.checkableChecked(target)) {
            choiceControlTools.setChecked(target);
            applied += 1;
          }
          break;
        }
        if (control instanceof Element && choiceControlTools.checkableType(control) === "checkbox") {
          if (choiceControlTools.selectCheckboxChoice(control, demographicFieldTools.choiceCandidatesForProfileValue(val, g.canonicalKey))) applied += 1;
        }
        break;
      }
    }
    return { applied };
  }

  /**
   * Async: interact with custom ARIA combobox dropdowns (click-to-open pattern).
   * Each guess must have {autoId, value}. Returns { applied }.
   */
  async function applyAriaComboboxGuesses(guesses) {
    const shared = globalThis.__formFillerBrowserActions;
    if (shared && typeof shared.selectCustomDropdownBatch === "function") {
      return shared.selectCustomDropdownBatch(guesses);
    }
    return {
      applied: 0,
      logs: [{ steps: ["browser actions unavailable"] }]
    };
  }

  /**
   * Map a snapshot/question label (e.g. "Work Authorization") to a profile key/value using content resolvers.
   * Used by the floating bar to choose a value for radio groups from the question text alone.
   */
  function resolveMappedValueFromLabelText(labelText, profile) {
    const { baseProfile } = splitProfileAndStoredHints(profile);
    const candidate = normalize(String(labelText || ""));
    if (!candidate) return null;
    const profileKey = pickProfileKey(candidate);
    const value = profileKey ? resolveProfileValue(profileKey, candidate, baseProfile) : null;
    if (!profileKey || !value) return null;
    return { profileKey, value: String(value), candidate };
  }

  /**
   * Fill one visible control using the same mapping rules as runDeterministicFill (plus relaxed guesses).
   */
  function tryFillSingleControlFromProfile(control, profile) {
    const { baseProfile } = splitProfileAndStoredHints(profile);
    if (control instanceof HTMLSelectElement) {
      if (control.disabled || !controlFillTools.selectLooksUnfilled(control)) return { ok: false, reason: "select_skip" };
      const mapped =
        resolveMappedValueStrict(control, baseProfile) || resolveMappedValueRelaxed(control, baseProfile);
      if (!mapped) return { ok: false, reason: "no_map" };
      if (!controlFillTools.fillSelect(control, mapped.value, "floating:sequential")) return { ok: false, reason: "fill_failed" };
      return { ok: true, profileKey: mapped.profileKey };
    }
    if (control instanceof HTMLTextAreaElement) {
      if (control.disabled || control.readOnly) return { ok: false, reason: "disabled" };
      if (control.value?.trim()) return { ok: false, reason: "has_value" };
      const mapped =
        resolveMappedValueStrict(control, baseProfile) || resolveMappedValueRelaxed(control, baseProfile);
      if (!mapped) return { ok: false, reason: "no_map" };
      if (!controlFillTools.fillInput(control, mapped.value, "floating:sequential")) return { ok: false, reason: "fill_failed" };
      return { ok: true, profileKey: mapped.profileKey };
    }
    if (control instanceof HTMLInputElement) {
      const t = (control.type || "text").toLowerCase();
      if (t === "password") {
        if (!fillRegisterPasswordIfApplicable(control, baseProfile, "fill:single")) {
          return { ok: false, reason: detectRegisterIntentForPage() ? "fill_failed" : "password" };
        }
        return { ok: true, profileKey: "registerPassword" };
      }
      if (control.disabled || control.readOnly) return { ok: false, reason: "disabled" };
      if (t === "hidden" || t === "submit" || t === "button" || t === "image") return { ok: false, reason: "type_skip" };
      if (t === "file") return { ok: false, reason: "file" };
      // Radio/checkbox must run group flow: `.value` is the option's value attribute, often non-empty even when unchecked.
      if (t === "radio" || t === "checkbox") return { ok: false, reason: "use_group_flow" };
      if (control.value?.trim()) return { ok: false, reason: "has_value" };
      const mapped =
        resolveMappedValueStrict(control, baseProfile) || resolveMappedValueRelaxed(control, baseProfile);
      if (!mapped) return { ok: false, reason: "no_map" };
      if (!controlFillTools.fillInput(control, mapped.value, "floating:sequential")) return { ok: false, reason: "fill_failed" };
      return { ok: true, profileKey: mapped.profileKey };
    }
    return { ok: false, reason: "unsupported" };
  }

  /**
   * Register-mode single-control fill: same mapping as runRegisterFill, but one control at a time.
   * Keeps password fields in-order with the visible walkthrough.
   */
  function tryFillSingleControlForRegister(control, profile) {
    const { baseProfile } = splitProfileAndStoredHints(profile);
    if (control instanceof HTMLSelectElement) {
      if (control.disabled || !controlFillTools.selectLooksUnfilled(control)) return { ok: false, reason: "select_skip" };
      const mapped = resolveMappedValueStrict(control, baseProfile);
      if (!mapped) return { ok: false, reason: "no_map" };
      if (!controlFillTools.fillSelect(control, mapped.value, "register:sequential")) return { ok: false, reason: "fill_failed" };
      return { ok: true, profileKey: mapped.profileKey };
    }
    if (control instanceof HTMLTextAreaElement) {
      if (control.disabled || control.readOnly) return { ok: false, reason: "disabled" };
      if (control.value?.trim()) return { ok: false, reason: "has_value" };
      const mapped = resolveMappedValueStrict(control, baseProfile);
      if (!mapped) return { ok: false, reason: "no_map" };
      if (!controlFillTools.fillInput(control, mapped.value, "register:sequential")) return { ok: false, reason: "fill_failed" };
      return { ok: true, profileKey: mapped.profileKey };
    }
    if (control instanceof HTMLInputElement) {
      const t = (control.type || "text").toLowerCase();
      if (control.disabled || control.readOnly) return { ok: false, reason: "disabled" };
      if (t === "hidden" || t === "submit" || t === "button" || t === "image") return { ok: false, reason: "type_skip" };
      if (t === "file") return { ok: false, reason: "file" };
      if (t === "radio" || t === "checkbox") return { ok: false, reason: "use_group_flow" };
      if (control.value?.trim()) return { ok: false, reason: "has_value" };
      if (t === "password") {
        if (!fillRegisterPasswordIfApplicable(control, baseProfile, "register:sequential")) {
          return { ok: false, reason: "fill_failed" };
        }
        return { ok: true, profileKey: "registerPassword" };
      }
      const mapped = resolveMappedValueStrict(control, baseProfile);
      if (!mapped) return { ok: false, reason: "no_map" };
      if (!controlFillTools.fillInput(control, mapped.value, "register:sequential")) return { ok: false, reason: "fill_failed" };
      return { ok: true, profileKey: mapped.profileKey };
    }
    return { ok: false, reason: "unsupported" };
  }

  /**
   * Pick a radio in a group whose option label matches desiredText (profile value).
   */
  function trySelectRadioGroupWithDesired(groupEl, desiredText) {
    const desired = String(desiredText || "").trim();
    if (!(groupEl instanceof Element) || !desired) return { ok: false, reason: "bad_args" };
    const first = groupEl.querySelector('input[type="radio"]');
    if (!first) return { ok: false, reason: "no_radios" };
    const shared = globalThis.__formFillerBrowserActions;
    if (shared && typeof shared.selectRadioOption === "function") {
      const selected = shared.selectRadioOption(first, desired);
      if (selected?.ok) {
        controlFillTools.tagFilledControlAfterWrite(first, desired, "floating:sequential:radio");
        return { ok: true };
      }
    }
    const hit = choiceControlTools.findMatchingRadioInGroup(first, [desired]);
    if (!hit) return { ok: false, reason: "no_match" };
    if (hit.checked) return { ok: true, skipped: true };
    hit.focus();
    hit.click();
    hit.dispatchEvent(new Event("input", { bubbles: true }));
    hit.dispatchEvent(new Event("change", { bubbles: true }));
    controlFillTools.tagFilledControlAfterWrite(hit, desired, "floating:sequential:radio");
    return { ok: true };
  }

  /**
   * Apply a known string to a control (used when snapshot label mapped to profile but control attrs did not).
   */
  function applyValueToControl(control, value, trackSource) {
    const v = String(value ?? "").trim();
    if (!v) return false;
    if (control instanceof HTMLSelectElement) {
      if (control.disabled || !controlFillTools.selectLooksUnfilled(control)) return false;
      return controlFillTools.fillSelect(control, v, trackSource);
    }
    if (control instanceof HTMLTextAreaElement) {
      if (control.disabled || control.readOnly || control.value?.trim()) return false;
      return controlFillTools.fillInput(control, v, trackSource);
    }
    if (control instanceof HTMLInputElement) {
      const t = (control.type || "text").toLowerCase();
      if (t === "password" || t === "hidden" || t === "submit" || t === "button" || t === "image" || t === "file") {
        return false;
      }
      if (control.disabled || control.readOnly || control.value?.trim()) return false;
      return controlFillTools.fillInput(control, v, trackSource);
    }
    return false;
  }

  global.__resolveMappedValueFromLabelText = resolveMappedValueFromLabelText;
  global.__detectRegisterIntentForPage = detectRegisterIntentForPage;
  global.__tryFillSingleControlFromProfile = tryFillSingleControlFromProfile;
  global.__tryFillSingleControlForRegister = tryFillSingleControlForRegister;
  global.__trySelectRadioGroupWithDesired = trySelectRadioGroupWithDesired;
  global.__applyValueToControl = applyValueToControl;

  global.__runDeterministicFill = runDeterministicFill;
  global.__runRegisterFill = runRegisterFill;
  global.__runEvaluateAndFillBestGuess = runEvaluateAndFillBestGuess;
  global.__collectUnfilledCandidates = collectUnfilledCandidates;
  global.__collectAriaComboboxGaps = collectAriaComboboxGaps;
  global.__collectFilledForReview = collectFilledForReview;
  global.__applyFieldGuesses = applyFieldGuessesFromPage;
  global.__applyFieldGuessVerbose = applyFieldGuessVerbose;
  global.__applyFieldCorrections = applyFieldCorrectionsFromPage;
  global.__applyAriaComboboxGuesses = applyAriaComboboxGuesses;
  global.__collectFormSubmitHintEntries = collectFormSubmitHintEntries;
  /** For floating pw-scan: same section/label/role/type + fingerprint as gap collection. */
  global.__getPlaywrightFieldSemantics = function getPlaywrightFieldSemantics(control) {
    if (!(control instanceof Element)) return null;
    try {
      const semantic = fieldDescriptorTools.getPlaywrightSemanticParts(control);
      const fingerprint = fieldDescriptorTools.computeFieldFingerprint(control);
      return { ...semantic, fingerprint };
    } catch {
      return null;
    }
  };

  global.__focusFieldByFingerprint = function focusFieldByFingerprint(fingerprint, autoId, expectedHost) {
    const host = typeof location !== "undefined" ? location.hostname : "";
    if (expectedHost && host && host !== expectedHost) {
      clearFocusedFieldHighlight();
      return { ok: false, skippedHost: host };
    }
    const fp = String(fingerprint || "");
    if (autoId) {
      try {
        const esc = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(String(autoId)) : String(autoId);
        const wrapper = document.querySelector(
          `[data-automation-id="${esc}"], [data-qa="${esc}"], [data-testid="${esc}"], [data-field-name="${esc}"], #${esc}, [name="${esc}"]`
        );
        const target = wrapper?.querySelector?.('[role="combobox"], input, button, select, textarea') || wrapper;
        if (target instanceof HTMLElement) {
          target.scrollIntoView({ behavior: "smooth", block: "center" });
          target.focus?.();
          highlightFocusedField(target);
          return { ok: true, mode: "autoId" };
        }
      } catch {
        // ignore
      }
    }
    for (const control of choiceControlTools.collectFormControlsAndRoleCheckables(document)) {
      if (fieldDescriptorTools.computeFieldFingerprint(control) !== fp) continue;
      if (control instanceof HTMLElement) {
        control.scrollIntoView({ behavior: "smooth", block: "center" });
        control.focus?.();
        highlightFocusedField(control);
        return { ok: true, mode: "fingerprint" };
      }
    }
    return { ok: false };
  };

  function clearFocusedFieldHighlight() {
    const restoreOutline = (value) => /#f59e0b|rgb\(\s*245\s*,\s*158\s*,\s*11\s*\)|orange/i.test(String(value || "")) ? "" : String(value || "");
    const previous = global.__formFillerFocusedHighlight;
    if (previous?.timer) clearTimeout(previous.timer);
    const el = previous?.el;
    if (el instanceof HTMLElement && el.isConnected) {
      el.style.outline = restoreOutline(previous.outline);
      el.style.outlineOffset = previous.outlineOffset || "";
      el.removeAttribute("data-form-filler-focused-highlight");
    }
    for (const highlighted of document.querySelectorAll("[data-form-filler-focused-highlight='true']")) {
      if (!(highlighted instanceof HTMLElement)) continue;
      highlighted.style.outline = restoreOutline(highlighted.getAttribute("data-form-filler-prev-outline"));
      highlighted.style.outlineOffset = highlighted.getAttribute("data-form-filler-prev-outline-offset") || "";
      highlighted.removeAttribute("data-form-filler-focused-highlight");
      highlighted.removeAttribute("data-form-filler-prev-outline");
      highlighted.removeAttribute("data-form-filler-prev-outline-offset");
    }
    global.__formFillerFocusedHighlight = null;
  }

  function highlightFocusedField(el) {
    if (!(el instanceof HTMLElement)) return;
    clearFocusedFieldHighlight();
    const previousOutline = el.style.outline || "";
    const previousOffset = el.style.outlineOffset || "";
    el.setAttribute("data-form-filler-focused-highlight", "true");
    el.setAttribute("data-form-filler-prev-outline", previousOutline);
    el.setAttribute("data-form-filler-prev-outline-offset", previousOffset);
    el.style.outline = "3px solid #f59e0b";
    el.style.outlineOffset = "2px";
    const timer = setTimeout(() => {
      if (!el.isConnected) return;
      el.style.outline = previousOutline;
      el.style.outlineOffset = previousOffset;
      el.removeAttribute("data-form-filler-focused-highlight");
      el.removeAttribute("data-form-filler-prev-outline");
      el.removeAttribute("data-form-filler-prev-outline-offset");
      if (global.__formFillerFocusedHighlight?.el === el) {
        global.__formFillerFocusedHighlight = null;
      }
    }, 2400);
    global.__formFillerFocusedHighlight = {
      el,
      outline: previousOutline,
      outlineOffset: previousOffset,
      timer
    };
  }
})(typeof globalThis !== "undefined" ? globalThis : window);
