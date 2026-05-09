import { BROWSER_TOOLS_INJECT_CHAIN } from "./browser-tools-inject-chain.js";

/** Playwright MCP–compatible surface (browser_navigate, tabs, screenshot, relay to content tools). */
export async function handleBrowserMcp(message, sender) {
  const tool = message.tool;
  const payload = message.payload || {};
  const tabId = message.tabId ?? sender?.tab?.id;

  const contentTools = new Set([
    "browser_snapshot",
    "browser_click",
    "browser_fill_form",
    "browser_evaluate",
    "browser_wait_for",
    "browser_file_upload"
  ]);

  if (contentTools.has(tool)) {
    if (tabId == null) return { ok: false, error: "Missing tabId (call from a tab or pass tabId)." };
    const viaMessage = await new Promise((resolve) => {
      chrome.tabs.sendMessage(
        tabId,
        { type: "BROWSER_TOOL_RUN", tool, payload },
        (response) => {
          const err = chrome.runtime.lastError;
          if (err) {
            resolve({ _relayErr: err.message });
            return;
          }
          resolve(response ?? { ok: false, error: "No response from content script." });
        }
      );
    });
    if (viaMessage && !viaMessage._relayErr) return viaMessage;

    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: [...BROWSER_TOOLS_INJECT_CHAIN]
      });
      const rows = await chrome.scripting.executeScript({
        target: { tabId },
        func: async (t, p) => {
          const run = globalThis.__dispatchBrowserTool;
          if (typeof run !== "function") return { ok: false, error: "browser-tools.js missing" };
          return run({ tool: t, payload: p });
        },
        args: [tool, payload]
      });
      const row = rows?.find((r) => !r.error && r.result);
      if (row?.result) return row.result;
      return {
        ok: false,
        error:
          viaMessage?._relayErr ||
          rows?.find((r) => r.error)?.error?.toString?.() ||
          "executeScript relay failed"
      };
    } catch (e) {
      return {
        ok: false,
        error: viaMessage?._relayErr || (e instanceof Error ? e.message : String(e))
      };
    }
  }

  if (tool === "browser_navigate") {
    if (tabId == null) return { ok: false, error: "Missing tabId for navigate." };
    const url = payload.url;
    if (!url || typeof url !== "string") return { ok: false, error: "payload.url required" };
    await chrome.tabs.update(tabId, { url });
    return { ok: true };
  }

  if (tool === "browser_tabs") return handleBrowserTabs(payload, sender?.tab?.id);

  if (tool === "browser_take_screenshot") {
    if (tabId == null) return { ok: false, error: "Missing tabId for screenshot." };
    try {
      const tab = await chrome.tabs.get(tabId);
      const format = payload?.type === "jpeg" ? "jpeg" : "png";
      if (payload?.fullPage || payload?.full_page) {
        const full = await captureFullPageScreenshotWithDebugger(tab.id, format);
        if (full.ok) return full;
        // Fallback: some pages reject CDP screenshot with errors like
        // {"code":-32000,"message":"Unable to capture screenshot"}.
        // Return a visible-viewport screenshot instead of failing hard.
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format });
        return {
          ok: true,
          dataUrl,
          format,
          fullPage: false,
          fallback: "visible_tab",
          warning: full.error || "Full-page screenshot unavailable; fell back to viewport capture."
        };
      }
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format });
      return { ok: true, dataUrl, format };
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : "captureVisibleTab failed"
      };
    }
  }

  return { ok: false, error: `Unknown BROWSER_MCP tool: ${tool}` };
}

function debuggerAttach(target, version) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach(target, version, () => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve();
    });
  });
}

function debuggerDetach(target) {
  return new Promise((resolve) => {
    chrome.debugger.detach(target, () => resolve());
  });
}

function debuggerSendCommand(target, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(target, method, params, (result) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(result || {});
    });
  });
}

async function captureFullPageScreenshotWithDebugger(tabId, format) {
  const target = { tabId };
  let attached = false;
  try {
    await debuggerAttach(target, "1.3");
    attached = true;
    const metrics = await debuggerSendCommand(target, "Page.getLayoutMetrics");
    const size = metrics.cssContentSize || metrics.contentSize || {};
    const width = Math.max(1, Math.ceil(Number(size.width) || 0));
    const height = Math.max(1, Math.ceil(Number(size.height) || 0));
    let capture;
    try {
      capture = await debuggerSendCommand(target, "Page.captureScreenshot", {
        format,
        fromSurface: true,
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width, height, scale: 1 }
      });
    } catch (_clipErr) {
      // Retry without clip if target rejects explicit full-page clip.
      capture = await debuggerSendCommand(target, "Page.captureScreenshot", {
        format,
        fromSurface: true,
        captureBeyondViewport: true
      });
    }
    if (!capture.data) throw new Error("Page.captureScreenshot returned no image data.");
    return {
      ok: true,
      dataUrl: `data:image/${format};base64,${capture.data}`,
      format,
      fullPage: true,
      width,
      height
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error || "Page.captureScreenshot failed")
    };
  } finally {
    if (attached) await debuggerDetach(target);
  }
}

async function handleBrowserTabs(payload, senderTabId) {
  const action = payload?.action;
  if (!action) return { ok: false, error: "payload.action required" };

  const tabsInWindow = await chrome.tabs.query({ currentWindow: true });
  const sorted = tabsInWindow.slice().sort((a, b) => a.index - b.index);

  if (action === "list") {
    return {
      ok: true,
      tabs: sorted.map((t, i) => ({
        index: i,
        tabId: t.id,
        title: t.title,
        url: t.url,
        active: t.active
      }))
    };
  }

  if (action === "new") {
    const tab = await chrome.tabs.create({
      url: typeof payload.url === "string" ? payload.url : "about:blank",
      active: true
    });
    return { ok: true, tabId: tab.id, windowId: tab.windowId };
  }

  if (action === "close") {
    let victim;
    if (payload.index !== undefined && payload.index !== null) victim = sorted[Number(payload.index)];
    else if (senderTabId != null) victim = sorted.find((t) => t.id === senderTabId);
    if (!victim?.id) return { ok: false, error: "Could not resolve tab to close." };
    await chrome.tabs.remove(victim.id);
    return { ok: true };
  }

  if (action === "select") {
    const idx =
      payload.index !== undefined && payload.index !== null
        ? Number(payload.index)
        : Math.max(0, sorted.findIndex((t) => t.id === senderTabId));
    const tab = sorted[idx];
    if (!tab?.id) return { ok: false, error: "Invalid tab index for select." };
    await chrome.tabs.highlight({ tabs: tab.index, windowId: tab.windowId });
    await chrome.tabs.update(tab.id, { active: true });
    return { ok: true };
  }

  return { ok: false, error: `Unknown browser_tabs action: ${action}` };
}
