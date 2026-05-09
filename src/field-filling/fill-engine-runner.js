import { BROWSER_TOOLS_INJECT_CHAIN } from "../browser-capture/browser-tools-inject-chain.js";

export async function tryMainFrameFill(tabId, profile) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: "RUN_FILL",
      profile
    });
    if (response?.ok && response.result) {
      return normalizeFillResult(response.result);
    }
  } catch {
    /* No listener (restricted page, PDF viewer, or no content script). */
  }
  return emptyFillResult();
}

export async function tryAllFramesScriptingFill(tabId, profile) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: [...BROWSER_TOOLS_INJECT_CHAIN, "src/field-guessing/profile-field-catalog.js", "src/field-learning/learned-field-memory.js", "src/field-filling/demographic-field-tools.js", "src/field-filling/field-descriptor-tools.js", "src/field-filling/control-fill-tools.js", "src/field-filling/choice-control-tools.js", "src/field-filling/page-fill-engine.js"]
    });
  } catch {
    /* Some subframes are not injectable. */
  }

  let injections;
  try {
    injections = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: (p) => {
        const run = globalThis.__runDeterministicFill;
        if (typeof run !== "function") {
          return { filledCount: 0, decisions: [], unresolved: 0, skipped: true };
        }
        return run(p);
      },
      args: [profile]
    });
  } catch {
    return emptyFillResult();
  }

  let filledCount = 0;
  const decisions = [];
  let unresolved = 0;
  let llmRecommended = false;
  for (const row of injections || []) {
    if (row.error || !row.result || row.result.skipped) continue;
    filledCount += row.result.filledCount;
    decisions.push(...(row.result.decisions || []));
    unresolved += row.result.unresolved ?? 0;
    llmRecommended = llmRecommended || !!row.result.llmRecommended;
  }

  return {
    filledCount,
    decisions,
    unresolved,
    llmRecommended,
    timestamp: new Date().toISOString()
  };
}

export async function collectAllFrameDiagnostics(tabId) {
  try {
    const rows = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        const inputs = Array.from(document.querySelectorAll("input"));
        let fillable = 0;
        for (const i of inputs) {
          const t = (i.type || "text").toLowerCase();
          if (t === "hidden" || t === "submit" || t === "button" || t === "image") continue;
          if (i.disabled || i.readOnly) continue;
          fillable += 1;
        }
        const textareas = document.querySelectorAll("textarea").length;
        const iframeEls = document.querySelectorAll("iframe");
        return {
          href: location.href,
          host: location.hostname,
          fillableInputs: fillable,
          textareas,
          iframeCount: iframeEls.length
        };
      }
    });
    return (rows || [])
      .filter((r) => !r.error && r.result)
      .map((r) => r.result);
  } catch {
    return [];
  }
}

export function buildAgentHint(frames) {
  if (!frames.length) {
    return "Could not inspect the page (restricted URL or no access). Try a normal https tab after refreshing.";
  }
  const totalVisible = frames.reduce(
    (s, f) => s + (f.fillableInputs || 0) + (f.textareas || 0),
    0
  );
  const top = frames[0];
  if (totalVisible === 0) {
    const ifr = top?.iframeCount ?? 0;
    if (ifr > 0) {
      return "No visible fields in the top frame, but iframes are present. Open the Apply / application panel inside the page, then run Fill again.";
    }
    return "No visible inputs found. Open the job application form (Apply, sign-in, or next step), then try Fill again.";
  }
  return `Found ${totalVisible} visible field(s) across ${frames.length} frame(s) but none matched your profile (name, email, phone, etc.). Check Quick Profile or site-specific field labels.`;
}

export function emptyFillResult() {
  return {
    filledCount: 0,
    decisions: [],
    unresolved: 0,
    llmRecommended: false,
    timestamp: new Date().toISOString()
  };
}

export function normalizeFillResult(r) {
  return {
    filledCount: r.filledCount ?? 0,
    decisions: Array.isArray(r.decisions) ? r.decisions : [],
    unresolved: r.unresolved ?? 0,
    llmRecommended: !!r.llmRecommended,
    timestamp: r.timestamp || new Date().toISOString()
  };
}
