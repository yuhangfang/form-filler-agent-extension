const {
  getBrowserSnapshotText,
  getDomOutline,
  getLlmInputEntries,
  getParsedFieldScan,
  getSnapshotScanView
} = globalThis.ScanResultAdapters;

const targetTabEl = document.getElementById("targetTab");
const refreshTabsBtn = document.getElementById("refreshTabs");
const runBtn = document.getElementById("runExperiment");
const outputTabsEl = document.getElementById("outputTabs");
const statusEl = document.getElementById("status");
const frameSummaryEl = document.getElementById("frameSummary");
const snapshotParserOutputEl = document.getElementById("snapshotParserOutput");
const pageScreenshotOutputEl = document.getElementById("pageScreenshotOutput");
const runChunkedLlmBtn = document.getElementById("runChunkedLlm");
const chunkedLlmScanOutputEl = document.getElementById("chunkedLlmScanOutput");
const playwrightSnapshotEl = document.getElementById("playwrightSnapshot");
const domOutlineEl = document.getElementById("domOutline");
const runDiagnoseRoundBtn = document.getElementById("runDiagnoseRound");
const diagnoseContextOutputEl = document.getElementById("diagnoseContextOutput");
const diagnoseScreenshotOutputEl = document.getElementById("diagnoseScreenshotOutput");
const diagnoseChatLogEl = document.getElementById("diagnoseChatLog");
const diagnoseChatInputEl = document.getElementById("diagnoseChatInput");
const sendDiagnoseChatBtn = document.getElementById("sendDiagnoseChat");
const clearDiagnoseChatBtn = document.getElementById("clearDiagnoseChat");
const ctxScreenshotEl = document.getElementById("ctxScreenshot");
const ctxFieldsEl = document.getElementById("ctxFields");
const ctxSnapshotEl = document.getElementById("ctxSnapshot");
const ctxDomOutlineEl = document.getElementById("ctxDomOutline");
const diagnoseStep1OutputEl = document.getElementById("diagnoseStep1Output");
const diagnoseStep2TabsEl = document.getElementById("diagnoseStep2Tabs");
const diagnoseStep2OutputEl = document.getElementById("diagnoseStep2Output");
let currentReport = null;
let diagnoseState = {
  screenshotDataUrl: "",
  screenshotMeta: null,
  extractedFields: [],
  chatHistory: [],
  lastSourceSearchResults: null,
  step2Results: {}
};

init();

async function init() {
  await refreshTargetTabs();
  initOutputTabs();
  initDiagnoseInnerTabs();
  activateOutputTab("fieldScanTab");
}

refreshTabsBtn?.addEventListener("click", async () => {
  await refreshTargetTabs();
});

runBtn.addEventListener("click", async () => {
  runBtn.disabled = true;
  statusEl.textContent = "Running experiment...";
  clearOutput();
  try {
    const tabId = Number(targetTabEl?.value || 0);
    if (!tabId) throw new Error("Select a target tab first.");
    const report = await runOneShotExperiment({ tabId });
    renderReport(report);
    activateOutputTab("fieldScanTab");
    document.getElementById("fieldScanTab")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    statusEl.textContent = "Done.";
  } catch (err) {
    statusEl.textContent = err instanceof Error ? err.message : String(err);
  } finally {
    runBtn.disabled = false;
  }
});

runChunkedLlmBtn?.addEventListener("click", async () => {
  if (!currentReport?.meta?.tabId) return;
  runChunkedLlmBtn.disabled = true;
  runChunkedLlmBtn.textContent = "Running...";
  statusEl.textContent = "Running chunked LLM extraction...";
  renderChunkedPlaceholder("Running chunked LLM extraction...");
  try {
    const scan = ensureCurrentReportScan();
    const snapshot = {
      url: scan?.url || currentReport.meta.tabUrl || "",
      requested_url: scan?.requested_url || currentReport.meta.tabUrl || "",
      title: scan?.title || "",
      domOutline: scan?.domOutline || scan?.dom_outline || "",
      snapshot_text: scan?.snapshot_text || "",
      snapshot_source: scan?.snapshot_source || ""
    };
    if (!snapshot.snapshot_text) throw new Error("No snapshot available. Run experiment first.");
    const chunked = await chrome.runtime.sendMessage({
      type: "SNAPSHOT_PARSE_LLM",
      payload: {
        mode: "chunked",
        snapshot
      }
    });
    scan.chunkedLlmScan = chunked?.scan || {
      ok: false,
      error: chunked?.error || "Chunked LLM extraction failed."
    };
    renderReport(currentReport);
    statusEl.textContent = chunked?.ok ? "Chunked LLM extraction done." : (chunked?.error || "Chunked LLM extraction failed.");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const scan = ensureCurrentReportScan();
    scan.chunkedLlmScan = { ok: false, error: message };
    renderReport(currentReport);
    statusEl.textContent = message;
  } finally {
    runChunkedLlmBtn.disabled = !currentReport?.meta?.tabId;
    runChunkedLlmBtn.textContent = "Run Chunked LLM";
  }
});

