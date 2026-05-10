/**
 * Extracted field cards renderer used by experiment output views.
 * Classic script: attaches view helpers to globalThis.
 */
(function (g) {
  const CSS = `
.reader-pane-title{margin:0 0 8px;font-size:12px;color:#94a3b8;text-transform:uppercase;letter-spacing:0.04em;}
.reader-fields-list{display:flex;flex-direction:column;gap:10px;color:#e5e7eb;white-space:normal;word-break:normal;}
.wr-llm-error{color:#f87171;font-size:12px;white-space:pre-wrap;}
.reader-stats{display:flex;flex-wrap:wrap;gap:6px;margin:-4px 0 2px;}
.reader-stat-pill{display:inline-flex;align-items:center;padding:3px 8px;border-radius:999px;border:1px solid #334155;background:#0f172a;color:#94a3b8;font-size:10px;white-space:nowrap;}
.reader-field-section{border:1px solid #26395f;border-radius:10px;background:rgba(15,23,42,.58);padding:8px;display:flex;flex-direction:column;gap:8px;}
.reader-field-section-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:2px 2px 6px;border-bottom:1px solid #26395f;}
.reader-field-section-title{font-size:11px;font-weight:700;color:#dbeafe;text-transform:uppercase;letter-spacing:.06em;}
.reader-field-section-count{font-size:10px;color:#94a3b8;}
.reader-field-section.reader-field-section-experience{border-color:#2563eb;background:rgba(30,64,175,.16);}
.reader-field-section.reader-field-section-education{border-color:#7c3aed;background:rgba(91,33,182,.16);}
.reader-field-section.reader-field-section-project{border-color:#0891b2;background:rgba(14,116,144,.14);}
.reader-field-section.reader-field-section-certification{border-color:#ca8a04;background:rgba(133,77,14,.14);}
.reader-field-section.reader-field-section-website{border-color:#059669;background:rgba(6,95,70,.14);}
.reader-field-group-meta{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;padding:6px 8px;border-radius:8px;border:1px solid #26395f;background:rgba(15,23,42,.75);}
.reader-field-group-title{font-size:10px;font-weight:700;color:#dbeafe;text-transform:uppercase;letter-spacing:.06em;}
.reader-field-group-pos{font-size:10px;color:#94a3b8;white-space:nowrap;}
.reader-field-group-meta.reader-field-section-experience{border-color:#2563eb;background:rgba(30,64,175,.18);}
.reader-field-group-meta.reader-field-section-education{border-color:#7c3aed;background:rgba(91,33,182,.18);}
.reader-field-group-meta.reader-field-section-project{border-color:#0891b2;background:rgba(14,116,144,.16);}
.reader-field-group-meta.reader-field-section-certification{border-color:#ca8a04;background:rgba(133,77,14,.16);}
.reader-field-group-meta.reader-field-section-website{border-color:#059669;background:rgba(6,95,70,.16);}
.reader-field-card{background:#111b30;border:1px solid #2b3a54;border-left:4px solid #64748b;border-radius:8px;padding:10px 12px;font-size:12px;line-height:1.45;}
.reader-field-card.reader-field-type-text{border-left-color:#38bdf8;}
.reader-field-card.reader-field-type-select{border-left-color:#a78bfa;}
.reader-field-card.reader-field-type-radio{border-left-color:#f59e0b;}
.reader-field-card.reader-field-type-checkbox{border-left-color:#22c55e;}
.reader-field-card.reader-field-type-file{border-left-color:#ec4899;}
.reader-field-card.reader-field-type-number{border-left-color:#14b8a6;}
.reader-field-card.reader-field-type-date{border-left-color:#eab308;}
.reader-field-card.reader-field-needs-expansion{border-left-color:#a855f7;background:#17152b;}
.reader-field-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px 10px;margin-bottom:8px;padding-bottom:8px;border-bottom:1px solid #1e293b;}
.reader-field-idx{font-size:10px;font-weight:700;color:#94a3b8;min-width:1.5rem;}
.reader-field-label{font-weight:600;color:#e5e7eb;flex:1 1 140px;min-width:0;word-break:break-word;}
.reader-field-type{font-size:10px;text-transform:uppercase;letter-spacing:0.04em;padding:2px 8px;border-radius:999px;background:#1e293b;color:#94a3b8;border:1px solid #334155;}
.reader-field-type.reader-field-type-text{background:rgba(14,116,144,.2);border-color:#0e7490;color:#bae6fd;}
.reader-field-type.reader-field-type-select{background:rgba(109,40,217,.2);border-color:#6d28d9;color:#ddd6fe;}
.reader-field-type.reader-field-type-radio{background:rgba(180,83,9,.2);border-color:#b45309;color:#fde68a;}
.reader-field-type.reader-field-type-checkbox{background:rgba(21,128,61,.2);border-color:#15803d;color:#bbf7d0;}
.reader-field-type.reader-field-type-file{background:rgba(190,24,93,.2);border-color:#be185d;color:#fbcfe8;}
.reader-field-type.reader-field-type-number{background:rgba(15,118,110,.2);border-color:#0f766e;color:#ccfbf1;}
.reader-field-type.reader-field-type-date{background:rgba(161,98,7,.2);border-color:#a16207;color:#fef3c7;}
.reader-field-block{margin-top:6px;}
.reader-field-block:first-of-type{margin-top:0;}
.reader-field-block-label{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:#94a3b8;margin-bottom:4px;}
.reader-field-why{font-size:11px;color:#cbd5e1;white-space:pre-wrap;word-break:break-word;}
.reader-field-options{display:flex;flex-wrap:wrap;gap:6px;}
.reader-field-option-pill{display:inline-flex;align-items:center;max-width:100%;padding:2px 8px;border-radius:999px;border:1px solid #334155;background:#0f172a;color:#cbd5e1;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.reader-field-option-group{margin:6px 0;padding:8px;border:1px solid #1e293b;border-radius:6px;background:#0c1222;}
.reader-field-option-group-label{font-size:10px;font-weight:600;color:#e2e8f0;margin-bottom:6px;}
.reader-expansion-pill{font-size:10px;text-transform:uppercase;letter-spacing:0.04em;padding:2px 8px;border-radius:999px;background:#3b1a5f;color:#f3e8ff;border:1px solid #7e22ce;}
`;

  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function titleCase(text) {
    return String(text || "")
      .toLowerCase()
      .replace(/\b[a-z]/g, (char) => char.toUpperCase());
  }

  function fieldTypeClass(type) {
    const normalized = String(type || "other").toLowerCase();
    if (["textbox", "text", "textarea", "searchbox", "email", "tel", "phone", "url"].includes(normalized)) return "text";
    if (["select", "combobox", "listbox", "dropdown"].includes(normalized)) return "select";
    if (["radio", "radiogroup"].includes(normalized)) return "radio";
    if (["checkbox", "switch"].includes(normalized)) return "checkbox";
    if (["file", "upload"].includes(normalized)) return "file";
    if (["number", "spinbutton", "slider"].includes(normalized)) return "number";
    if (["date", "month", "year"].includes(normalized)) return "date";
    return "other";
  }

  function fieldTextForGrouping(field) {
    return [
      field?.sectionPath,
      field?.section_path,
      field?.field_label,
      field?.label,
      field?.name,
      field?.id,
      field?.automationId,
      field?.automation_id
    ].filter(Boolean).join(" ");
  }

  function classifyFieldGroup(field) {
    const text = fieldTextForGrouping(field).replace(/[_-]+/g, " ");
    const normalized = text.replace(/\s+/g, " ").trim();
    const row =
      /\b(?:row|entry|item)\s*(\d+)\b/i.exec(normalized)?.[1] ||
      /\b(?:work\s*experience|experience|employment|education|school|project|certification|website|social)\s*(\d+)\b/i.exec(normalized)?.[1] ||
      /\b(?:workExperience|education|project|certification|website)[_-]?(\d+)\b/i.exec(text)?.[1] ||
      "";
    let kind = "";
    let title = "";
    if (/\b(work\s*experience|professional\s*experience|employment\s*history|work\s*history|job\s*history|employer|company|job\s*title|position)\b/i.test(normalized)) {
      kind = "experience";
      title = "Experience";
    } else if (/\b(education|academic|school|university|college|degree|field\s*of\s*study|major|graduation)\b/i.test(normalized)) {
      kind = "education";
      title = "Education";
    } else if (/\b(projects?|portfolio)\b/i.test(normalized)) {
      kind = "project";
      title = "Project";
    } else if (/\b(certifications?|licenses?)\b/i.test(normalized)) {
      kind = "certification";
      title = "Certification";
    } else if (/\b(websites?|social|linkedin|github|portfolio\s*url|url)\b/i.test(normalized)) {
      kind = "website";
      title = "Website";
    }
    if (!kind) return null;
    const sectionMatch = new RegExp(`\\b(${kind === "experience" ? "(?:work\\s*)?experience|employment" : title}\\s*${row || "\\d*"})\\b`, "i").exec(normalized);
    const displayTitle = row ? `${title} ${row}` : titleCase(sectionMatch?.[1] || title);
    return { kind, title: displayTitle, key: `${kind}:${row || displayTitle.toLowerCase()}` };
  }

  function stripGroupPrefix(label, group) {
    if (!group) return label;
    const escapedTitle = group.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return String(label || "")
      .replace(new RegExp(`^\\s*${escapedTitle}\\s*[-:|>]*\\s*`, "i"), "")
      .replace(/^\s*(?:work\s*)?experience\s*\d+\s*[-:|>]*\s*/i, "")
      .replace(/^\s*education\s*\d+\s*[-:|>]*\s*/i, "")
      .trim() || label;
  }

  function fmtInt(n) {
    const v = Number(n || 0);
    return Number.isFinite(v) && v > 0 ? v.toLocaleString() : "";
  }

  function fmtMs(n) {
    const v = Number(n || 0);
    if (!Number.isFinite(v) || v <= 0) return "";
    return v >= 1000 ? (v / 1000).toFixed(v >= 10000 ? 1 : 2) + "s" : Math.round(v) + "ms";
  }

  function fieldOptionsHtml(f) {
    const groups = Array.isArray(f.optionGroups || f.option_groups)
      ? (f.optionGroups || f.option_groups)
        .map((group) => ({
          label: String(group?.label || group?.name || "").trim(),
          options: Array.isArray(group?.options) ? group.options.filter((x) => String(x || "").trim()) : []
        }))
        .filter((group) => group.label || group.options.length)
      : [];
    const groupedOptions = new Set(groups.flatMap((group) => group.options.map((opt) => String(opt))));
    const opts = Array.isArray(f.options)
      ? f.options.filter((x) => String(x || "").trim() && !groupedOptions.has(String(x)))
      : [];
    return (
      (groups.length
        ? '<div class="reader-field-block"><div class="reader-field-block-label">Grouped options</div>' +
          groups.map((group) =>
            '<div class="reader-field-option-group">' +
            (group.label ? '<div class="reader-field-option-group-label">' + escapeHtml(group.label) + "</div>" : "") +
            '<div class="reader-field-options">' +
            group.options.slice(0, 120).map((opt) => '<span class="reader-field-option-pill">' + escapeHtml(String(opt)) + "</span>").join("") +
            "</div></div>"
          ).join("") +
          "</div>"
        : "") +
      (opts.length
        ? '<div class="reader-field-block"><div class="reader-field-block-label">Options</div>' +
          '<div class="reader-field-options">' +
          opts.slice(0, 120).map((opt) => '<span class="reader-field-option-pill">' + escapeHtml(String(opt)) + "</span>").join("") +
          "</div></div>"
        : "")
    );
  }

  function renderSingleCardHtml(f, index = 0, total = 1, options = {}) {
    const group = options.group === undefined ? classifyFieldGroup(f) : options.group;
    const rawLabel = f.field_label || f.label || "(unnamed field)";
    const label = stripGroupPrefix(rawLabel, group);
    const type = f.field_type || f.type || "other";
    const typeClass = fieldTypeClass(type);
    const why = f.why != null ? String(f.why) : "";
    const needsExpansion = !!(f.needsExpansion || f.needs_expansion);
    const expansionReason = String(f.expansionReason || f.expansion_reason || "").trim();
    return (
      '<article class="reader-field-card reader-field-type-' + escapeHtml(typeClass) + (needsExpansion ? " reader-field-needs-expansion" : "") + '">' +
      (group && options.includeGroupMeta !== false
        ? '<div class="reader-field-group-meta reader-field-section-' + escapeHtml(group.kind) + '">' +
          '<span class="reader-field-group-title">' + escapeHtml(group.title) + "</span>" +
          '<span class="reader-field-group-pos">Field ' + (index + 1) + " / " + total + "</span>" +
          "</div>"
        : "") +
      '<div class="reader-field-head">' +
      '<span class="reader-field-idx">' + (index + 1) + ".</span>" +
      '<span class="reader-field-label">' + escapeHtml(label) + "</span>" +
      '<span class="reader-field-type reader-field-type-' + escapeHtml(typeClass) + '">' + escapeHtml(type) + "</span>" +
      (needsExpansion ? '<span class="reader-expansion-pill">Needs expansion</span>' : "") +
      "</div>" +
      (needsExpansion
        ? '<div class="reader-field-block"><div class="reader-field-block-label">Expansion needed</div>' +
          '<div class="reader-field-why">' + escapeHtml(expansionReason || "Options may only mount after opening this control.") + "</div></div>"
        : "") +
      fieldOptionsHtml(f) +
      (why.trim()
        ? '<div class="reader-field-block"><div class="reader-field-block-label">Why this value</div>' +
          '<div class="reader-field-why">' + escapeHtml(why) + "</div></div>"
        : "") +
      "</article>"
    );
  }

  /**
   * @param {HTMLElement} root
   * @param {{ ok?: boolean, error?: string, summary?: string, scan?: object }} scanView
   */
  function mount(root, scanView) {
    if (!root) return;
    root.innerHTML = "";
    root.classList.add("reader-fields-list");
    const style = document.createElement("style");
    style.textContent = CSS;
    root.appendChild(style);

    if (!scanView || scanView.ok === false) {
      const err = document.createElement("div");
      err.className = "wr-llm-error";
      err.textContent = JSON.stringify(scanView || { ok: false, error: "No result" }, null, 2);
      root.appendChild(err);
      return;
    }

    const scan = scanView.scan || {};
    const fields = Array.isArray(scan.domFields) ? scan.domFields : [];

    const title = document.createElement("h3");
    title.className = "reader-pane-title";
    title.textContent = scan.viewTitle || "Extracted Fields";
    root.appendChild(title);

    const stats = scan.stats || {};
    const timings = scan.timings || {};
    const tokenText = fmtInt(stats.total_tokens)
      ? `tokens ${fmtInt(stats.total_tokens)} (${fmtInt(stats.total_prompt_tokens || stats.prompt_tokens)} in / ${fmtInt(stats.total_completion_tokens || stats.completion_tokens)} out)`
      : (fmtInt(stats.total_est_tokens)
        ? `est. tokens ${fmtInt(stats.total_est_tokens)} (${fmtInt(stats.total_est_prompt_tokens || stats.est_prompt_tokens)} in / ${fmtInt(stats.total_est_response_tokens || stats.est_response_tokens)} out)`
        : "");
    const llmTime = fmtMs(stats.total_llm_call_ms || timings.llm_ms);
    const totalTime = fmtMs(timings.total_ms);
    if (tokenText || llmTime || totalTime) {
      const statBar = document.createElement("div");
      statBar.className = "reader-stats";
      for (const text of [tokenText, llmTime ? `LLM ${llmTime}` : "", totalTime ? `total ${totalTime}` : ""].filter(Boolean)) {
        const pill = document.createElement("span");
        pill.className = "reader-stat-pill";
        pill.textContent = text;
        statBar.appendChild(pill);
      }
      root.appendChild(statBar);
    }

    if (!fields.length) {
      const empty = document.createElement("p");
      empty.className = "reader-field-why";
      empty.style.color = "#9aa8d4";
      empty.textContent = "No field suggestions returned.";
      root.appendChild(empty);
      return;
    }

    function renderCard(f, i, group) {
      const rawLabel = f.field_label || f.label || "(unnamed field)";
      const label = stripGroupPrefix(rawLabel, group);
      const type = f.field_type || f.type || "other";
      const typeClass = fieldTypeClass(type);
      const why = f.why != null ? String(f.why) : "";
      const needsExpansion = !!(f.needsExpansion || f.needs_expansion);
      const expansionReason = String(f.expansionReason || f.expansion_reason || "").trim();
      const card = document.createElement("article");
      card.className = `reader-field-card reader-field-type-${typeClass}${needsExpansion ? " reader-field-needs-expansion" : ""}`;
      card.setAttribute("aria-label", `Field ${i + 1}: ${label}`);

      const groups = Array.isArray(f.optionGroups || f.option_groups)
        ? (f.optionGroups || f.option_groups)
          .map((group) => ({
            label: String(group?.label || group?.name || "").trim(),
            options: Array.isArray(group?.options) ? group.options.filter((x) => String(x || "").trim()) : []
          }))
          .filter((group) => group.label || group.options.length)
        : [];
      const groupedOptions = new Set(groups.flatMap((group) => group.options.map((opt) => String(opt))));
      const opts = Array.isArray(f.options)
        ? f.options.filter((x) => String(x || "").trim() && !groupedOptions.has(String(x)))
        : [];
      card.innerHTML =
        '<div class="reader-field-head">' +
        '<span class="reader-field-idx">' + (i + 1) + ".</span>" +
        '<span class="reader-field-label">' + escapeHtml(label) + "</span>" +
        '<span class="reader-field-type reader-field-type-' + escapeHtml(typeClass) + '">' + escapeHtml(type) + "</span>" +
        (needsExpansion ? '<span class="reader-expansion-pill">Needs expansion</span>' : "") +
        "</div>" +
        (needsExpansion
          ? '<div class="reader-field-block"><div class="reader-field-block-label">Expansion needed</div>' +
            '<div class="reader-field-why">' + escapeHtml(expansionReason || "Options may only mount after opening this control.") + "</div></div>"
          : "") +
        (groups.length
          ? '<div class="reader-field-block"><div class="reader-field-block-label">Grouped options</div>' +
            groups.map((group) =>
              '<div class="reader-field-option-group">' +
              (group.label ? '<div class="reader-field-option-group-label">' + escapeHtml(group.label) + "</div>" : "") +
              '<div class="reader-field-options">' +
              group.options.slice(0, 120).map((opt) => '<span class="reader-field-option-pill">' + escapeHtml(String(opt)) + "</span>").join("") +
              "</div></div>"
            ).join("") +
            "</div>"
          : "") +
        (opts.length
          ? '<div class="reader-field-block"><div class="reader-field-block-label">Options</div>' +
            '<div class="reader-field-options">' +
            opts.slice(0, 120).map((opt) => '<span class="reader-field-option-pill">' + escapeHtml(String(opt)) + "</span>").join("") +
            "</div></div>"
          : "") +
        (why.trim()
          ? '<div class="reader-field-block"><div class="reader-field-block-label">Why this value</div>' +
            '<div class="reader-field-why">' + escapeHtml(why) + "</div></div>"
          : "");

      return card;
    }

    const grouped = [];
    const groupByKey = new Map();
    fields.forEach((field, index) => {
      const group = classifyFieldGroup(field);
      if (!group) {
        grouped.push({ type: "field", field, index });
        return;
      }
      let bucket = groupByKey.get(group.key);
      if (!bucket) {
        bucket = { type: "group", group, items: [] };
        groupByKey.set(group.key, bucket);
        grouped.push(bucket);
      }
      bucket.items.push({ field, index });
    });

    grouped.forEach((entry) => {
      if (entry.type === "field") {
        root.appendChild(renderCard(entry.field, entry.index, null));
        return;
      }
      const section = document.createElement("section");
      section.className = `reader-field-section reader-field-section-${entry.group.kind}`;
      section.innerHTML =
        '<div class="reader-field-section-head">' +
        '<div class="reader-field-section-title">' + escapeHtml(entry.group.title) + "</div>" +
        '<div class="reader-field-section-count">' + entry.items.length + " field" + (entry.items.length === 1 ? "" : "s") + "</div>" +
        "</div>";
      entry.items.forEach((item) => section.appendChild(renderCard(item.field, item.index, entry.group)));
      root.appendChild(section);
    });
  }

  const api = { mount, classifyFieldGroup, renderSingleCardHtml };
  g.ExtractedFieldCardsView = api;
  // Backward compatibility for existing callers.
  g.WebsiteReaderLlmView = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
