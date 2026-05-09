export const MAX_CLEANED_LLM_FIELDS = 40;
export const MAX_DOM_FIELDS = 120;

export function normalizeSpaces(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function isWeakControlCaption(text) {
  const t = normalizeSpaces(text).toLowerCase();
  if (!t || t.length < 8) return true;
  if (/^(select|choose|open|browse|search|add|clear|show\s+menu|menu)\b/.test(t)) return true;
  if (/^(yes|no|ok|cancel|submit|next|back)\b$/i.test(t)) return true;
  return false;
}

/**
 * Human-readable field title. Snapshot/extracted rows usually set `label` / `field_label`.
 * Gap-fill candidates also carry `section` (ancestor question path) and `name` (often a short
 * accessible name on the control, e.g. a combobox trigger); prefer section + richer caption
 * so UI matches snapshot-style Prev/Next cards.
 */
export function displayLabelForField(field) {
  const primary = normalizeSpaces(
    field?.field_label ||
      field?.label ||
      field?.question ||
      field?.helpText ||
      field?.help_text ||
      ""
  );
  if (primary) return primary;

  const section = normalizeSpaces(field?.section || "");
  const name = normalizeSpaces(field?.name || "");
  const context = normalizeSpaces(field?.context || "");
  const id = normalizeSpaces(field?.id || field?.elementId || "");

  const caption =
    !isWeakControlCaption(name) ? name : context.length > name.length + 8 ? context : name || context;

  if (section && caption) {
    const s = section.toLowerCase();
    const c = caption.toLowerCase();
    if (s.includes(c) || c.includes(s)) return normalizeSpaces(section.length >= caption.length ? section : caption);
    return normalizeSpaces(`${section} — ${caption}`);
  }
  if (section) return section;
  return normalizeSpaces(caption || id || "");
}

export function normalizeReaderDomFields(fields) {
  function optionText(option) {
    if (typeof option === "string") return option.trim();
    return String(option?.label || option?.text || option?.value || "").trim();
  }

  function normalizeOptionGroups(field) {
    const rawGroups = Array.isArray(field?.optionGroups)
      ? field.optionGroups
      : (Array.isArray(field?.option_groups) ? field.option_groups : []);
    return rawGroups.map((group) => ({
      label: String(group?.label || group?.name || "").trim(),
      options: Array.isArray(group?.options)
        ? group.options.map(optionText).filter(Boolean).slice(0, 120)
        : []
    })).filter((group) => group.label || group.options.length);
  }

  return (Array.isArray(fields) ? fields : [])
    .slice(0, MAX_DOM_FIELDS)
    .map((f) => {
      const optionGroups = normalizeOptionGroups(f);
      const flatOptions = Array.isArray(f?.options)
        ? f.options.map(optionText).filter(Boolean).slice(0, 120)
        : [];
      return {
        label: String(f?.label || "").trim(),
        type: String(f?.type || "other").trim(),
        name: String(f?.name || "").trim(),
        id: String(f?.id || "").trim(),
        required: !!f?.required,
        options: flatOptions.length ? flatOptions : optionGroups.flatMap((group) => group.options).slice(0, 120),
        optionGroups,
        needsExpansion: !!(f?.needsExpansion || f?.needs_expansion),
        expansionReason: String(f?.expansionReason || f?.expansion_reason || "").trim()
      };
    })
    .filter((f) => f.label || f.name || f.id);
}

export function toDisplayFields(domFields) {
  return (Array.isArray(domFields) ? domFields : []).slice(0, MAX_CLEANED_LLM_FIELDS).map((field) => ({
    field_label: displayLabelForField(field),
    field_type: String(field.type || "other").trim().toLowerCase(),
    suggested_value: "",
    why: [field.name ? `name=${field.name}` : "", field.id ? `id=${field.id}` : ""].filter(Boolean).join("; "),
    confidence: 0.85,
    options: Array.isArray(field.options) ? field.options : [],
    optionGroups: Array.isArray(field.optionGroups) ? field.optionGroups : [],
    needsExpansion: !!field.needsExpansion,
    expansionReason: String(field.expansionReason || "").trim()
  })).filter((field) => field.field_label);
}

export function fieldIdentity(field) {
  return [
    normalizeSpaces(field?.label || field?.field_label || "").toLowerCase(),
    normalizeSpaces(field?.name || "").toLowerCase(),
    normalizeSpaces(field?.id || "").toLowerCase(),
    normalizeSpaces(field?.type || field?.field_type || "").toLowerCase()
  ].join("|");
}

export function mergeFieldArrays(fieldArrays) {
  const isLikelyHoneypotField = (field) => {
    const joined = [
      field?.label,
      field?.name,
      field?.id,
      field?.field_label,
      field?.field_type,
      field?.why,
      field?.helpText,
      ...(Array.isArray(field?.options) ? field.options : [])
    ]
      .map((v) => String(v || "").toLowerCase())
      .join(" ");
    if (!joined.trim()) return false;
    if (/(honeypot|anti[\s-]?spam|spam trap|bot trap|trap field)\b/.test(joined)) return true;
    if (/(robots?\s*only|for\s+robots|if\s+you(?:'| a)?re\s+human|if\s+human|do\s+not\s+enter|leave\s+(?:this\s+)?(?:field|input)\s+blank)\b/.test(joined)) {
      return true;
    }
    // Many honeypots are named "website" with explicit anti-bot instructions nearby.
    if (/\bwebsite\b/.test(joined) && /(robot|human|do\s+not\s+enter|leave\s+blank|spam)\b/.test(joined)) {
      return true;
    }
    return false;
  };
  const merged = [];
  const seen = new Set();
  for (const fields of fieldArrays) {
    for (const field of Array.isArray(fields) ? fields : []) {
      if (isLikelyHoneypotField(field)) continue;
      const key = fieldIdentity(field);
      if (!key.trim() || seen.has(key)) continue;
      seen.add(key);
      merged.push(field);
      if (merged.length >= MAX_DOM_FIELDS) return merged;
    }
  }
  return merged;
}