diagnoseChatInputEl?.addEventListener("input", () => {
  updateSendDiagnoseChatButton();
});

sendDiagnoseChatBtn?.addEventListener("click", async () => {
  const message = String(diagnoseChatInputEl?.value || "").trim();
  if (!message) return;
  diagnoseChatInputEl.value = "";
  if (sendDiagnoseChatBtn) sendDiagnoseChatBtn.disabled = true;
  await sendChatMessage(message);
});

diagnoseChatInputEl?.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.shiftKey) return;
  const message = String(diagnoseChatInputEl?.value || "").trim();
  if (!message || sendDiagnoseChatBtn?.disabled) return;
  event.preventDefault();
  diagnoseChatInputEl.value = "";
  if (sendDiagnoseChatBtn) sendDiagnoseChatBtn.disabled = true;
  void sendChatMessage(message);
});

clearDiagnoseChatBtn?.addEventListener("click", () => {
  diagnoseState.chatHistory = [];
  renderDiagnoseChatLog();
});

function clearOutput() {
  currentReport = null;
  frameSummaryEl.textContent = "";
  domOutlineEl.textContent = "";
  playwrightSnapshotEl.textContent = "";
  snapshotParserOutputEl.innerHTML = "";
  pageScreenshotOutputEl.innerHTML = "";
  chunkedLlmScanOutputEl.innerHTML = "";
  if (runChunkedLlmBtn) {
    runChunkedLlmBtn.disabled = true;
    runChunkedLlmBtn.textContent = "Run Chunked LLM";
  }
  if (runDiagnoseRoundBtn) runDiagnoseRoundBtn.disabled = true;
  if (sendDiagnoseChatBtn) sendDiagnoseChatBtn.disabled = true;
  diagnoseState = { screenshotDataUrl: "", screenshotMeta: null, extractedFields: [], chatHistory: [], lastSourceSearchResults: null, step2Results: {} };
  renderStep2ContextChips();
  if (diagnoseContextOutputEl) diagnoseContextOutputEl.textContent = "";
  if (diagnoseScreenshotOutputEl) diagnoseScreenshotOutputEl.innerHTML = "";
  if (diagnoseChatInputEl) diagnoseChatInputEl.value = "";
  renderDiagnoseChatLog();
  renderDiagnoseStep1(null);
  renderDiagnoseStep2(null);
}

function updateSendDiagnoseChatButton(forceDisabled = false) {
  if (!sendDiagnoseChatBtn) return;
  const hasMessage = !!String(diagnoseChatInputEl?.value || "").trim();
  sendDiagnoseChatBtn.disabled = forceDisabled || !currentReport?.meta?.tabId || !hasMessage;
}

