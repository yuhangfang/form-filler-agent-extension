/**
 * Field descriptor and context extraction helpers.
 *
 * This module owns DOM labelling, semantic field descriptions, stable
 * fingerprints, and row-aware context strings. It does not decide what values
 * to write; page-fill-engine makes those decisions.
 */
(function attachFieldDescriptorTools(global) {
  const profileFieldCatalog = global.__formFillerProfileFieldCatalog || {};

  function normalize(input) {
    return String(input || "").toLowerCase().replace(/\s+/g, " ").trim();
  }

function ariaLabelledByText(input) {
  const raw = input.getAttribute("aria-labelledby");
  if (!raw) return "";
  return raw
    .split(/\s+/)
    .map((id) => {
      try {
        const el = input.ownerDocument.getElementById(id);
        return el ? el.textContent : "";
      } catch {
        return "";
      }
    })
    .filter(Boolean)
    .join(" ");
}

function humanizeAttr(raw) {
  if (!raw) return "";
  // Convert snake_case, kebab-case, camelCase → space-separated words
  return raw
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
}

function candidateTextForField(input) {
  const autoId = input.getAttribute("data-automation-id") ||
    input.closest("[data-automation-id]")?.getAttribute("data-automation-id") || "";
  const attrs = [
    humanizeAttr(input.name),
    humanizeAttr(input.id),
    input.placeholder,
    input.getAttribute("aria-label"),
    ariaLabelledByText(input),
    humanizeAttr(input.getAttribute("data-testid")),
    humanizeAttr(input.getAttribute("data-qa")),
    input.getAttribute("title"),
    input.labels?.[0]?.innerText,
    autoId ? autoId.replace(/--/g, " ").replace(/([A-Z])/g, " $1") : ""
  ].filter(Boolean);
  const type = input.type;
  if (type === "email") attrs.push("email");
  if (type === "tel") attrs.push("phone", "tel");
  if (type === "url") attrs.push("website", "url");
  return normalize(attrs.join(" "));
}

function candidateTextForSelect(select) {
  const autoId = select.getAttribute("data-automation-id") ||
    select.closest("[data-automation-id]")?.getAttribute("data-automation-id") || "";
  const attrs = [
    humanizeAttr(select.name),
    humanizeAttr(select.id),
    select.getAttribute("aria-label"),
    ariaLabelledByText(select),
    humanizeAttr(select.getAttribute("data-testid")),
    humanizeAttr(select.getAttribute("data-qa")),
    select.getAttribute("title"),
    select.labels?.[0]?.innerText,
    autoId ? autoId.replace(/--/g, " ").replace(/([A-Z])/g, " $1") : ""
  ].filter(Boolean);
  return normalize(attrs.join(" "));
}

function candidateTextForControl(control) {
  if (control instanceof HTMLSelectElement) return candidateTextForSelect(control);
  return candidateTextForField(control);
}

function simpleHash(str) {
  let h = 2166136261 >>> 0;
  const s = String(str);
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return ("00000000" + h.toString(16)).slice(-8);
}

function getSemanticSectionPath(control) {
  if (!(control instanceof Element)) return "";
  const parts = [];
  const seen = new Set();
  const pushPart = (raw) => {
    const text = normalize(String(raw || "")).slice(0, 80);
    if (!text) return;
    const key = text.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    parts.push(text);
  };

  const fieldset = control.closest("fieldset");
  if (fieldset) {
    pushPart(fieldset.querySelector("legend")?.textContent || fieldset.getAttribute("aria-label") || "");
  }

  let node = control.parentElement;
  for (let depth = 0; depth < 6 && node; depth += 1, node = node.parentElement) {
    const ariaLabelledby = node.getAttribute("aria-labelledby");
    if (ariaLabelledby) {
      const ids = ariaLabelledby.split(/\s+/).filter(Boolean);
      for (const id of ids.slice(0, 2)) pushPart(document.getElementById(id)?.textContent || "");
    }
    pushPart(node.getAttribute("aria-label") || "");
    const heading = node.querySelector?.(":scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > legend, :scope > label");
    pushPart(heading?.textContent || "");
    const prev = node.previousElementSibling;
    if (prev && !prev.querySelector?.("input, select, textarea")) {
      pushPart(prev.matches?.("h1,h2,h3,h4,h5,h6,legend,label,p,span,div") ? prev.textContent : "");
    }
    if (node.matches("form, section, article, main")) break;
  }
  return parts.slice(0, 3).join(" > ");
}

function getStrictControlLabel(control) {
  if (!(control instanceof Element)) return "";
  const push = (arr, raw) => {
    const text = sanitizeContextChunk(raw).slice(0, 120);
    if (text) arr.push(text);
  };
  const labels = [];
  if (control instanceof HTMLInputElement || control instanceof HTMLSelectElement || control instanceof HTMLTextAreaElement) {
    if (control.labels?.length) {
      for (const lb of Array.from(control.labels).slice(0, 2)) push(labels, lb?.textContent || "");
    }
    if (control.id) {
      try {
        const esc = typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(control.id) : control.id;
        push(labels, control.ownerDocument.querySelector(`label[for="${esc}"]`)?.textContent || "");
      } catch {
        /* ignore */
      }
    }
  }
  const ariaLabelledBy = control.getAttribute("aria-labelledby");
  if (ariaLabelledBy) {
    for (const id of ariaLabelledBy.split(/\s+/).filter(Boolean).slice(0, 3)) {
      push(labels, control.ownerDocument.getElementById(id)?.textContent || "");
    }
  }
  push(labels, control.getAttribute("aria-label") || "");
  const group = control.closest("fieldset, [role='group'], [role='radiogroup']");
  if (group) {
    push(labels, group.querySelector("legend")?.textContent || "");
    const glb = group.getAttribute("aria-labelledby");
    if (glb) {
      for (const id of glb.split(/\s+/).filter(Boolean).slice(0, 2)) {
        push(labels, control.ownerDocument.getElementById(id)?.textContent || "");
      }
    }
  }
  if (!labels.length) {
    push(labels, control.getAttribute("placeholder") || "");
    push(labels, humanizeAttr(control.getAttribute("name") || ""));
    push(labels, humanizeAttr(control.getAttribute("id") || ""));
  }
  return sanitizeFieldContext(labels.join(" | ")).slice(0, 180);
}

function getRadioOrCheckboxGroupLabel(control) {
  if (!(control instanceof Element)) return "";
  let isRadio = false;
  let isCheckbox = false;
  if (control instanceof HTMLInputElement) {
    const type = (control.type || "").toLowerCase();
    isRadio = type === "radio";
    isCheckbox = type === "checkbox";
    if (!isRadio && !isCheckbox) return "";
  } else {
    const role = String(control.getAttribute("role") || "").toLowerCase();
    isRadio = role === "radio";
    isCheckbox = role === "checkbox";
    if (!isRadio && !isCheckbox) return "";
  }
  const group = control.closest("fieldset, [role='group'], [role='radiogroup']");
  if (group) {
    const legend = group.querySelector("legend");
    if (legend?.textContent?.trim()) return sanitizeFieldContext(legend.textContent).slice(0, 180);
    const glb = group.getAttribute("aria-labelledby");
    if (glb) {
      for (const id of glb.split(/\s+/).filter(Boolean).slice(0, 2)) {
        const n = control.ownerDocument.getElementById(id);
        if (n?.textContent?.trim()) return sanitizeFieldContext(n.textContent).slice(0, 180);
      }
    }
    const aria = group.getAttribute("aria-label");
    if (aria) return sanitizeFieldContext(aria).slice(0, 180);
  }
  let node = control.parentElement;
  for (let depth = 0; depth < 5 && node; depth += 1, node = node.parentElement) {
    let sibling = node.previousElementSibling;
    while (sibling) {
      if (!sibling.querySelector("input, select, textarea, [role='radio'], [role='checkbox']")) {
        const text = sanitizeFieldContext(sibling.textContent || "").slice(0, 180);
        if (text && text.length > 6) return text;
      }
      sibling = sibling.previousElementSibling;
    }
    if (node.matches("form, section, article, fieldset")) break;
  }
  return "";
}

function getPlaywrightSemanticParts(control) {
  const section = getSemanticSectionPath(control).slice(0, 140);
  const inputType = control instanceof HTMLInputElement ? ((control.type || "text").toLowerCase() || "text") : "";
  const groupLabel = getRadioOrCheckboxGroupLabel(control);
  const name = (groupLabel || getStrictControlLabel(control)).slice(0, 180);
  const attrRole = String(control.getAttribute?.("role") || "").toLowerCase();
  const role =
    control instanceof HTMLSelectElement
      ? "combobox"
      : control instanceof HTMLTextAreaElement
        ? "textbox"
        : control instanceof HTMLInputElement
          ? (
            inputType === "checkbox"
              ? "checkbox"
              : inputType === "radio"
                ? "radio"
                : inputType === "button" || inputType === "submit"
                  ? "button"
                  : "textbox"
          )
          : attrRole === "radio"
            ? "radio"
            : attrRole === "checkbox"
              ? "checkbox"
              : (control.getAttribute?.("role") || "control");
  return {
    role: String(role || "control"),
    name,
    section,
    inputType: inputType || ""
  };
}

function getPlaywrightStyleContext(control) {
  const semantic = getPlaywrightSemanticParts(control);
  // Keep context as plain field name; role/section/type are separate keys.
  return sanitizeFieldContext(semantic.name || "").slice(0, 220);
}

function hasEnoughSemanticSignal(semantic, minLen) {
  const nameLen = String(semantic?.name || "").trim().length;
  const sectionLen = String(semantic?.section || "").trim().length;
  return nameLen >= minLen || (nameLen + sectionLen) >= minLen;
}

function getVisualOrderMeta(el) {
  if (!(el instanceof Element)) return { visualTop: 0, visualLeft: 0 };
  const r = el.getBoundingClientRect?.() || { top: 0, left: 0 };
  const top = Number.isFinite(r.top) ? r.top + (window.scrollY || 0) : 0;
  const left = Number.isFinite(r.left) ? r.left + (window.scrollX || 0) : 0;
  return { visualTop: Math.round(top), visualLeft: Math.round(left) };
}

function computeFieldFingerprint(control) {
  const host = typeof location !== "undefined" ? location.hostname : "";
  let type =
    control instanceof HTMLInputElement
      ? control.type || "text"
      : control instanceof HTMLSelectElement
        ? "select"
        : control instanceof HTMLTextAreaElement
          ? "textarea"
          : "other";
  if (type === "other" && String(control.getAttribute?.("role") || "").toLowerCase() === "radio") {
    type = "radio";
  }
  const stableId = String(control.id || "").replace(/\d{2,}/g, "#");
  const sectionPath = getSemanticSectionPath(control);
  const strictLabel = getStrictControlLabel(control);
  const bits = [
    host,
    control.tagName,
    type,
    control.name || "",
    stableId,
    strictLabel,
    sectionPath,
    getPlaywrightStyleContext(control)
  ];
  return simpleHash(bits.join("|"));
}

function gatherExtendedHints(control) {
  const parts = [];
  if (!(control instanceof Element)) return "";
  const doc = control.ownerDocument;
  if (control.id) {
    try {
      const esc =
        typeof CSS !== "undefined" && typeof CSS.escape === "function"
          ? CSS.escape(control.id)
          : control.id.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      const lb = doc.querySelector(`label[for="${esc}"]`);
      if (lb?.textContent) parts.push(lb.textContent);
    } catch {
      /* ignore */
    }
  }
  const fs = control.closest("fieldset");
  const lg = fs?.querySelector("legend");
  if (lg?.textContent) parts.push(lg.textContent);
  const p = control.parentElement;
  if (p?.tagName === "LABEL" && p.textContent) parts.push(p.textContent);
  // Walk up a few ancestor levels collecting only local labels/question text.
  // Avoid broad descendant scans that pull unrelated neighboring questions.
  let ancestor = control.parentElement;
  const seenText = new Set();
  for (let depth = 0; depth < 3 && ancestor; depth += 1, ancestor = ancestor.parentElement) {
    // Prefer direct child labels in this wrapper.
    const nearLabel = ancestor.querySelector(":scope > label, :scope > legend, :scope > [class*='label']");
    if (nearLabel && nearLabel !== control) {
      const t = (nearLabel.textContent || "").trim().slice(0, 180);
      if (t && !seenText.has(t)) { parts.push(t); seenText.add(t); }
    }
    // Heading-like direct children only.
    for (const heading of ancestor.querySelectorAll(":scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6, :scope > legend")) {
      const t = (heading.textContent || "").trim().slice(0, 180);
      if (t && !seenText.has(t)) { parts.push(t); seenText.add(t); break; }
    }
    // Short prompt-like siblings near this control (direct children to stay local).
    for (const el of Array.from(ancestor.children || [])) {
      if (!(el instanceof Element)) continue;
      if (!/^(P|SPAN|DIV)$/i.test(el.tagName)) continue;
      if (el.contains(control)) continue;
      if (el.querySelector("input, select, textarea, button")) continue;
      const t = (el.textContent || "").trim().slice(0, 180);
      if (!looksLikeUiNoiseText(t) && t.length > 10 && t.length < 200 && !seenText.has(t)) {
        parts.push(t);
        seenText.add(t);
        break;
      }
    }
    // Stop once we find a good wrapper (form-like element)
    if (ancestor.matches("form, fieldset, section, article")) break;
  }
  const prev = control.previousElementSibling;
  if (prev?.textContent) parts.push(prev.textContent.slice(0, 120));
  // data-automation-id on ancestor wrappers (common in component-based form frameworks)
  const ancestorAutoId = control.closest("[data-automation-id]")?.getAttribute("data-automation-id") || "";
  if (ancestorAutoId) parts.push(ancestorAutoId.replace(/--/g, " ").replace(/([A-Z])/g, " $1"));
  const db = control.getAttribute("aria-describedby");
  if (db) {
    for (const id of db.split(/\s+/).filter(Boolean)) {
      const n = doc.getElementById(id);
      if (n?.textContent) parts.push(n.textContent.slice(0, 200));
    }
  }
  return normalize(parts.map((p) => sanitizeContextChunk(p)).filter(Boolean).join(" "));
}

function collectControlHelpText(control) {
  if (!(control instanceof Element)) return "";
  const out = [];
  const seen = new Set();
  const push = (raw) => {
    const txt = sanitizeContextChunk(raw).slice(0, 220);
    if (!txt) return;
    const key = txt.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(txt);
  };
  push(control.getAttribute("aria-description") || "");
  const describedBy = control.getAttribute("aria-describedby");
  if (describedBy) {
    for (const id of describedBy.split(/\s+/).filter(Boolean)) {
      push(control.ownerDocument?.getElementById(id)?.textContent || "");
    }
  }
  const wrapper = control.closest("fieldset, section, [role='group'], [data-automation-id], [class*='field' i]");
  if (wrapper) {
    for (const node of wrapper.querySelectorAll(":scope [id*='help' i], :scope [class*='help' i], :scope [class*='hint' i], :scope [class*='desc' i], :scope [data-help], :scope small")) {
      if (node.querySelector("input, select, textarea")) continue;
      push(node.textContent || "");
    }
  }
  return out.slice(0, 4).join(" | ").slice(0, 500);
}

function extendedGuessContext(control) {
  const base = getPlaywrightStyleContext(control);
  const grouped = addGroupPrefix(control, base);
  return sanitizeFieldContext(grouped);
}

function addGroupPrefix(control, rawContext) {
  const sectionPath = getSemanticSectionPath(control);
  const ctx = normalize(`${String(rawContext || "")} ${sectionPath}`);
  if (!ctx) return rawContext;
  // Preserve structure for repeated Education/Experience blocks so fields in
  // the same row stay tied together for LLM reasoning.
  let sectionKind = profileFieldCatalog.repeatableKindFromText?.(ctx) || "";
  let isEducation = sectionKind === "education";
  let isExperience = sectionKind === "experience";
  const isWebsite = sectionKind === "website";
  // Fallback: ATS platforms (Workday, etc.) embed the section type and a numeric index
  // directly in element IDs (e.g. "workExperience-8--startDate-dateSectionMonth-input").
  // The ancestor text walk in getSemanticSectionPath is depth-limited and often only
  // reaches the inner "From*"/"To*" fieldset legend, missing the outer experience heading.
  let idRowOverride = null;
  if (control instanceof Element) {
    const id = control.id || "";
    const expMatch = /\bworkExperience[_-](\d+)\b/i.exec(id);
    const eduMatch = /\beducation[_-](\d+)\b/i.exec(id);
    if (expMatch || eduMatch) {
      if (expMatch) {
        sectionKind = "experience";
        isExperience = true;
      } else {
        sectionKind = "education";
        isEducation = true;
      }
      const idNum = Number((expMatch || eduMatch)[1]);
      const prefix = expMatch ? "workExperience" : "education";
      // Collect all unique numeric IDs for this section on the page, then find this
      // entry's visual rank — more reliable than using the raw ID number, since Workday
      // assigns non-sequential internal IDs (not simple 0,1,2… counters).
      const seen = new Set();
      for (const el of document.querySelectorAll(`[id^="${prefix}-"]`)) {
        const m = new RegExp(`^${prefix}-(\\d+)\\b`).exec(el.id);
        if (m) seen.add(Number(m[1]));
      }
      const sorted = Array.from(seen).sort((a, b) => a - b);
      const pos = sorted.indexOf(idNum);
      idRowOverride = pos >= 0 ? pos + 1 : idNum + 1;
    }
  }
  if ((!isEducation && !isExperience && !isWebsite) || !(control instanceof Element)) return rawContext;
  const explicit = findExplicitResumeRowContainer(control);
  const row = explicit?.row || findRepeatedRowContainer(control);
  const group = explicit?.section || control.closest(
    "fieldset, section, [data-automation-id], [class*='education' i], [id*='education' i], [class*='experience' i], [id*='experience' i], [class*='employment' i], [id*='employment' i], [class*='work' i], [id*='work' i], [class*='website' i], [id*='website' i], [class*='social' i], [id*='social' i]"
  );
  const rowIndex = explicit?.index || idRowOverride || (row ? getRowIndex(row) : 1);
  const fallbackLabel = profileFieldCatalog.REPEATABLE_SECTION_DEFINITIONS?.[sectionKind]?.label?.toLowerCase() ||
    (isExperience ? "work experience" : isWebsite ? "website" : "education");
  const aria = group?.getAttribute("aria-label");
  const heading = group?.querySelector("legend, h1, h2, h3, h4, h5, h6")?.textContent;
  const groupLabel = normalize(
    (aria && profileFieldCatalog.repeatableKindFromText?.(aria) ? aria : null) ||
    (heading && profileFieldCatalog.repeatableKindFromText?.(heading) ? heading : null) ||
    aria ||
    heading ||
    group?.getAttribute("data-automation-id") ||
    fallbackLabel
  );
  return `[group:${groupLabel || fallbackLabel} row:${Math.max(1, rowIndex)}] ${rawContext}`;
}

function collectControlHelpText(control) {
  if (!(control instanceof Element)) return "";
  const out = [];
  const seen = new Set();
  const push = (raw) => {
    const txt = sanitizeContextChunk(raw).slice(0, 220);
    if (!txt) return;
    const key = txt.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(txt);
  };
  push(control.getAttribute("aria-description") || "");
  const describedBy = control.getAttribute("aria-describedby");
  if (describedBy) {
    for (const id of describedBy.split(/\s+/).filter(Boolean)) {
      push(control.ownerDocument?.getElementById(id)?.textContent || "");
    }
  }
  const wrapper = control.closest("fieldset, section, [role='group'], [data-automation-id], [class*='field' i]");
  if (wrapper) {
    for (const node of wrapper.querySelectorAll(":scope [id*='help' i], :scope [class*='help' i], :scope [class*='hint' i], :scope [class*='desc' i], :scope [data-help], :scope small")) {
      if (node.querySelector("input, select, textarea")) continue;
      push(node.textContent || "");
    }
  }
  return out.slice(0, 4).join(" | ").slice(0, 500);
}

function extendedGuessContext(control) {
  const base = getPlaywrightStyleContext(control);
  const grouped = addGroupPrefix(control, base);
  return sanitizeFieldContext(grouped);
}

function addGroupPrefix(control, rawContext) {
  const sectionPath = getSemanticSectionPath(control);
  const ctx = normalize(`${String(rawContext || "")} ${sectionPath}`);
  if (!ctx) return rawContext;
  // Preserve structure for repeated Education/Experience blocks so fields in
  // the same row stay tied together for LLM reasoning.
  let sectionKind = profileFieldCatalog.repeatableKindFromText?.(ctx) || "";
  let isEducation = sectionKind === "education";
  let isExperience = sectionKind === "experience";
  const isWebsite = sectionKind === "website";
  // Fallback: ATS platforms (Workday, etc.) embed the section type and a numeric index
  // directly in element IDs (e.g. "workExperience-8--startDate-dateSectionMonth-input").
  // The ancestor text walk in getSemanticSectionPath is depth-limited and often only
  // reaches the inner "From*"/"To*" fieldset legend, missing the outer experience heading.
  let idRowOverride = null;
  if (control instanceof Element) {
    const id = control.id || "";
    const expMatch = /\bworkExperience[_-](\d+)\b/i.exec(id);
    const eduMatch = /\beducation[_-](\d+)\b/i.exec(id);
    if (expMatch || eduMatch) {
      if (expMatch) {
        sectionKind = "experience";
        isExperience = true;
      } else {
        sectionKind = "education";
        isEducation = true;
      }
      const idNum = Number((expMatch || eduMatch)[1]);
      const prefix = expMatch ? "workExperience" : "education";
      // Collect all unique numeric IDs for this section on the page, then find this
      // entry's visual rank — more reliable than using the raw ID number, since Workday
      // assigns non-sequential internal IDs (not simple 0,1,2… counters).
      const seen = new Set();
      for (const el of document.querySelectorAll(`[id^="${prefix}-"]`)) {
        const m = new RegExp(`^${prefix}-(\\d+)\\b`).exec(el.id);
        if (m) seen.add(Number(m[1]));
      }
      const sorted = Array.from(seen).sort((a, b) => a - b);
      const pos = sorted.indexOf(idNum);
      idRowOverride = pos >= 0 ? pos + 1 : idNum + 1;
    }
  }
  if ((!isEducation && !isExperience && !isWebsite) || !(control instanceof Element)) return rawContext;
  const explicit = findExplicitResumeRowContainer(control);
  const row = explicit?.row || findRepeatedRowContainer(control);
  const group = explicit?.section || control.closest(
    "fieldset, section, [data-automation-id], [class*='education' i], [id*='education' i], [class*='experience' i], [id*='experience' i], [class*='employment' i], [id*='employment' i], [class*='work' i], [id*='work' i], [class*='website' i], [id*='website' i], [class*='social' i], [id*='social' i]"
  );
  const rowIndex = explicit?.index || idRowOverride || (row ? getRowIndex(row) : 1);
  const fallbackLabel = profileFieldCatalog.REPEATABLE_SECTION_DEFINITIONS?.[sectionKind]?.label?.toLowerCase() ||
    (isExperience ? "work experience" : isWebsite ? "website" : "education");
  const aria = group?.getAttribute("aria-label");
  const heading = group?.querySelector("legend, h1, h2, h3, h4, h5, h6")?.textContent;
  const groupLabel = normalize(
    (aria && profileFieldCatalog.repeatableKindFromText?.(aria) ? aria : null) ||
    (heading && profileFieldCatalog.repeatableKindFromText?.(heading) ? heading : null) ||
    aria ||
    heading ||
    group?.getAttribute("data-automation-id") ||
    fallbackLabel
  );
  return `[group:${groupLabel || fallbackLabel} row:${Math.max(1, rowIndex)}] ${rawContext}`;
}

function directGroupHeading(el) {
  if (!(el instanceof Element)) return "";
  const aria = el.getAttribute?.("aria-label");
  if (aria && profileFieldCatalog.repeatableKindFromText?.(aria)) return normalize(aria);
  const heading = el.querySelector?.("legend, h1, h2, h3, h4, h5, h6")?.textContent;
  if (heading && profileFieldCatalog.repeatableKindFromText?.(heading)) return normalize(heading);
  return normalize(
    aria ||
    heading ||
    el.getAttribute?.("data-automation-id") ||
    el.querySelector?.("label")?.textContent ||
    ""
  );
}

function findExplicitResumeRowContainer(control) {
  let el = control instanceof Element ? control.parentElement : null;
  for (let depth = 0; depth < 8 && el; depth += 1, el = el.parentElement) {
    const heading = directGroupHeading(el);
    const sectionKind = profileFieldCatalog.repeatableKindFromText?.(heading) || "";
    const index = heading.match(/\b(\d+)\b/)?.[1] || "";
    if (!sectionKind || !index) continue;
    let section = el.parentElement;
    while (section && section instanceof Element) {
      const label = directGroupHeading(section);
      if (profileFieldCatalog.repeatableKindFromText?.(label) === sectionKind) break;
      section = section.parentElement;
    }
    return { row: el, section, index: Number(index || 1) };
  }
  return null;
}

function findRepeatedRowContainer(control) {
  let el = control.parentElement;
  // 12 levels to reach experience entry containers in ATS platforms like Workday,
  // where spinbutton date inputs sit ~9 levels inside the entry wrapper.
  for (let i = 0; i < 12 && el; i += 1, el = el.parentElement) {
    const parent = el.parentElement;
    if (!parent) continue;
    const siblings = Array.from(parent.children).filter((c) => c instanceof Element);
    const rowLike = siblings.filter((sib) => sib.querySelector("input, select, textarea"));
    if (rowLike.length >= 2 && rowLike.includes(el)) return el;
  }
  return null;
}

function getRowIndex(row) {
  const parent = row?.parentElement;
  if (!parent) return 1;
  const rows = Array.from(parent.children).filter(
    (c) => c instanceof Element && c.querySelector("input, select, textarea")
  );
  const idx = rows.indexOf(row);
  return idx >= 0 ? idx + 1 : 1;
}

function looksLikeUiNoiseText(text) {
  const t = normalize(String(text || ""));
  if (!t) return true;
  return (
    /results found|no results found|select\.\.\.|loading|type to search|press enter|use arrow keys/i.test(t) ||
    /^\d+\s+results?\s+found$/i.test(t)
  );
}

function sanitizeContextChunk(chunk) {
  const raw = normalize(String(chunk || ""));
  if (!raw) return "";
  if (looksLikeUiNoiseText(raw)) return "";
  return raw
    .replace(/\bquestion\s+\d{5,}\b/gi, " ")
    .replace(/\b\d{5,}\b/g, " ")
    .replace(/\b\d+\s+results?\s+found\b/gi, " ")
    .replace(/\bno results found\b/gi, " ")
    .replace(/\bselect\.\.\.\b/gi, " ")
    .replace(/\boff\b/gi, " ")
    .replace(/\*{1,}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compactRepeatedWords(text) {
  const tokens = String(text || "").split(/\s+/).filter(Boolean);
  const out = [];
  for (const tok of tokens) {
    const prev = out[out.length - 1];
    if (prev && normalize(prev) === normalize(tok)) continue;
    out.push(tok);
  }
  return out.join(" ");
}

function compactRepeatedClauses(text) {
  const clauses = String(text || "")
    .split(/\s*\|\s*|\s*\?\s*/g)
    .map((c) => normalize(c.replace(/\*/g, " ")))
    .filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const c of clauses) {
    const key = c.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
    if (out.length >= 6) break;
  }
  return out.join(" | ");
}

function sanitizeFieldContext(text) {
  const raw = normalize(String(text || ""));
  if (!raw) return "";
  const parts = raw
    .split(/\s*\|\s*|\s{2,}/)
    .map((p) => sanitizeContextChunk(p))
    .filter(Boolean);
  const seen = new Set();
  const deduped = [];
  for (const p of parts) {
    const key = p.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(p);
  }
  const merged = compactRepeatedClauses(compactRepeatedWords(deduped.join(" | ")))
    .replace(/\b(equal employment opportunity|eeo|voluntary self[- ]?identification|disability status|race\/ethnicity)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalize(merged).slice(0, 280);
}


  global.__formFillerFieldDescriptorTools = {
    ariaLabelledByText,
    humanizeAttr,
    candidateTextForField,
    candidateTextForSelect,
    candidateTextForControl,
    simpleHash,
    getSemanticSectionPath,
    getStrictControlLabel,
    getRadioOrCheckboxGroupLabel,
    getPlaywrightSemanticParts,
    getPlaywrightStyleContext,
    hasEnoughSemanticSignal,
    getVisualOrderMeta,
    computeFieldFingerprint,
    gatherExtendedHints,
    collectControlHelpText,
    extendedGuessContext,
    addGroupPrefix,
    directGroupHeading,
    findExplicitResumeRowContainer,
    findRepeatedRowContainer,
    getRowIndex,
    looksLikeUiNoiseText,
    sanitizeContextChunk,
    compactRepeatedWords,
    compactRepeatedClauses,
    sanitizeFieldContext
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
