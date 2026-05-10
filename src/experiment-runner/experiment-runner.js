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
let currentReport = null;
let diagnoseState = {
  screenshotDataUrl: "",
  screenshotMeta: null,
  extractedFields: [],
  chatHistory: []
};

init();

async function init() {
  await refreshTargetTabs();
  initOutputTabs();
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

runDiagnoseRoundBtn?.addEventListener("click", async () => {
  await runDiagnoseRound({ userMessage: "" });
});

sendDiagnoseChatBtn?.addEventListener("click", async () => {
  const message = String(diagnoseChatInputEl?.value || "").trim();
  if (!message) return;
  diagnoseChatInputEl.value = "";
  await runDiagnoseRound({ userMessage: message });
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
  diagnoseState = { screenshotDataUrl: "", screenshotMeta: null, extractedFields: [], chatHistory: [] };
  if (diagnoseContextOutputEl) diagnoseContextOutputEl.textContent = "";
  if (diagnoseScreenshotOutputEl) diagnoseScreenshotOutputEl.innerHTML = "";
  if (diagnoseChatInputEl) diagnoseChatInputEl.value = "";
  renderDiagnoseChatLog();
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
  if (sendDiagnoseChatBtn) sendDiagnoseChatBtn.disabled = diagnoseState.chatHistory.length === 0;
  renderDiagnoseContext("(Run Diagnose Round to generate LLM context for this round.)");
  renderDiagnoseScreenshot();
  renderDiagnoseChatLog();
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
  if (!diagnoseState.chatHistory.length) {
    const p = document.createElement("p");
    p.className = "chunked-placeholder";
    p.textContent = "No diagnose chat yet. Click Run Diagnose Round.";
    diagnoseChatLogEl.appendChild(p);
    return;
  }
  for (const item of diagnoseState.chatHistory) {
    const wrap = document.createElement("div");
    wrap.className = "diagnose-chat-item";
    const role = document.createElement("strong");
    role.textContent = item.role === "user" ? "You" : "Diagnose";
    const content = document.createElement("div");
    content.textContent = String(item.content || "");
    wrap.appendChild(role);
    wrap.appendChild(content);
    diagnoseChatLogEl.appendChild(wrap);
  }
  diagnoseChatLogEl.scrollTop = diagnoseChatLogEl.scrollHeight;
}

async function runDiagnoseRound({ userMessage = "" } = {}) {
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
  if (sendDiagnoseChatBtn) sendDiagnoseChatBtn.disabled = true;
  statusEl.textContent = userMessage ? "Diagnose chat round..." : "Diagnose round...";
  if (userMessage) {
    diagnoseState.chatHistory.push({ role: "user", content: userMessage });
    renderDiagnoseChatLog();
  }
  try {
    const response = await chrome.runtime.sendMessage({
      type: "EXPERIMENT_RUNNER_DIAGNOSE_ROUND",
      payload: {
        tabId,
        tabUrl,
        title: String(currentReport?.domScan?.scan?.title || ""),
        screenshotDataUrl: diagnoseState.screenshotDataUrl,
        extractedFields: diagnoseState.extractedFields,
        userMessage,
        chatHistory: diagnoseState.chatHistory
      }
    });
    if (!response?.ok) {
      throw new Error(response?.error || "Diagnose round failed.");
    }
    renderDiagnoseContext(response.llmContextText || "(No context returned)");
    const assistantText = String(response.reportText || response?.diagnosis?.summary || "No response");
    diagnoseState.chatHistory.push({ role: "assistant", content: assistantText });
    renderDiagnoseChatLog();
    statusEl.textContent = "Diagnose round complete.";
  } catch (err) {
    statusEl.textContent = err instanceof Error ? err.message : String(err);
  } finally {
    if (runDiagnoseRoundBtn) {
      runDiagnoseRoundBtn.disabled = !tabId;
      runDiagnoseRoundBtn.textContent = "Run Diagnose Round";
    }
    if (sendDiagnoseChatBtn) sendDiagnoseChatBtn.disabled = diagnoseState.chatHistory.length === 0;
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

function initOutputTabs() {
  if (!outputTabsEl) return;
  const buttons = Array.from(outputTabsEl.querySelectorAll(".tab-button"));
  const panels = Array.from(document.querySelectorAll(".tab-panel"));
  for (const btn of buttons) {
    btn.addEventListener("click", () => {
      const target = btn.getAttribute("data-tab");
      for (const b of buttons) b.classList.toggle("is-active", b === btn);
      for (const p of panels) p.classList.toggle("is-active", p.id === target);
    });
  }
}

function activateOutputTab(tabId) {
  const buttons = Array.from(document.querySelectorAll(".tab-button"));
  const panels = Array.from(document.querySelectorAll(".tab-panel"));
  for (const b of buttons) b.classList.toggle("is-active", b.getAttribute("data-tab") === tabId);
  for (const p of panels) p.classList.toggle("is-active", p.id === tabId);
}