function renderReport(report) {
  currentReport = report;
  const domScan = report?.domScan || {};
  const scan = domScan?.scan || {};
  if (runChunkedLlmBtn) runChunkedLlmBtn.disabled = !report?.meta?.tabId || !domScan?.ok;
  frameSummaryEl.textContent = JSON.stringify(
    {
      url: scan.url || "",
      title: scan.title || "",
      snapshotSource: scan.snapshot_source || "",
      domOutlineChars: getDomOutline(domScan).length,
      browserSnapshotChars: getBrowserSnapshotText(domScan).length,
      llmInputCount: getLlmInputEntries(domScan).length,
      screenshot: summarizeScreenshot(report?.pageScreenshot),
      snapshotParserExtractedFieldCount: Array.isArray(getParsedFieldScan(domScan)?.domFields)
        ? getParsedFieldScan(domScan).domFields.length
        : 0,
      extractedFieldCount: Array.isArray(scan.domFields)
        ? scan.domFields.length
        : (Array.isArray(getParsedFieldScan(domScan)?.domFields) ? getParsedFieldScan(domScan).domFields.length : 0),
      chunkedExtractedFieldCount: Array.isArray(scan.chunkedLlmScan?.fields) ? scan.chunkedLlmScan.fields.length : 0,
      chunkCount: Array.isArray(scan.chunkedLlmScan?.chunks) ? scan.chunkedLlmScan.chunks.length : 0,
      timings: scan.timings || {},
      stats: scan.stats || {}
    },
    null,
    2
  );

  domOutlineEl.textContent = getDomOutline(domScan);
  playwrightSnapshotEl.textContent = getBrowserSnapshotText(domScan);
  const snapshotScan = getSnapshotScanView(domScan);
  const cardsView = globalThis.ExtractedFieldCardsView || globalThis.WebsiteReaderLlmView;
  if (typeof cardsView?.mount === "function") {
    cardsView.mount(snapshotParserOutputEl, snapshotScan);
  } else {
    snapshotParserOutputEl.textContent = JSON.stringify(snapshotScan || {}, null, 2);
  }
  renderPageScreenshot(report?.pageScreenshot);
  renderChunkedScan(domScan);
  seedDiagnoseStateFromReport(report);
}

function seedDiagnoseStateFromReport(report) {
  const pageScreenshot = report?.pageScreenshot;
  const domScan = report?.domScan || {};
  const parsed = getParsedFieldScan(domScan);
  diagnoseState.screenshotDataUrl = pageScreenshot?.ok && pageScreenshot?.dataUrl ? pageScreenshot.dataUrl : "";
  diagnoseState.screenshotMeta = summarizeScreenshot(pageScreenshot);
  diagnoseState.extractedFields = Array.isArray(parsed?.domFields)
    ? parsed.domFields
    : [];
  if (runDiagnoseRoundBtn) runDiagnoseRoundBtn.disabled = !report?.meta?.tabId || !diagnoseState.screenshotDataUrl || !diagnoseState.extractedFields.length;
  updateSendDiagnoseChatButton();
  renderDiagnoseExtractedFieldsContext();
  renderDiagnoseScreenshot();
  renderDiagnoseChatLog();
  renderDiagnoseStep1(null);
  renderDiagnoseStep2(null);
}

function getChunkedLlmScan(domScan) {
  const chunked = domScan?.scan?.chunkedLlmScan || domScan?.scan?.chunked_llm_scan || null;
  if (!chunked) return null;
  return { ok: !!chunked.ok, error: chunked.error || "", scan: chunked };
}

function summarizeScreenshot(pageScreenshot) {
  if (!pageScreenshot) return { ok: false, error: "not captured" };
  if (!pageScreenshot.ok) return { ok: false, error: pageScreenshot.error || "capture failed" };
  return {
    ok: true,
    fullPage: !!pageScreenshot.fullPage,
    width: pageScreenshot.width || null,
    height: pageScreenshot.height || null,
    format: pageScreenshot.format || "png"
  };
}

function renderPageScreenshot(pageScreenshot) {
  pageScreenshotOutputEl.innerHTML = "";
  if (!pageScreenshot?.ok || !pageScreenshot.dataUrl) {
    const error = document.createElement("div");
    error.className = "screenshot-error";
    error.textContent = pageScreenshot?.error || "Screenshot capture failed.";
    pageScreenshotOutputEl.appendChild(error);
    return;
  }

  const meta = document.createElement("div");
  meta.className = "screenshot-meta";
  const size = pageScreenshot.width && pageScreenshot.height
    ? `${Math.round(pageScreenshot.width)} x ${Math.round(pageScreenshot.height)}`
    : "unknown size";
  meta.textContent = `${pageScreenshot.fullPage ? "Full page" : "Visible viewport"} screenshot, ${size}`;

  const img = document.createElement("img");
  img.className = "page-screenshot";
  img.alt = "Captured webpage screenshot";
  img.src = pageScreenshot.dataUrl;

  pageScreenshotOutputEl.appendChild(meta);
  pageScreenshotOutputEl.appendChild(img);
}

