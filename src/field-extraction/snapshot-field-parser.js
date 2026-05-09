import { mergeFieldArrays, normalizeSpaces, toDisplayFields } from "./field-normalization.js";

function unquoteSnapshotString(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";
  if (raw.startsWith('"') && raw.endsWith('"')) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw.slice(1, -1);
    }
  }
  return raw;
}

function roleToFieldType(role) {
  if (role === "searchbox") return "text";
  if (role === "spinbutton" || role === "slider") return "number";
  if (role === "switch") return "checkbox";
  return {
    textbox: "text",
    combobox: "select",
    listbox: "select",
    checkbox: "checkbox",
    radio: "radio",
    group: "group",
    radiogroup: "radio"
  }[role] || "other";
}

function snapshotRoleLine(line) {
  const match = /^(\s*)-\s+(textbox|searchbox|combobox|listbox|spinbutton|checkbox|radio|switch|slider|group|radiogroup)\b\s*(.*)$/i.exec(line);
  if (!match) return null;
  const suffix = String(match[3] || "").replace(/:\s*$/, "");
  const quoted = /"((?:\\.|[^"\\])*)"/.exec(suffix);
  const ref = /\[ref=([^\]]+)\]/.exec(suffix);
  const name = quoted ? unquoteSnapshotString(`"${quoted[1]}"`) : "";
  return {
    indent: match[1].length,
    role: match[2].toLowerCase(),
    label: name,
    ref: ref ? ref[1] : "",
    checked: /\[checked\]/.test(suffix)
  };
}

function snapshotTextCarrierLine(line) {
  const match = /^(\s*)-\s+(generic|button|legend)\b\s*(.*)$/i.exec(line);
  if (!match) return null;
  const suffix = String(match[3] || "").replace(/:\s*$/, "");
  const quoted = /"((?:\\.|[^"\\])*)"/.exec(suffix);
  const ref = /\[ref=([^\]]+)\]/.exec(suffix);
  let text = quoted ? unquoteSnapshotString(`"${quoted[1]}"`) : "";
  if (!text) {
    const inline = /:\s*(.*)$/.exec(suffix);
    if (inline) text = unquoteSnapshotString(inline[1] || "");
  }
  return {
    indent: match[1].length,
    role: match[2].toLowerCase(),
    ref: ref ? ref[1] : "",
    text: normalizeSpaces(text)
  };
}

function snapshotPlainTextLine(line) {
  const match = /^(\s*)-\s+text:\s*(.*)$/i.exec(line);
  if (!match) return null;
  return {
    indent: match[1].length,
    text: normalizeSpaces(unquoteSnapshotString(match[2] || ""))
  };
}

function snapshotPropertyLine(line) {
  const match = /^(\s*)-\s+\/([a-z-]+):\s*(.*)$/i.exec(line);
  if (!match) return null;
  return {
    indent: match[1].length,
    key: match[2],
    value: unquoteSnapshotString(match[3] || "")
  };
}

function snapshotListItem(line) {
  const match = /^(\s*)-\s+(.+)$/.exec(line);
  if (!match) return null;
  if (/^\/[a-z-]+:/i.test(match[2])) return null;
  if (/^text:/i.test(match[2])) return null;
  if (/^(textbox|searchbox|combobox|listbox|spinbutton|checkbox|radio|switch|slider|group|radiogroup)\b/i.test(match[2])) return null;
  return { indent: match[1].length, value: unquoteSnapshotString(match[2]) };
}

function isUploadFieldText(text) {
  return /\b(select file|upload (?:your )?(?:resume|cv)|attach|attachment|browse|drag\s*&?\s*drop)\b/i.test(
    String(text || "")
  );
}

