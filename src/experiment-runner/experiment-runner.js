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
let currentReport = null;

init();

async function init() {
  await refreshTargetTabs();
  initOutputTabs();
  activateInitialOutputTab();
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
    const chunked = await chrome.runtime.sendMessage({
      type: "FLOATING_BAR_FIELD_SCAN",
      payload: {
        tabId: currentReport.meta.tabId,
        tabUrl: currentReport.meta.tabUrl,
        chunkedOnly: true
      }
    });
    const scan = ensureCurrentReportScan();
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
      snapshotParserExtractedFieldCount: Array.isArray(getParsedFieldScan(domScan)?.fields)
        ? getParsedFieldScan(domScan).fields.length
        : 0,
      extractedFieldCount: Array.isArray(scan.fields) ? scan.fields.length : 0,
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

  const [domScan, pageScreenshot] = await Promise.all([
    chrome.runtime.sendMessage({
      type: "FLOATING_BAR_FIELD_SCAN",
      payload: {
        tabId: tab.id,
        tabUrl: tab.url,
        snapshotOnly: true,
        includeChunked: false
      }
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

function activateInitialOutputTab() {
  const buttons = Array.from(document.querySelectorAll(".tab-button"));
  const panels = Array.from(document.querySelectorAll(".tab-panel"));
  for (const b of buttons) b.classList.toggle("is-active", b.getAttribute("data-tab") === "domScanTab");
  for (const p of panels) p.classList.toggle("is-active", p.id === "domScanTab");
}