function renderDiagnoseScreenshot() {
  if (!diagnoseScreenshotOutputEl) return;
  diagnoseScreenshotOutputEl.innerHTML = "";
  if (!diagnoseState.screenshotDataUrl) {
    const err = document.createElement("div");
    err.className = "screenshot-error";
    err.textContent = "No screenshot available. Run the experiment first.";
    diagnoseScreenshotOutputEl.appendChild(err);
    return;
  }
  const meta = document.createElement("div");
  meta.className = "screenshot-meta";
  const summary = diagnoseState.screenshotMeta || {};
  const size = summary.width && summary.height ? `${summary.width} x ${summary.height}` : "unknown size";
  meta.textContent = `${summary.fullPage ? "Full page" : "Viewport"} screenshot, ${size}`;
  const img = document.createElement("img");
  img.className = "page-screenshot";
  img.alt = "Diagnose screenshot";
  img.src = diagnoseState.screenshotDataUrl;
  diagnoseScreenshotOutputEl.appendChild(meta);
  diagnoseScreenshotOutputEl.appendChild(img);
}

function renderDiagnoseContext(text) {
  if (!diagnoseContextOutputEl) return;
  diagnoseContextOutputEl.textContent = String(text || "");
}

function renderDiagnoseChatLog() {
  if (!diagnoseChatLogEl) return;
  diagnoseChatLogEl.innerHTML = "";
  const messages = diagnoseState.chatHistory.filter(item => item.role === "user" || item.role === "assistant");
  if (!messages.length) {
    return;
  }
  for (const item of messages) {
    const wrap = document.createElement("div");
    wrap.className = item.role === "assistant" ? "diagnose-chat-item diagnose-chat-assistant" : "diagnose-chat-item";
    const role = document.createElement("strong");
    role.textContent = item.role === "assistant" ? "Assistant" : "You";
    const content = document.createElement("div");
    content.textContent = String(item.content || "");
    wrap.appendChild(role);
    wrap.appendChild(content);
    diagnoseChatLogEl.appendChild(wrap);
  }
  diagnoseChatLogEl.scrollTop = diagnoseChatLogEl.scrollHeight;
}

function renderStep2ContextChips() {
  const container = document.getElementById("ctxStep2Fields");
  if (!container) return;
  container.innerHTML = "";
  const fields = Object.keys(diagnoseState.step2Results || {});
  if (!fields.length) return;
  const label = document.createElement("span");
  label.className = "ctx-chips-label";
  label.textContent = "Step 2:";
  container.appendChild(label);
  for (const field of fields) {
    const lbl = document.createElement("label");
    lbl.className = "ctx-chip";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = true;
    cb.value = field;
    lbl.appendChild(cb);
    lbl.append(" " + field);
    container.appendChild(lbl);
  }
}

function renderDiagnoseStep2(text) {
  if (!diagnoseStep2OutputEl) return;
  if (diagnoseStep2TabsEl) diagnoseStep2TabsEl.innerHTML = "";
  diagnoseStep2OutputEl.innerHTML = "";
  const p = document.createElement("p");
  p.className = "chunked-placeholder";
  p.textContent = text || "Code gap analysis runs here after Step 1 finds missing fields.";
  diagnoseStep2OutputEl.appendChild(p);
}