function cleanGroupedOptionLabel(label, parentLabel) {
  const raw = normalizeSpaces(label);
  if (!raw) return "";
  const parent = normalizeSpaces(parentLabel);
  if (parent && raw.toLowerCase().includes(parent.toLowerCase())) {
    return normalizeSpaces(raw.replace(parent, "").replace(/^,+|,+$/g, ""));
  }
  const parentHead = normalizeSpaces(parent.split(":")[0] || "");
  if (parentHead && raw.toLowerCase().includes(parentHead.toLowerCase())) {
    return normalizeSpaces(raw.split(",")[0] || raw);
  }
  return raw;
}

function isChoiceRole(role) {
  return role === "radio" || role === "checkbox";
}

function isPlaceholderSelectLabel(label) {
  return /^(select|select\.\.\.|choose|choose\.\.\.)\b/i.test(normalizeSpaces(label));
}

function isQuestionLikeLabel(label) {
  const text = normalizeSpaces(label);
  if (!text) return false;
  return /\?$/.test(text) || /^(?:are|can|did|do|does|have|has|is|were|will|would)\b/i.test(text);
}

function isActionButtonLabel(label) {
  return /^(?:back|previous|prev|next|continue|save(?: and continue)?|submit|cancel|close|done|finish|review|search for jobs|candidate home|job alerts)$/i.test(
    normalizeSpaces(label)
  );
}

function isLikelySelectButtonLabel(buttonLabel, contextLabel) {
  const label = normalizeSpaces(buttonLabel);
  const ctx = cleanFieldLabel(contextLabel);
  if (!label || isActionButtonLabel(label)) return false;
  if (/\bselect one\b/i.test(label)) return true;
  if (ctx && label.toLowerCase().startsWith(ctx.toLowerCase()) && /\brequired\b/i.test(label)) return true;
  return false;
}

function isExpandableAddButtonLabel(buttonLabel, contextLabel) {
  const label = normalizeSpaces(buttonLabel);
  const ctx = cleanFieldLabel(contextLabel);
  if (!label || isActionButtonLabel(label)) return false;
  if (!/\badd\b|add another|add item|add entry|add row/i.test(label)) return false;
  if (/\b(delete|remove|upload|select files?|browse)\b/i.test(label)) return false;
  // Plain "Add" is meaningful when it is scoped by a form section (Work Experience,
  // Education, Websites, Social URLs, Certifications, Projects, etc.).
  return Boolean(ctx) || /\b(add another|add item|add entry|add row|add website|add url|add link|add experience|add education|add employment|add school|add degree|add certification|add project)\b/i.test(label);
}

function deriveSelectButtonLabel(buttonLabel, contextLabel) {
  const ctx = cleanFieldLabel(contextLabel);
  const label = normalizeSpaces(buttonLabel);
  if (ctx && label.toLowerCase().startsWith(ctx.toLowerCase())) return ctx;
  return cleanFieldLabel(label.replace(/\b(?:select one|required)\b.*$/i, ""));
}

function shouldGroupCheckboxUnderParent(parent, childLabel) {
  if (!parent?.label) return false;
  if (parent.type === "checkbox") return true;
  if (parent.type !== "group") return false;
  const option = cleanGroupedOptionLabel(childLabel, parent.label);
  if (!option) return false;
  return isQuestionLikeLabel(parent.label);
}

function isChoiceOptionEcho(field, text) {
  const value = normalizeSpaces(text).toLowerCase();
  if (!value || !["radio", "checkbox"].includes(field?.type)) return false;
  return (Array.isArray(field.options) ? field.options : []).some((option) => normalizeSpaces(option).toLowerCase() === value);
}

function currentLineIndent(line) {
  const match = /^(\s*)/.exec(String(line || ""));
  return match ? match[1].length : 0;
}

function cleanFieldLabel(label) {
  return normalizeSpaces(String(label || "").replace(/[✱*]+/g, " ")).replace(/\s+:$/, ":").trim();
}

/**
 * Deterministic snapshot parser. This is intentionally simple and transparent:
 * it reads our browser_snapshot YAML conventions and extracts visible field rows
 * without using an LLM.
 * @param {{ url?: string, title?: string, snapshotText?: string }} input
 */