function appendStep2FieldCard(fieldResult) {
  // Remove placeholder on first card
  diagnoseStep2OutputEl.querySelector(".chunked-placeholder")?.remove();

  // Tab button
  const tabBtn = document.createElement("button");
  tabBtn.type = "button";
  tabBtn.className = "step2-tab";
  tabBtn.textContent = fieldResult.field;
  diagnoseStep2TabsEl.appendChild(tabBtn);

  // Panel
  const panel = document.createElement("div");
  panel.className = "step2-panel";

  const nameEl = document.createElement("div");
  nameEl.className = "step2-field-name";
  nameEl.textContent = `"${fieldResult.field}"`;
  panel.appendChild(nameEl);

  // Source evidence
  const evidenceSection = document.createElement("div");
  evidenceSection.className = "step2-section";
  const evidenceLabel = document.createElement("div");
  evidenceLabel.className = "step2-section-label";
  evidenceLabel.textContent = "Source Evidence";
  evidenceSection.appendChild(evidenceLabel);
  for (const [key, label] of [["domOutline", "DOM Outline"], ["snapshot", "Browser Snapshot (ARIA/YAML)"]]) {
    const hit = fieldResult[key];
    if (!hit) continue;
    const row = document.createElement("div");
    row.className = "step2-source-row";
    const badge = document.createElement("span");
    badge.className = hit.found ? "source-search-found" : "source-search-missing";
    badge.textContent = hit.found ? `✓ ${label}` : `✗ ${label}`;
    row.appendChild(badge);
    if (hit.found && hit.matchType === "partial") {
      const note = document.createElement("span");
      note.className = "source-search-match-type";
      note.textContent = " (partial match)";
      row.appendChild(note);
    }
    if (hit.snippet) {
      const snippet = document.createElement("pre");
      snippet.className = "step2-source-snippet";
      snippet.textContent = hit.snippet;
      row.appendChild(snippet);
    }
    evidenceSection.appendChild(row);
  }
  panel.appendChild(evidenceSection);

  // Coding agent brief (loading)
  const briefSection = document.createElement("div");
  briefSection.className = "step2-section";
  const briefLabel = document.createElement("div");
  briefLabel.className = "step2-section-label";
  briefLabel.textContent = "Coding Agent Brief";
  briefSection.appendChild(briefLabel);
  const body = document.createElement("div");
  body.className = "step2-analysis step2-analyzing";
  body.textContent = "Analyzing…";
  briefSection.appendChild(body);
  panel.appendChild(briefSection);

  diagnoseStep2OutputEl.appendChild(panel);

  tabBtn.addEventListener("click", () => {
    for (const b of diagnoseStep2TabsEl.querySelectorAll(".step2-tab")) b.classList.toggle("is-active", b === tabBtn);
    for (const p of diagnoseStep2OutputEl.querySelectorAll(".step2-panel")) p.classList.toggle("is-active", p === panel);
  });

  const isFirst = diagnoseStep2TabsEl.querySelectorAll(".step2-tab").length === 1;
  if (isFirst) {
    tabBtn.classList.add("is-active");
    panel.classList.add("is-active");
  }

  return panel;
}

function updateStep2FieldCard(card, reportText, error) {
  const body = card.querySelector(".step2-analysis");
  if (!body) return;
  body.classList.remove("step2-analyzing");
  if (error) {
    body.classList.add("step2-error");
    body.textContent = `Error: ${error}`;
    return;
  }
  body.innerHTML = "";
  const text = String(reportText || "");
  for (const line of text.split("\n")) {
    const trimmed = line.trimStart();
    const lineEl = document.createElement("div");
    if (/^#{1,3}\s/.test(trimmed)) {
      lineEl.className = "step2-line-heading";
      lineEl.textContent = trimmed.replace(/^#{1,3}\s/, "");
    } else if (/^[-*]\s/.test(trimmed)) {
      lineEl.className = "step2-line-bullet";
      lineEl.textContent = trimmed.replace(/^[-*]\s/, "");
    } else if (trimmed === "") {
      lineEl.className = "step2-line-gap";
    } else {
      lineEl.className = "step2-line-body";
      lineEl.textContent = line;
    }
    body.appendChild(lineEl);
  }
}

async function runDiagnoseStep2() {
  const fields = diagnoseState.lastSourceSearchResults;
  if (!fields?.length) {
    statusEl.textContent = "Run Step 1 (Diagnose Round) first to prepare code gap analysis.";
    return;
  }
  if (diagnoseStep2TabsEl) diagnoseStep2TabsEl.innerHTML = "";
  if (diagnoseStep2OutputEl) diagnoseStep2OutputEl.innerHTML = "";
  diagnoseState.step2Results = {};
  renderStep2ContextChips();
  let hasError = false;
  for (let i = 0; i < fields.length; i++) {
    const fieldResult = fields[i];
    statusEl.textContent = `Step 2: field ${i + 1} of ${fields.length} — "${fieldResult.field}"…`;
    const card = appendStep2FieldCard(fieldResult);
    try {
      const response = await chrome.runtime.sendMessage({
        type: "EXPERIMENT_RUNNER_DIAGNOSE_STEP2",
        payload: { sourceSearchResults: [fieldResult] }
      });
      if (!response?.ok) throw new Error(response?.error || "Step 2 failed.");
      updateStep2FieldCard(card, response.reportText, null);
      diagnoseState.step2Results[fieldResult.field] = {
        field: fieldResult.field,
        snapshot: fieldResult.snapshot || null,
        domOutline: fieldResult.domOutline || null,
        codingAgentBrief: String(response.reportText || "")
      };
      renderStep2ContextChips();
    } catch (err) {
      updateStep2FieldCard(card, null, err instanceof Error ? err.message : String(err));
      hasError = true;
    }
  }
  statusEl.textContent = hasError ? "Step 2 complete (with errors)." : "Step 2 complete.";
}

function renderDiagnoseStep1Loading() {
  if (!diagnoseStep1OutputEl) return;
  diagnoseStep1OutputEl.innerHTML = "";
  const p = document.createElement("p");
  p.className = "step1-status-waiting";
  p.textContent = "Comparing the screenshot to extracted fields…";
  diagnoseStep1OutputEl.appendChild(p);
}

function renderDiagnoseStep1Error(message) {
  if (!diagnoseStep1OutputEl) return;
  diagnoseStep1OutputEl.innerHTML = "";
  const p = document.createElement("p");
  p.className = "step1-status-error";
  p.textContent = String(message || "Diagnose round failed.").trim();
  diagnoseStep1OutputEl.appendChild(p);
}

function renderDiagnoseStep1(diagnosis) {
  if (!diagnoseStep1OutputEl) return;
  diagnoseStep1OutputEl.innerHTML = "";
  if (!diagnosis) {
    const p = document.createElement("p");
    p.className = "chunked-placeholder";
    p.textContent = "Run Diagnose Round to see results here.";
    diagnoseStep1OutputEl.appendChild(p);
    return;
  }
  const missingFields = Array.isArray(diagnosis.missingFields) ? diagnosis.missingFields.filter(Boolean) : [];
  if (!missingFields.length) {
    const p = document.createElement("p");
    p.className = "source-search-none";
    p.textContent = "No missing fields — all visible fields were extracted.";
    diagnoseStep1OutputEl.appendChild(p);
    return;
  }
  for (const field of missingFields) {
    const card = document.createElement("div");
    card.className = "step1-field-card";
    const label = document.createElement("div");
    label.className = "step1-field-label";
    label.textContent = String(field).trim();
    card.appendChild(label);
    diagnoseStep1OutputEl.appendChild(card);
  }
}

/** Same shape as vision step-1 user text in `diagnoseFieldsAgainstScreenshot` (pre-LLM input, not model output). */
function formatVisionStep1UserText(extractedFields) {
  const list = Array.isArray(extractedFields) ? extractedFields.slice(0, 200) : [];
  const compact = list
    .map((field) => {
      const label = String(field?.label || field?.field_label || field?.name || "").trim().slice(0, 180);
      const type = String(field?.type || field?.field_type || "unknown").trim().slice(0, 60) || "unknown";
      if (!label) return "";
      return `${label} (${type})`;
    })
    .filter(Boolean);
  return compact.length
    ? `Extracted fields (label (type)):\n${compact.map((x) => `- ${x}`).join("\n")}`
    : "Extracted fields: (none)";
}

function renderDiagnoseExtractedFieldsContext() {
  renderDiagnoseContext(formatVisionStep1UserText(diagnoseState.extractedFields));
}

async function runDiagnoseRound() {
  const tabId = Number(currentReport?.meta?.tabId || 0);
  const tabUrl = String(currentReport?.meta?.tabUrl || "");
  if (!tabId || !tabUrl) {
    statusEl.textContent = "Run experiment first to prepare diagnose inputs.";
    return;
  }
  if (!diagnoseState.screenshotDataUrl || !diagnoseState.extractedFields.length) {
    statusEl.textContent = "Missing diagnose inputs. Re-run experiment.";
    return;
  }
  if (runDiagnoseRoundBtn) {
    runDiagnoseRoundBtn.disabled = true;
    runDiagnoseRoundBtn.textContent = "Diagnosing...";
  }
  updateSendDiagnoseChatButton(true);
  statusEl.textContent = "Step 1: running vision diagnosis…";
  renderDiagnoseStep1Loading();
  try {
    const domScan = currentReport?.domScan || {};
    const response = await chrome.runtime.sendMessage({
      type: "EXPERIMENT_RUNNER_DIAGNOSE_ROUND",
      payload: {
        tabId,
        tabUrl,
        screenshotDataUrl: diagnoseState.screenshotDataUrl,
        extractedFields: diagnoseState.extractedFields,
        snapshotText: getBrowserSnapshotText(domScan),
        domOutline: getDomOutline(domScan)
      }
    });
    if (!response?.ok) {
      throw new Error(response?.error || "Diagnose round failed.");
    }
    renderDiagnoseContext(response.sourceContext || formatVisionStep1UserText(diagnoseState.extractedFields));
    renderDiagnoseStep1(response.diagnosis || null);
    diagnoseState.lastSourceSearchResults = Array.isArray(response.sourceSearchResults) ? response.sourceSearchResults : null;
    if (diagnoseState.lastSourceSearchResults?.length) {
      statusEl.textContent = "Step 1 complete. Running Step 2…";
      await runDiagnoseStep2();
    } else {
      renderDiagnoseStep2(null);
      statusEl.textContent = "Step 1 complete.";
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    statusEl.textContent = msg;
    renderDiagnoseStep1Error(msg);
  } finally {
    if (runDiagnoseRoundBtn) {
      runDiagnoseRoundBtn.disabled = !tabId;
      runDiagnoseRoundBtn.textContent = "Run Diagnose Round";
    }
    updateSendDiagnoseChatButton();
  }
}

function collectSelectedStep2Briefs() {
  return Array.from(document.querySelectorAll('#ctxStep2Fields input[type="checkbox"]:checked'))
    .map((cb) => formatStep2ContextBrief(diagnoseState.step2Results[cb.value]))
    .filter(Boolean)
    .join("\n\n---\n\n");
}

function formatStep2ContextBrief(result) {
  if (!result) return "";
  if (typeof result === "string") return result;
  const fieldKey = String(result.field || "").trim();
  const snapshotSnippet = String(result.snapshot?.snippet || "").trim();
  const domSnippet = String(result.domOutline?.snippet || "").trim();
  const codingAgentBrief = String(result.codingAgentBrief || "").trim();
  const lines = [
    fieldKey ? `Field key: ${fieldKey}` : "",
    "Snapshot snippet:",
    snapshotSnippet || "(not found)",
    "",
    "DOM snippet:",
    domSnippet || "(not found)",
    "",
    "Coding Agent Brief:",
    codingAgentBrief || "(not available)"
  ];
  return lines.filter((line, index) => line || lines[index - 1] !== "").join("\n").trim();
}

async function sendChatMessage(userMessage) {
  if (!userMessage) return;
  diagnoseState.chatHistory.push({ role: "user", content: userMessage });
  renderDiagnoseChatLog();
  updateSendDiagnoseChatButton(true);
  statusEl.textContent = "Thinking...";
  try {
    const domScan = currentReport?.domScan || {};
    const response = await chrome.runtime.sendMessage({
      type: "EXPERIMENT_RUNNER_DIAGNOSE_CHAT",
      payload: {
        screenshotDataUrl: ctxScreenshotEl?.checked === true ? diagnoseState.screenshotDataUrl : "",
        extractedFields: ctxFieldsEl?.checked === true ? diagnoseState.extractedFields : [],
        snapshotText: ctxSnapshotEl?.checked === true ? getBrowserSnapshotText(domScan) : "",
        domOutline: ctxDomOutlineEl?.checked === true ? getDomOutline(domScan) : "",
        step2Briefs: collectSelectedStep2Briefs(),
        userMessage,
        chatHistory: diagnoseState.chatHistory.slice(0, -1)
      }
    });
    if (!response?.ok) throw new Error(response?.error || "Chat failed.");
    const assistantText = String(response.responseText || "No response");
    diagnoseState.chatHistory.push({ role: "assistant", content: assistantText });
    renderDiagnoseChatLog();
    statusEl.textContent = "";
  } catch (err) {
    statusEl.textContent = err instanceof Error ? err.message : String(err);
  } finally {
    updateSendDiagnoseChatButton();
  }
}

function renderChunkedScan(domScan) {
  const chunkedScan = getChunkedLlmScan(domScan);
  if (!chunkedScan) {
    renderChunkedPlaceholder("Chunked LLM extraction is skipped by default. Click Run Chunked LLM to run it.");
    return;
  }
  const cardsView = globalThis.ExtractedFieldCardsView || globalThis.WebsiteReaderLlmView;
  if (typeof cardsView?.mount === "function") {
    cardsView.mount(chunkedLlmScanOutputEl, chunkedScan);
  } else {
    chunkedLlmScanOutputEl.textContent = JSON.stringify(chunkedScan || {}, null, 2);
  }
}

function renderChunkedPlaceholder(text) {
  chunkedLlmScanOutputEl.innerHTML = "";
  const placeholder = document.createElement("p");
  placeholder.className = "chunked-placeholder";
  placeholder.textContent = text;
  chunkedLlmScanOutputEl.appendChild(placeholder);
}

function ensureCurrentReportScan() {
  if (!currentReport) currentReport = { meta: {}, domScan: { ok: true, scan: {} } };
  if (!currentReport.domScan) currentReport.domScan = { ok: true, scan: {} };
  if (!currentReport.domScan.scan) currentReport.domScan.scan = {};
  return currentReport.domScan.scan;
}

async function runOneShotExperiment({ tabId }) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab?.id || !tab.url) throw new Error("Selected tab is not available.");
  const captured = await chrome.runtime.sendMessage({
    type: "SNAPSHOT_CAPTURE",
    payload: {
      tabId: tab.id,
      tabUrl: tab.url
    }
  });
  if (!captured?.ok) throw new Error(captured?.error || "Snapshot capture failed.");
  const [domScan, pageScreenshot] = await Promise.all([
    chrome.runtime.sendMessage({
      type: "SNAPSHOT_PARSE_RULES",
      payload: { snapshot: captured.snapshot || {} }
    }),
    chrome.runtime.sendMessage({
      type: "BROWSER_MCP",
      tool: "browser_take_screenshot",
      tabId: tab.id,
      payload: {
        type: "png",
        fullPage: true
      }
    })
  ]);

  return {
    meta: {
      tabId: tab.id,
      tabUrl: tab.url,
      generatedAt: new Date().toISOString()
    },
    pageScreenshot,
    domScan
  };
}