export function parseSnapshotFields({ url = "", title = "", snapshotText = "" } = {}) {
  const lines = String(snapshotText || "").split(/\r?\n/);
  const fields = [];
  const stack = [];
  const textContextStack = [];
  const groupedByContext = new Map();
  let currentOptionsField = null;
  let optionsIndent = -1;
  let nonFormLandmarkIndent = null;

  function isNonFormLandmarkLine(line) {
    return /^\s*-\s+(navigation|banner|contentinfo)\b/i.test(line);
  }

  function currentField() {
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i]?.field) return stack[i].field;
    }
    return null;
  }

  function currentRepeatableRowLabel() {
    for (let i = stack.length - 1; i >= 0; i--) {
      const label = cleanFieldLabel(stack[i]?.field?.label || "");
      if (/\b(work experience|education)\s+\d+\b/i.test(label)) return label;
    }
    return "";
  }

  function groupedFieldLabel(baseLabel, parentField) {
    const base = cleanFieldLabel(baseLabel);
    const rowLabel = currentRepeatableRowLabel();
    const parentLabel = cleanFieldLabel(parentField?.label || "");
    const pieces = [];
    if (rowLabel && !base.toLowerCase().includes(rowLabel.toLowerCase())) pieces.push(rowLabel);
    if (
      parentLabel &&
      parentLabel !== rowLabel &&
      !/\b(work experience|education)\s+\d+\b/i.test(parentLabel) &&
      !base.toLowerCase().includes(parentLabel.toLowerCase())
    ) {
      pieces.push(parentLabel);
    }
    pieces.push(base);
    return cleanFieldLabel(pieces.filter(Boolean).join(" "));
  }

  function currentTextContext(indent) {
    for (let i = textContextStack.length - 1; i >= 0; i--) {
      const ctx = textContextStack[i];
      if (
        Math.abs(indent - ctx.indent) <= 6 &&
        ctx.text &&
        !/^[*✱]+$/.test(ctx.text)
      ) {
        return ctx;
      }
    }
    return null;
  }

  function groupedChoiceFieldFor(ctx, role) {
    const label = cleanFieldLabel(ctx.text);
    if (!label) return null;
    const type = role === "checkbox" ? "checkbox" : "radio";
    const key = `${ctx.indent}|${label.toLowerCase()}|${type}`;
    let field = groupedByContext.get(key);
    if (!field) {
      field = {
        label,
        type,
        name: "",
        id: ctx.ref,
        required: /[✱*]/.test(ctx.text),
        options: [],
        optionGroups: [],
        needsExpansion: false,
        expansionReason: ""
      };
      groupedByContext.set(key, field);
      fields.push(field);
    }
    return field;
  }

  function isKnownChoiceOptionText(text) {
    const value = normalizeSpaces(text).toLowerCase();
    if (!value) return false;
    return fields.some((field) => isChoiceOptionEcho(field, value));
  }

  for (const line of lines) {
    const indent = currentLineIndent(line);
    if (nonFormLandmarkIndent !== null && indent <= nonFormLandmarkIndent) nonFormLandmarkIndent = null;
    if (isNonFormLandmarkLine(line)) {
      nonFormLandmarkIndent = indent;
      continue;
    }
    if (nonFormLandmarkIndent !== null) continue;
    const isControlLine = /^\s*-\s+(textbox|searchbox|combobox|listbox|spinbutton|checkbox|radio|switch|slider|group|radiogroup|button)\b/i.test(line);
    const isGenericWrapperLine = /^\s*-\s+generic\b/i.test(line);
    if (!/^\s*-\s+list\b/i.test(line) && !isGenericWrapperLine) {
      while (textContextStack.length && textContextStack[textContextStack.length - 1].indent > indent) {
        if (isControlLine && textContextStack[textContextStack.length - 1].indent - indent <= 2) break;
        textContextStack.pop();
      }
    }

    const role = snapshotRoleLine(line);
    if (role) {
      while (stack.length && stack[stack.length - 1].indent >= role.indent) stack.pop();
      currentOptionsField = null;
      optionsIndent = -1;

      const parent = currentField();
      const isGroup = role.role === "group" || role.role === "radiogroup";
      const ctx = currentTextContext(role.indent);
      if (isChoiceRole(role.role) && ctx && ctx.text !== role.label) {
        const grouped = groupedChoiceFieldFor(ctx, role.role);
        const option = cleanGroupedOptionLabel(role.label, grouped?.label || "");
        if (grouped && option && !grouped.options.includes(option)) grouped.options.push(option);
        stack.push({ indent: role.indent, field: grouped || parent });
        continue;
      }
      if (role.role === "radio" && parent && role.label) {
        if (!parent.options.includes(role.label)) parent.options.push(role.label);
        stack.push({ indent: role.indent, field: parent });
        continue;
      }
      if (role.role === "checkbox" && shouldGroupCheckboxUnderParent(parent, role.label)) {
        const option = cleanGroupedOptionLabel(role.label, parent.label);
        if (option && !parent.options.includes(option)) parent.options.push(option);
        parent.type = "checkbox";
        stack.push({ indent: role.indent, field: parent });
        continue;
      }
      const field = {
        label: cleanFieldLabel(role.label || (parent && role.role === "radio" ? parent.label : "")),
        type: roleToFieldType(role.role),
        name: "",
        id: role.ref,
        required: false,
        options: [],
        optionGroups: [],
        needsExpansion: false,
        expansionReason: ""
      };
      if (/[✱*]/.test(role.label)) field.required = true;
      if (parent?.type === "group" && parent.label && role.role !== "combobox" && !field.label) {
        field.label = parent.label;
      }
      if (
        (role.role === "combobox" || role.role === "listbox") &&
        ctx?.text &&
        (isPlaceholderSelectLabel(field.label) || /^items selected$/i.test(field.label))
      ) {
        field.label = cleanFieldLabel(ctx.text);
      }
      if (
        ["textbox", "searchbox", "spinbutton", "slider"].includes(role.role) &&
        ctx?.text &&
        !field.label
      ) {
        field.label = cleanFieldLabel(ctx.text);
      }
      if (isGroup) field.type = role.role === "radiogroup" ? "radio" : "group";
      if (
        !isGroup &&
        ctx?.text &&
        /^(month|year)$/i.test(field.label) &&
        /\b(from|to|start|end|actual|expected)\b/i.test(ctx.text)
      ) {
        field.label = cleanFieldLabel(`${ctx.text} ${field.label}`);
      }
      if (!isGroup) field.label = groupedFieldLabel(field.label, parent);
      if (field.label || role.ref) fields.push(field);
      stack.push({ indent: role.indent, field });
      continue;
    }

    const carrier = snapshotTextCarrierLine(line);
    if (carrier) {
      while (stack.length && stack[stack.length - 1].indent >= carrier.indent) stack.pop();
      currentOptionsField = null;
      optionsIndent = -1;
      const field = currentField();
      if (carrier.role === "button" && carrier.text && isUploadFieldText(carrier.text)) {
        fields.push({
          label: cleanFieldLabel(carrier.text),
          type: "file",
          name: "",
          id: carrier.ref,
          required: /\*/.test(carrier.text) || /✱/.test(carrier.text),
          options: [],
          optionGroups: [],
          needsExpansion: false,
          expansionReason: ""
        });
        continue;
      }
      const ctx = currentTextContext(carrier.indent);
      if (carrier.role === "button" && isExpandableAddButtonLabel(carrier.text, field?.label || ctx?.text || "")) {
        const sectionLabel = cleanFieldLabel(field?.label || ctx?.text || "");
        fields.push({
          label: cleanFieldLabel(`${sectionLabel ? `${sectionLabel} ` : ""}${carrier.text}`),
          type: "expandButton",
          name: "",
          id: carrier.ref,
          required: false,
          options: [],
          optionGroups: [],
          needsExpansion: true,
          expansionReason: "expandable add button"
        });
        continue;
      }
      if (carrier.role === "button" && isLikelySelectButtonLabel(carrier.text, ctx?.text || "")) {
        const field = {
          label: groupedFieldLabel(deriveSelectButtonLabel(carrier.text, ctx?.text || ""), currentField()),
          type: "select",
          name: "",
          id: carrier.ref,
          required: /\brequired\b/i.test(carrier.text) || /[✱*]/.test(carrier.text) || /[✱*]/.test(ctx?.text || ""),
          options: [],
          optionGroups: [],
          needsExpansion: false,
          expansionReason: ""
        };
        if (field.label || carrier.ref) fields.push(field);
        stack.push({ indent: carrier.indent, field });
        continue;
      }
      if (
        carrier.text &&
        !/^[*✱]+$/.test(carrier.text) &&
        !isChoiceOptionEcho(field, carrier.text) &&
        !isKnownChoiceOptionText(carrier.text)
      ) {
        textContextStack.push({
          indent: carrier.indent,
          role: carrier.role,
          ref: carrier.ref,
          text: carrier.text
        });
      }
      if (!field) continue;
      if (carrier.role === "legend" && carrier.text && field.type === "group" && !field.label) {
        field.label = cleanFieldLabel(carrier.text);
      }
      if (carrier.text && field.type === "group" && isUploadFieldText(carrier.text)) {
        if (!field.label || /^select file\b/i.test(field.label)) field.label = cleanFieldLabel(carrier.text);
        field.type = "file";
      }
      continue;
    }

    const plainText = snapshotPlainTextLine(line);
    if (plainText) {
      const field = currentField();
      if (
        plainText.text &&
        !/^[*✱]+$/.test(plainText.text) &&
        !isChoiceOptionEcho(field, plainText.text) &&
        !isKnownChoiceOptionText(plainText.text)
      ) {
        textContextStack.push({
          indent: plainText.indent,
          role: "text",
          ref: "",
          text: plainText.text
        });
      }
      continue;
    }

    const prop = snapshotPropertyLine(line);
    if (prop) {
      const field = currentField();
      if (!field) continue;
      currentOptionsField = null;
      optionsIndent = -1;
      if (prop.key === "placeholder" && !field.label) field.label = prop.value;
      if (prop.key === "needs-expansion") field.needsExpansion = prop.value === "true";
      if (prop.key === "expansion-reason") field.expansionReason = prop.value;
      if (prop.key === "options") {
        currentOptionsField = field;
        optionsIndent = prop.indent;
      }
      continue;
    }

    const item = snapshotListItem(line);
    if (item && currentOptionsField && item.indent > optionsIndent) {
      const value = normalizeSpaces(item.value);
      if (value && !currentOptionsField.options.includes(value)) {
        currentOptionsField.options.push(value);
      }
    }
  }

  const merged = mergeFieldArrays([fields])
    .map((field) => {
      if (field.type === "group" && field.options.length) field.type = "radio";
      return field;
    })
    .filter((field) => {
      if (field.type === "group") return field.options.length || field.needsExpansion;
      return field.label || field.options.length || field.needsExpansion;
    });
  return {
    ok: true,
    url,
    title,
    fields: toDisplayFields(merged),
    domFields: merged,
    llmInputs: [],
    stats: {
      parser: "browser_snapshot_no_llm",
      controlsCount: merged.length,
      llm_call_count: 0,
      snapshot_chars: String(snapshotText || "").length
    }
  };
}

export const extractFieldsFromSnapshotNoLlm = parseSnapshotFields;