async function refreshTargetTabs() {
  const extensionPrefix = `chrome-extension://${chrome.runtime.id}/`;
  const [current] = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabs = await chrome.tabs.query({ currentWindow: true });

  const candidates = tabs
    .filter((t) => t.id && t.id !== current?.id)
    .filter((t) => typeof t.url === "string" && !t.url.startsWith(extensionPrefix))
    .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));

  targetTabEl.innerHTML = "";
  for (const t of candidates) {
    const opt = document.createElement("option");
    opt.value = String(t.id);
    const title = (t.title || "(untitled)").slice(0, 90);
    const host = safeHost(t.url || "");
    opt.textContent = `${title}  [${host}]`;
    targetTabEl.appendChild(opt);
  }

  if (!candidates.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "No eligible tab found in current window";
    targetTabEl.appendChild(opt);
  }
}

function safeHost(url) {
  try {
    return new URL(url).hostname || url;
  } catch {
    return url || "unknown";
  }
}

function initDiagnoseInnerTabs() {
  const tabs = Array.from(document.querySelectorAll(".diagnose-inner-tab"));
  const panels = Array.from(document.querySelectorAll(".diagnose-inner-panel"));
  for (const btn of tabs) {
    btn.addEventListener("click", () => {
      const target = btn.getAttribute("data-dtab");
      for (const b of tabs) b.classList.toggle("is-active", b === btn);
      for (const p of panels) p.classList.toggle("is-active", p.id === target);
    });
  }
}

function initOutputTabs() {
  if (!outputTabsEl) return;
  const buttons = Array.from(outputTabsEl.querySelectorAll(".tab-button"));
  const panels = Array.from(document.querySelectorAll(".tab-panel"));
  for (const btn of buttons) {
    btn.addEventListener("click", () => {
      const target = btn.getAttribute("data-tab");
      for (const b of buttons) b.classList.toggle("is-active", b === btn);
      for (const p of panels) p.classList.toggle("is-active", p.id === target);
      if (target === "diagnoseTab") {
        renderDiagnoseExtractedFieldsContext();
        runDiagnoseRound();
      }
    });
  }
}

function activateOutputTab(tabId) {
  const buttons = Array.from(document.querySelectorAll(".tab-button"));
  const panels = Array.from(document.querySelectorAll(".tab-panel"));
  for (const b of buttons) b.classList.toggle("is-active", b.getAttribute("data-tab") === tabId);
  for (const p of panels) p.classList.toggle("is-active", p.id === tabId);
}

