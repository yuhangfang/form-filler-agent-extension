import { assistLargeTextboxText } from "./floating-bar/large-textbox-assist.js";
import { createFloatingBarHandlers } from "./floating-bar/floating-bar-background-handlers.js";
import { parseSnapshotFields } from "./field-extraction/snapshot-field-parser.js";
import { diagnoseFieldsAgainstScreenshot } from "./field-extraction/vision-fill-diagnosis.js";
import { analyzeSiteObservations } from "./field-learning/site-observation-ai.js";
import { batchGuessFormFields, runFieldPlannerStream } from "./field-guessing/field-value-guesser.js";
import "./field-guessing/profile-field-catalog.js";
import { simplifyFieldHintsForStorage } from "./field-guessing/field-hint-normalizer.js";
import { applyTrustedDropdownGuesses } from "./field-filling/trusted-dropdown-fill.js";
import { getAxFieldMap } from "./browser-capture/ax-snapshot.js";
import { captureDomThenSnapshot } from "./browser-capture/dom-scan-capture.js";
import { runBrowserMcpTool } from "./browser-capture/browser-mcp-background.js";
import {
  KEYS,
  getFieldHint,
  getLocal,
  getProfileForFill,
  normalizeQuestionKey,
  setLocal,
  upsertFieldHint
} from "./applicant-data/storage.js";

const { inferProfileFieldKey, PROFILE_FIELD_LABELS } = globalThis.__formFillerProfileFieldCatalog;

/** Mirrors `[FormFiller][field-fill][llm]` / openai diagnostics to the tab console (see floating-bar-controller `field_llm_debug`). */
function forwardFieldFillDebugToTab(tabId, prefix, data) {
  const text =
    typeof data === "string"
      ? `${prefix} ${data}`
      : `${prefix} ${JSON.stringify(data)}`;
  if (!tabId || typeof chrome === "undefined" || !chrome.tabs?.sendMessage) return;
  try {
    chrome.tabs.sendMessage(tabId, {
      type: "FLOATING_BAR_PROGRESS",
      text: text.slice(0, 12000),
      phase: "field_llm_debug"
    });
  } catch {
    /* ignore */
  }
}

function compactHintForLlm(hint) {
  if (!hint || typeof hint !== "object") return undefined;
  const out = {};
  if (hint.canonicalKey) out.canonicalKey = String(hint.canonicalKey).slice(0, 80);
  const pa = String(hint.correctedValue || hint.value || hint.lastGuessedValue || "").trim();
  if (pa) out.priorAnswer = pa.slice(0, 220);
  if (Array.isArray(hint.answerValues) && hint.answerValues.length) {
    out.answerSamples = hint.answerValues
      .slice(0, 4)
      .map((v) => String(v || "").trim().slice(0, 160))
      .filter(Boolean);
  }
  if (!out.canonicalKey && !out.priorAnswer && !(out.answerSamples && out.answerSamples.length)) return undefined;
  return out;
}

function buildFallbackShortLabel(context, canonicalKey, fingerprint) {
  const ck = String(canonicalKey || "").trim();
  if (ck) {
    return ck.replace(/([A-Z])/g, " $1").replace(/^./, (s) => s.toUpperCase()).trim();
  }
  const raw = String(context || "").trim();
  if (!raw) return `field ${String(fingerprint || "").slice(0, 8)}`;
  const firstSeg = raw.split(/\s{3,}|\n/)[0].trim() || raw;
  return firstSeg.replace(/\s+/g, " ").slice(0, 120).trim();
}

function dedupeRepeatedValue(value) {
  const s = String(value || "").trim();
  if (!s) return "";
  const parts = s.split("|").map((x) => x.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const first = parts[0].toLowerCase();
    if (parts.every((p) => p.toLowerCase() === first)) return parts[0];
  }
  return s.replace(/\s+/g, " ");
}

function normalizeSpacesForDebug(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function cleanSnapshotContextForDebug(text) {
  const s = normalizeSpacesForDebug(text)
    .replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi, " ")
    .replace(/\b[a-z0-9_-]{18,}\b/gi, " ")
    .replace(/completion is voluntary and will not subject you to adverse treatment/gi, " ")
    .replace(/decline to self[- ]?identify/gi, "prefer not to answer");
  if (!s) return "";
  const parts = s
    .split(/\s*\|\s*|\s{2,}/)
    .map((p) => normalizeSpacesForDebug(p))
    .filter(Boolean);
  const seen = new Set();
  const deduped = [];
  for (const p of parts) {
    const k = p.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(p);
  }
  return deduped.join(" | ").slice(0, 650);
}

function isLikelyOptionOnlyLabel(text) {
  const s = normalizeSpacesForDebug(text).toLowerCase();
  if (!s) return true;
  if (s.length <= 5) return true;
  if (/^(yes|no|y|n|male|female|other|na|n\/a|none)$/i.test(s)) return true;
  return false;
}

// Filter a pipe-delimited optionsSummary to options that share word overlap with seedValue.
// Falls back to the first maxFallback options if the filtered set is too small.
function filterRelatedOptionsSummary(optionsSummary, seedValue, { minMatches = 2, maxFallback = 25, maxResults = 30 } = {}) {
  if (!optionsSummary) return "";
  const opts = String(optionsSummary).split("|").map((o) => o.trim()).filter(Boolean);
  if (!opts.length) return "";
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  const words = norm(seedValue).split(" ").filter((w) => w.length >= 3);
  if (!words.length) return opts.slice(0, maxFallback).join(" | ");
  const related = opts.filter((opt) => words.some((w) => norm(opt).includes(w)));
  const result = related.length >= minMatches ? related : opts.slice(0, maxFallback);
  return result.slice(0, maxResults).join(" | ");
}

function compressOptionsSummaryForDebug(text) {
  const raw = normalizeSpacesForDebug(text);
  if (!raw) return "";
  const chunks = raw.split("|").map((c) => normalizeSpacesForDebug(c)).filter(Boolean);
  const seen = new Set();
  const compact = [];
  for (const c of chunks) {
    const key = c.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (c.length <= 120) compact.push(c);
    if (compact.length >= 18) break;
  }
  return compact.join(" | ").slice(0, 900);
}

async function normalizeHintsForStorage(domain, entries) {
  const cleaned = (Array.isArray(entries) ? entries : [])
    .map((e) => ({
      fingerprint: String(e?.fingerprint || "").slice(0, 32),
      context: String(e?.context || "").trim(),
      value: dedupeRepeatedValue(e?.value),
      canonicalKey: String(e?.canonicalKey || "").trim()
    }))
    .filter((e) => e.fingerprint);
  if (!cleaned.length) return new Map();

  const fallback = new Map(
    cleaned.map((e) => [
      e.fingerprint,
      {
        canonicalKey: String(e.canonicalKey || "").trim().toLowerCase(),
        shortLabel: buildFallbackShortLabel(e.context, e.canonicalKey, e.fingerprint),
        value: e.value
      }
    ])
  );

  const ai = await simplifyFieldHintsForStorage({ domain, entries: cleaned });
  if (!ai.ok || !Array.isArray(ai.normalized)) return fallback;

  for (const n of ai.normalized) {
    if (!n?.fingerprint) continue;
    const prior = fallback.get(n.fingerprint) || {};
    fallback.set(n.fingerprint, {
      canonicalKey: String(n.canonicalKey || prior.canonicalKey || "").trim().toLowerCase(),
      shortLabel: String(n.shortLabel || prior.shortLabel || "").trim(),
      value: dedupeRepeatedValue(String(n.value || prior.value || ""))
    });
  }
  return fallback;
}

async function handleLargeTextboxAssist(sender, payload) {
  const tabUrl = sender?.tab?.url || "";
  let domain = String(payload?.domain || "").trim();
  const mode = String(payload?.mode || "generate");
  console.log("[FormFiller TextAssist][BG] start", {
    mode,
    hasDomainInPayload: !!domain,
    hasTabUrl: !!tabUrl,
    label: String(payload?.label || ""),
    placeholder: String(payload?.placeholder || ""),
    questionContext: String(payload?.label || payload?.placeholder || ""),
    currentTextLength: String(payload?.currentText || "").length,
    instructionLength: String(payload?.instruction || "").length
  });
  if (!domain && tabUrl) {
    try {
      domain = new URL(tabUrl).hostname;
    } catch {
      domain = "";
    }
  }
  const profile = await getProfileForFill();
  const result = await assistLargeTextboxText({
    domain,
    mode: payload?.mode,
    label: payload?.label,
    placeholder: payload?.placeholder,
    currentText: payload?.currentText,
    instruction: payload?.instruction,
    profile
  });
  console.log("[FormFiller TextAssist][BG] result", {
    mode,
    ok: !!result?.ok,
    hasText: !!String(result?.text || "").trim(),
    textLength: String(result?.text || "").length,
    error: String(result?.error || "")
  });
  return result;
}


async function handleFormFieldsLlmBatch(payload) {
  const { tabId, domain, profile, candidates, platform, platformLabel, debugMode, scanOnly, onGuess } = payload;
  console.group(`%c[FormFiller BG] LLM batch — ${domain} (${platformLabel || platform || "?"})`, "color:#34d399;font-weight:bold");
  console.log("[BG-A] Profile:", profile);
  console.log("[BG-A] Candidates received:", candidates.length, candidates);
  if (!domain || !Array.isArray(candidates)) {
    console.groupEnd();
    return { ok: false, error: "Invalid payload", guesses: [] };
  }

  // Get the AX accessible name for every form control in the tab.
  // This is the browser's computed label (same as Playwright's browser_snapshot)
  // and is authoritative — it resolves aria-labelledby, aria-label, <label for>,
  // wrapped labels, and placeholder in one call without any DOM traversal.
  let axMap = new Map();
  if (tabId) {
    axMap = await getAxFieldMap(tabId);
    console.log(`[BG-AX] Accessibility map: ${axMap.size} field(s) resolved`);
  }

  // Enrich each candidate's context with the AX accessible name when available.
  // Playwright-like mode: use accessible name as primary semantic label with
  // only a short cleaned fallback, instead of large nearby DOM text blobs.
  function buildPlaywrightLikeContext(candidate, axName) {
    const ax = normalizeSpacesForDebug(axName || "");
    const name = normalizeSpacesForDebug(candidate?.name || "");
    const raw = normalizeSpacesForDebug(candidate?.context || "");
    const rowPrefix = raw.match(/^\[group:[^\]]+\]\s*/i)?.[0] || "";
    const kind = String(candidate?.kind || "").toLowerCase();
    const shouldAvoidAx = (kind === "radio" || kind === "checkbox" || kind === "checkbox-group") && isLikelyOptionOnlyLabel(ax);
    if (ax && !shouldAvoidAx) return `${rowPrefix}${ax}`.slice(0, 220);
    if (name) return `${rowPrefix}${name}`.slice(0, 220);
    return cleanSnapshotContextForDebug(raw).slice(0, 220);
  }

  function enrichContext(candidate) {
    const axName =
      (candidate.elementId && axMap.get(`id:${candidate.elementId}`)) ||
      (candidate.elementName && axMap.get(`name:${candidate.elementName}`)) ||
      "";
    return buildPlaywrightLikeContext(candidate, axName);
  }

  const resolved = [];
  const needLlm = [];

  for (const c of candidates) {
    const fp = c.fingerprint;
    if (!fp) continue;
    const qk = normalizeQuestionKey(c.context || "");
    const ck = inferProfileFieldKey(c.context || "");
    const hint = await getFieldHint(domain, fp, qk, ck);
    const hintValue = pickHintValue(hint);
    const hasOptions = !!(
      c.optionsSummary ||
      c.kind === "select" ||
      c.kind === "ariacombobox" ||
      c.kind === "radio" ||
      c.kind === "checkbox"
    );
    const usableHintValue =
      hintValue && !hintValueLooksLikePlaceholderOrBadSnapshot(hintValue) ? hintValue : "";
    const profileMappedValue =
      ck && profile && Object.prototype.hasOwnProperty.call(profile, ck)
        ? String(profile[ck] ?? "").trim()
        : "";
    const knownValueForOptions = usableHintValue || profileMappedValue;

    // User-corrected storage for dropdowns/radio/checkbox must NOT bypass the LLM:
    // stale pipe snapshots (`value|Select...`) were marked "filled" while the DOM stayed on the placeholder.
    if (hint?.correctedValue && hasOptions) {
      if (usableHintValue) {
        const filteredSummary = filterRelatedOptionsSummary(c.optionsSummary || "", usableHintValue);
        needLlm.push({
          ...c,
          currentValue: usableHintValue,
          optionsSummary: filteredSummary,
          learnedFieldHint: compactHintForLlm(hint)
        });
      } else {
        needLlm.push({ ...c, learnedFieldHint: compactHintForLlm(hint) });
      }
      continue;
    }

    if (hint?.correctedValue && !hasOptions) {
      if (usableHintValue) {
        resolved.push({
          fingerprint: fp,
          value: usableHintValue,
          frameHost: c.frameHost,
          source: "storage_corrected"
        });
      } else {
        needLlm.push({ ...c, learnedFieldHint: compactHintForLlm(hint) });
      }
      continue;
    }

    // Soft hint + option controls — seed LLM / matcher (same as before).
    if (usableHintValue && hasOptions) {
      const filteredSummary = filterRelatedOptionsSummary(c.optionsSummary || "", knownValueForOptions);
      needLlm.push({
        ...c,
        currentValue: knownValueForOptions,
        optionsSummary: filteredSummary,
        learnedFieldHint: compactHintForLlm(hint)
      });
      continue;
    }
    if (!usableHintValue && knownValueForOptions && hasOptions) {
      const filteredSummary = filterRelatedOptionsSummary(c.optionsSummary || "", knownValueForOptions);
      needLlm.push({
        ...c,
        currentValue: knownValueForOptions,
        optionsSummary: filteredSummary,
        learnedFieldHint: compactHintForLlm(hint)
      });
      continue;
    }
    if (usableHintValue) {
      resolved.push({
        fingerprint: fp,
        value: usableHintValue,
        frameHost: c.frameHost,
        source: "storage_guess"
      });
      continue;
    }
    needLlm.push({ ...c, learnedFieldHint: compactHintForLlm(hint) });
  }

  // Apply AX enrichment to the fields going to the LLM
  const needLlmEnriched = needLlm.map((c) => {
    const context = enrichContext(c);
    return {
      ...c,
      context,
      name: normalizeSpacesForDebug(c?.name || context).slice(0, 220),
      role: normalizeSpacesForDebug(c?.role || "").slice(0, 40),
      section: normalizeSpacesForDebug(c?.section || "").slice(0, 140),
      type: normalizeSpacesForDebug(c?.type || c?.kind || "").slice(0, 40)
    };
  });
  const cleanedForLlm = needLlmEnriched.map((f) => ({
    fingerprint: String(f.fingerprint || "").slice(0, 32),
    context: cleanSnapshotContextForDebug(String(f.context || "")),
    kind: String(f.kind || "text"),
    ...(f.currentValue != null ? { currentValue: String(f.currentValue).slice(0, 200) } : {}),
    optionsSummary: f.optionsSummary
      ? compressOptionsSummaryForDebug(String(f.optionsSummary || ""))
      : ""
  }));

  console.log(`[BG-B] Resolved from storage: ${resolved.length}, need LLM: ${needLlmEnriched.length}`);
  console.log("[BG-B] Storage hits:", resolved);
  console.log("[BG-B] Sending to OpenAI:", needLlmEnriched);

  if (scanOnly) {
    console.groupEnd();
    return {
      ok: true,
      guesses: resolved,
      debug: {
        rawNeedLlm: needLlm,
        needLlmEnriched,
        cleanedForLlm,
        resolved
      }
    };
  }

  let llmGuesses = [];
  if (needLlmEnriched.length) {
    const resumeRecord = await getLocal(KEYS.resumeRecord, null);
    const resumeData = resumeRecord?.resumeData || null;
    const case2Fields = [];
    const case1Fields = [];
    for (const f of needLlmEnriched) {
      const hasOptions = !!(
        f.optionsSummary ||
        f.kind === "select" ||
        f.kind === "ariacombobox" ||
        f.kind === "radio" ||
        f.kind === "checkbox"
      );
      const hasKnownAnswer = !!String(f.currentValue || "").trim();
      if (hasOptions && hasKnownAnswer) case2Fields.push(f);
      else case1Fields.push(f);
    }

    const plannerRowsByFp = new Map();
    const streamedGuessesByFp = new Map();
    const plannerRetrieveQueue = [];
    const plannerRetrieveTasks = [];
    const plannerRetrieveConcurrency = Math.max(1, Number(payload?.plannerRetrieveConcurrency || 2) | 0);
    let plannerRetrieveActive = 0;
    const emitGuess = (guess) => {
      if (!guess?.fingerprint || !String(guess.value || "").trim()) return;
      const fp = String(guess.fingerprint || "").slice(0, 32);
      const normalized = {
        fingerprint: fp,
        value: String(guess.value || "").trim(),
        frameHost: guess.frameHost,
        source: guess.source || "llm"
      };
      streamedGuessesByFp.set(fp, normalized);
      if (typeof onGuess === "function") {
        void Promise.resolve(onGuess(normalized)).catch(() => {});
      }
    };
    const drainPlannerRetrieveQueue = () => {
      while (plannerRetrieveActive < plannerRetrieveConcurrency && plannerRetrieveQueue.length) {
        const item = plannerRetrieveQueue.shift();
        plannerRetrieveActive += 1;
        const task = (async () => {
          const ai = await batchGuessFormFields({
            profile,
            resumeData,
            fields: [item.field],
            debugTabId: tabId
          });
          if (!ai.ok) return;
          const g = Array.isArray(ai.guesses) ? ai.guesses[0] : null;
          if (!g?.fingerprint || !String(g.value || "").trim()) return;
          emitGuess({
            fingerprint: g.fingerprint,
            value: g.value,
            frameHost: item.field?.frameHost,
            source: "llm"
          });
        })()
          .catch(() => {})
          .finally(() => {
            plannerRetrieveActive -= 1;
            drainPlannerRetrieveQueue();
          });
        plannerRetrieveTasks.push(task);
      }
    };
    let plannerError = "";
    if (case1Fields.length) {
      const case1ByFp = new Map(case1Fields.map((f) => [String(f.fingerprint || "").slice(0, 32), f]));
      const planner = await runFieldPlannerStream({
        profile,
        resumeData,
        fields: case1Fields,
        debugTabId: tabId,
        onRow: async (row) => {
          plannerRowsByFp.set(row.fingerprint, row);
          const field = case1ByFp.get(row.fingerprint);
          if (!field) return;
          if (row.intent === "direct" && String(row.value || "").trim()) {
            emitGuess({
              fingerprint: row.fingerprint,
              value: row.value,
              frameHost: field.frameHost,
              source: "planner_direct"
            });
            return;
          }
          if (row.intent === "retrieve") {
            plannerRetrieveQueue.push({
              field: {
                ...field,
                retrievalPlan: {
                  resumeRefs: Array.isArray(row.resumeRefs) ? row.resumeRefs : [],
                  profileKeys: Array.isArray(row.profileKeys) ? row.profileKeys : [],
                  facets: Array.isArray(row.facets) ? row.facets : []
                }
              }
            });
            drainPlannerRetrieveQueue();
          }
        }
      });
      if (!planner.ok) {
        plannerError = String(planner.error || "planner_failed");
        forwardFieldFillDebugToTab(tabId, "[FormFiller][field-fill][planner]", {
          phase: "planner_failed",
          error: plannerError
        });
      }
    }
    if (plannerRetrieveTasks.length) {
      await Promise.allSettled(plannerRetrieveTasks);
    }

    const plannerDirect = [];
    const plannerOrFallbackGuess = [...case2Fields];
    for (const field of case1Fields) {
      const fp = String(field.fingerprint || "").slice(0, 32);
      if (streamedGuessesByFp.has(fp)) continue;
      const plan = plannerRowsByFp.get(field.fingerprint);
      if (plan?.intent === "direct" && String(plan.value || "").trim()) {
        plannerDirect.push({
          fingerprint: field.fingerprint,
          value: String(plan.value || "").trim(),
          frameHost: field.frameHost,
          source: "planner_direct"
        });
        continue;
      }
      if (plan?.intent === "retrieve") {
        plannerOrFallbackGuess.push({
          ...field,
          retrievalPlan: {
            resumeRefs: Array.isArray(plan.resumeRefs) ? plan.resumeRefs : [],
            profileKeys: Array.isArray(plan.profileKeys) ? plan.profileKeys : [],
            facets: Array.isArray(plan.facets) ? plan.facets : []
          }
        });
        continue;
      }
      plannerOrFallbackGuess.push(field);
    }

    if (plannerDirect.length) resolved.push(...plannerDirect);

    const ai = await batchGuessFormFields({
      profile,
      resumeData,
      fields: plannerOrFallbackGuess,
      debugTabId: tabId
    });
    if (!ai.ok) {
      forwardFieldFillDebugToTab(tabId, "[FormFiller][field-fill][llm]", {
        phase: "batch_guess_failed",
        error: String(ai.error || "")
      });
      return {
        ok: true,
        guesses: resolved,
        llmError: plannerError ? `${plannerError}; ${ai.error}` : ai.error,
        ...(debugMode
          ? {
              debug: {
                rawNeedLlm: needLlm,
                needLlmEnriched,
                cleanedForLlm,
                resolved,
                case2Fields,
                case1Fields,
                plannerRows: Array.from(plannerRowsByFp.values())
              }
            }
          : {})
      };
    }
    llmGuesses = ai.guesses || [];
    for (const sg of streamedGuessesByFp.values()) {
      llmGuesses.push(sg);
    }
    const emptyLlm = llmGuesses.filter((g) => !String(g?.value ?? "").trim());
    if (emptyLlm.length && emptyLlm.length === llmGuesses.length && llmGuesses.length) {
      const payload = llmGuesses.map((g) => ({
        fp: String(g?.fingerprint || "").slice(0, 32),
        canonicalKey: g?.canonicalKey || ""
      }));
      console.log(
        "%c[FormFiller][field-fill][llm]",
        "color:#fbbf24",
        "batchGuessFormFields: all returned guesses have empty value",
        payload
      );
      forwardFieldFillDebugToTab(
        tabId,
        "[FormFiller][field-fill][llm]",
        { phase: "all_llm_guesses_empty", fingerprints: payload }
      );
    }
    const normalizedMap = await normalizeHintsForStorage(
      domain,
      llmGuesses.map((g) => {
        const meta = needLlmEnriched.find((x) => x.fingerprint === g.fingerprint);
        return {
          fingerprint: g.fingerprint,
          context: meta?.context || "",
          value: g.value,
          canonicalKey: g.canonicalKey || inferProfileFieldKey(meta?.context || "")
        };
      })
    );
    // Do not persist raw LLM guesses immediately.
    // We only learn from failure/correction signals (user edits or submit mismatches).
    void normalizedMap;
    if (plannerError) {
      forwardFieldFillDebugToTab(tabId, "[FormFiller][field-fill][planner]", {
        phase: "planner_fallback_used",
        error: plannerError,
        fallbackFields: case1Fields.length
      });
    }
  }

  const byFp = new Map();
  for (const g of resolved) {
    if (g.value) byFp.set(g.fingerprint, g);
  }
  const droppedEmptyLlm = [];
  for (const g of llmGuesses) {
    if (g.fingerprint && String(g.value || "").trim()) {
      byFp.set(g.fingerprint, {
        fingerprint: g.fingerprint,
        value: String(g.value).trim(),
        frameHost: needLlmEnriched.find((x) => x.fingerprint === g.fingerprint)?.frameHost,
        source: "llm"
      });
    } else if (g.fingerprint) {
      droppedEmptyLlm.push({
        fingerprint: String(g.fingerprint).slice(0, 32),
        valueLen: String(g.value ?? "").length,
        rawValuePreview: String(g.value ?? "").slice(0, 60)
      });
    }
  }

  const finalGuesses = Array.from(byFp.values());
  if (droppedEmptyLlm.length) {
    console.log(
      "%c[FormFiller][field-fill][llm]",
      "color:#fbbf24",
      "merge: dropped LLM row(s) with empty value (model abstained or whitespace only)",
      droppedEmptyLlm
    );
    forwardFieldFillDebugToTab(tabId, "[FormFiller][field-fill][llm]", {
      phase: "merge_dropped_empty_llm_value",
      dropped: droppedEmptyLlm
    });
  }
  console.log("[BG-C] Final guesses returned to popup:", finalGuesses);
  console.groupEnd();
  return {
    ok: true,
    guesses: finalGuesses,
    ...(debugMode
      ? {
          debug: {
            rawNeedLlm: needLlm,
            needLlmEnriched,
            cleanedForLlm,
            resolved
          }
        }
      : {})
  };
}

const {
  prepareFillContext,
  handleFloatingBarStop,
  handleFloatingBarFill,
  handleFloatingBarTrustedDropdown,
  handleFloatingBarClear,
  handleParseSnapshotRules,
  handleParseSnapshotLlm
} = createFloatingBarHandlers({
  applyTrustedDropdownGuesses,
  getProfileForFill,
  getLocal,
  KEYS,
  handleFormFieldsLlmBatch
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "SITE_AGENT_ANALYZE") {
    analyzeSiteObservations(message.payload)
      .then((result) => sendResponse(result))
      .catch((error) =>
        sendResponse({ ok: false, error: error instanceof Error ? error.message : "Site analysis failed" })
      );
    return true;
  }

  if (message?.type === "FORM_FIELDS_LLM_BATCH") {
    handleFormFieldsLlmBatch(message.payload)
      .then((result) => sendResponse(result))
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : "LLM batch failed",
          guesses: []
        })
      );
    return true;
  }

  if (message?.type === "LARGE_TEXTBOX_ASSIST") {
    handleLargeTextboxAssist(sender, message.payload)
      .then((result) => sendResponse(result))
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : "Large textbox assist failed"
        })
      );
    return true;
  }

  if (message?.type === "FIELD_USER_CORRECTED") {
    handleFieldUserCorrected(message.payload)
      .then(() => sendResponse({ ok: true }))
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : "Failed to save correction"
        })
      );
    return true;
  }

  if (message?.type === "PROFILE_FIELD_CHANGED") {
    handleProfileFieldChanged(sender, message.payload)
      .then((result) => sendResponse(result))
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : "Failed to update profile from page change"
        })
      );
    return true;
  }

  if (message?.type === "FORM_SUBMIT_FIELD_HINTS") {
    handleFormSubmitFieldHints(message.payload)
      .then(() => sendResponse({ ok: true }))
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : "Failed to save submit hints"
        })
      );
    return true;
  }

  if (message?.type === "OPEN_EXPERIMENT_RUNNER") {
    const url = chrome.runtime.getURL("src/experiment-runner/experiment-runner.html");
    chrome.tabs.create({ url })
      .then((tab) => sendResponse({ ok: true, tabId: tab.id }))
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : "Failed to open Experiment Runner"
        })
      );
    return true;
  }

  if (message?.type === "FLOATING_BAR_PREPARE_CONTEXT") {
    prepareFillContext(sender, message.payload || {})
      .then((result) => sendResponse(result))
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : "Floating context preparation failed"
        })
      );
    return true;
  }

  if (message?.type === "FLOATING_BAR_STOP") {
    handleFloatingBarStop(sender, message.payload || {})
      .then((result) => sendResponse(result))
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : "Floating stop failed"
        })
      );
    return true;
  }

  if (message?.type === "FLOATING_BAR_FILL") {
    handleFloatingBarFill(sender, message.payload || {})
      .then((result) => sendResponse(result))
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : "Floating fill failed"
        })
      );
    return true;
  }

  if (message?.type === "FLOATING_BAR_TRUSTED_DROPDOWN") {
    handleFloatingBarTrustedDropdown(sender, message.payload)
      .then((result) => sendResponse(result))
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : "Trusted dropdown fill failed"
        })
      );
    return true;
  }

  if (message?.type === "FLOATING_BAR_CLEAR") {
    handleFloatingBarClear(sender)
      .then((result) => sendResponse(result))
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : "Floating clear failed"
        })
      );
    return true;
  }

  if (message?.type === "SNAPSHOT_CAPTURE") {
    (async () => {
      const tabId = Number(message?.payload?.tabId || sender?.tab?.id || 0);
      const tabUrl = String(message?.payload?.tabUrl || sender?.tab?.url || "");
      if (!tabId || !tabUrl) return { ok: false, error: "No active tab context." };
      const captured = await captureDomThenSnapshot(tabId);
      if (!captured?.ok) return captured || { ok: false, error: "Snapshot capture failed." };
      return {
        ok: true,
        summary: "Snapshot captured.",
        snapshot: {
          url: String(captured.url || tabUrl || ""),
          requested_url: tabUrl,
          title: String(captured.title || ""),
          domOutline: String(captured.domOutline || ""),
          dom_outline: String(captured.domOutline || ""),
          snapshot_text: String(captured.snapshot_text || ""),
          snapshot_source: String(captured.snapshot_source || "extension_browser_snapshot"),
          timings: captured.timings || {}
        }
      };
    })()
      .then((result) =>
        sendResponse(result)
      )
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : "Snapshot capture failed"
        })
      );
    return true;
  }

  if (message?.type === "SNAPSHOT_PARSE_RULES") {
    handleParseSnapshotRules(sender, message.payload || {})
      .then((result) => sendResponse(result))
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : "Snapshot rules parse failed"
        })
      );
    return true;
  }

  if (message?.type === "SNAPSHOT_PARSE_LLM") {
    handleParseSnapshotLlm(sender, message.payload || {})
      .then((result) => sendResponse(result))
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : "Snapshot LLM parse failed"
        })
      );
    return true;
  }

  if (message?.type === "EXPERIMENT_RUNNER_DIAGNOSE_ROUND") {
    (async () => {
      const tabId = Number(message?.payload?.tabId || 0);
      const tab = tabId ? await chrome.tabs.get(tabId).catch(() => null) : null;
      const tabUrl = String(message?.payload?.tabUrl || tab?.url || "");
      const title = String(message?.payload?.title || tab?.title || "");
      const screenshotDataUrl = String(message?.payload?.screenshotDataUrl || "");
      const extractedFields = Array.isArray(message?.payload?.extractedFields) ? message.payload.extractedFields : [];
      if (!tabUrl) return { ok: false, error: "tabUrl is required." };
      if (!screenshotDataUrl) return { ok: false, error: "screenshotDataUrl is required." };
      if (!extractedFields.length) return { ok: false, error: "extractedFields is required." };
      const result = await diagnoseFieldsAgainstScreenshot({
        url: tabUrl,
        title,
        screenshotDataUrl,
        extractedFields,
        operatorMessage: String(message?.payload?.userMessage || ""),
        chatHistory: Array.isArray(message?.payload?.chatHistory) ? message.payload.chatHistory : []
      });
      return result;
    })()
      .then((result) => sendResponse(result))
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : "Experiment diagnose round failed"
        })
      );
    return true;
  }

  if (message?.type === "BROWSER_MCP") {
    runBrowserMcpTool(message, sender)
      .then((result) => sendResponse(result))
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : "BROWSER_MCP failed"
        })
      );
    return true;
  }

  return false;
});

async function handleFieldUserCorrected(payload) {
  const { domain, fingerprint, newValue, priorValue } = payload;
  if (!domain || !fingerprint) return;
  const payloadContext = [payload?.context, payload?.label].filter(Boolean).join(" | ");
  const inferredFromPayload = inferProfileFieldKey(payloadContext || "");
  const existing = await getFieldHint(domain, fingerprint, payloadContext, inferredFromPayload);
  const nextValue = newValue != null ? String(newValue).trim() : "";
  const normalizedMap = await normalizeHintsForStorage(domain, [
    {
      fingerprint,
      context: payloadContext || existing?.labelContext || existing?.questionKey || "",
      value: nextValue,
      canonicalKey: existing?.canonicalKey || inferredFromPayload || inferProfileFieldKey(existing?.labelContext || "")
    }
  ]);
  const normalized = normalizedMap.get(fingerprint);
  const normalizedValue = String(normalized?.value || nextValue).trim();
  const normalizedCanonicalKey = String(
    normalized?.canonicalKey || existing?.canonicalKey || inferredFromPayload || inferProfileFieldKey(existing?.labelContext || "")
  ).trim();
  const shortLabel = String(normalized?.shortLabel || "").trim();
  const labelContext = (shortLabel || payloadContext || existing?.labelContext || "").slice(0, 400);
  await upsertFieldHint({
    domain,
    fingerprint,
    fingerprints: [fingerprint],
    questionKey:
      normalizeQuestionKey(shortLabel || payloadContext || existing?.questionKey || existing?.labelContext || ""),
    canonicalKey: normalizedCanonicalKey,
    labelContext,
    learnedAliases: [shortLabel, payloadContext, existing?.questionKey, existing?.labelContext].filter(Boolean),
    controlKind: payload?.controlKind || existing?.controlKind || "unknown",
    lastGuessedValue: existing?.lastGuessedValue ?? (priorValue != null ? String(priorValue) : ""),
    correctedValue: normalizedValue,
    answerValues: normalizedValue ? [normalizedValue] : [],
    source: existing?.source === "llm" ? "llm+corrected" : "user",
    userUpdatedAt: new Date().toISOString()
  });
}

function tokenOverlapScore(left, right) {
  const a = normalizeComparableValue(left).replace(/[^a-z0-9\s]/g, " ");
  const b = normalizeComparableValue(right).replace(/[^a-z0-9\s]/g, " ");
  if (!a || !b) return 0;
  if (a === b) return 100;
  if (a.includes(b) || b.includes(a)) return 70;
  const aTokens = new Set(a.split(/\s+/).filter((t) => t.length >= 3));
  const bTokens = b.split(/\s+/).filter((t) => t.length >= 3);
  if (!aTokens.size || !bTokens.length) return 0;
  const hits = bTokens.filter((t) => aTokens.has(t)).length;
  return hits ? Math.min(65, 20 + hits * 15) : 0;
}

function chooseChangedSnapshotField(payload, fields) {
  const payloadContext = [
    payload?.context,
    payload?.label,
    payload?.elementName,
    payload?.elementId
  ].filter(Boolean).join(" | ");
  const payloadKind = String(payload?.controlKind || "").toLowerCase();
  let best = null;
  let bestScore = 0;
  for (const field of Array.isArray(fields) ? fields : []) {
    const label = String(field?.label || field?.field_label || field?.name || field?.id || "").trim();
    if (!label) continue;
    let score = tokenOverlapScore(label, payloadContext);
    const type = String(field?.type || field?.field_type || "").toLowerCase();
    if (payloadKind && type && (type === payloadKind || (payloadKind === "select" && type === "combobox"))) score += 12;
    if (payload?.elementName && String(field?.name || "").trim() === String(payload.elementName).trim()) score += 40;
    if (payload?.elementId && String(field?.id || "").trim() === String(payload.elementId).trim()) score += 40;
    if (score > bestScore) {
      best = field;
      bestScore = score;
    }
  }
  return bestScore >= 35 ? best : null;
}

function cleanChangedProfileValue(value) {
  const raw = String(value || "").replace(/\s+/g, " ").trim();
  if (!raw) return "";
  const parts = raw.split("|").map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const label = parts[parts.length - 1];
    const first = parts[0];
    if (parts.every((p) => p.toLowerCase() === first.toLowerCase())) return first;
    if (label && !/^[0-9a-f]{8,}(?:-[0-9a-f]{4,})*$/i.test(label)) return label;
  }
  return raw;
}

function profileFieldLabel(key) {
  return PROFILE_FIELD_LABELS[key] || String(key || "")
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (s) => s.toUpperCase())
    .trim();
}

function canUpdateProfileKey(rawProfile, key) {
  if (!key || key === "registerPassword") return false;
  return Object.prototype.hasOwnProperty.call(PROFILE_FIELD_LABELS, key) ||
    Object.prototype.hasOwnProperty.call(rawProfile || {}, key);
}

async function notifyProfileUpdated(tabId, fieldLabel, value) {
  const shortValue = String(value || "").slice(0, 120);
  const text = `${fieldLabel} updated in profile: ${shortValue}`;
  if (tabId) {
    try {
      await chrome.tabs.sendMessage(tabId, { type: "PROFILE_FIELD_UPDATED", text });
    } catch {
      // The page-level status is best effort; browser notification below is primary.
    }
  }
  try {
    if (chrome.notifications?.create) {
      chrome.notifications.create({
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/icon-48.png"),
        title: "Profile updated",
        message: text
      });
    }
  } catch {
    // Notification permission may be unavailable in development builds.
  }
}

async function handleProfileFieldChanged(sender, payload = {}) {
  const tabId = sender?.tab?.id;
  const changedValue = cleanChangedProfileValue(payload?.displayValue || payload?.value || "");
  if (!tabId || !changedValue) return { ok: true, updated: false, reason: "missing_tab_or_value" };

  let snapshotFields = [];
  const capture = await captureDomThenSnapshot(tabId).catch(() => null);
  if (capture?.ok && capture.snapshot_text) {
    const parsed = parseSnapshotFields({
      url: capture.url || payload.url || "",
      title: capture.title || "",
      snapshotText: capture.snapshot_text || ""
    });
    snapshotFields = Array.isArray(parsed?.domFields) ? parsed.domFields : [];
  }

  const changedField = chooseChangedSnapshotField(payload, snapshotFields);
  const snapshotContext = changedField
    ? [
        changedField.label,
        changedField.name,
        changedField.id,
        Array.isArray(changedField.options) ? changedField.options.join(" | ") : ""
      ].filter(Boolean).join(" | ")
    : "";
  const context = [snapshotContext, payload.context, payload.label].filter(Boolean).join(" | ");
  const profileKey = inferProfileFieldKey(context);
  const rawProfile = await getLocal(KEYS.profile, {});
  if (!canUpdateProfileKey(rawProfile, profileKey)) {
    return { ok: true, updated: false, reason: "no_profile_key", context: cleanSnapshotContextForDebug(context) };
  }

  const priorValue = String(rawProfile?.[profileKey] ?? "").trim();
  if (normalizeComparableValue(priorValue) === normalizeComparableValue(changedValue)) {
    return { ok: true, updated: false, reason: "unchanged", profileKey };
  }

  await setLocal(KEYS.profile, { ...rawProfile, [profileKey]: changedValue });
  const label = profileFieldLabel(profileKey);
  await notifyProfileUpdated(tabId, label, changedValue);
  return {
    ok: true,
    updated: true,
    profileKey,
    fieldLabel: label,
    value: changedValue,
    matchedSnapshotLabel: changedField?.label || ""
  };
}

/**
 * Skip persisting learn-on-submit for controls tagged with profile / rule-based fill sources.
 * (User-driven updates still go through {@link handleFieldUserCorrected}.)
 */
function shouldOmitSubmitHintForRuleBasedFill(fillSource) {
  const s = String(fillSource || "").trim().toLowerCase();
  if (!s) return false;
  if (s === "deterministic" || s.startsWith("deterministic:")) return true;
  if (s.startsWith("evaluate:pass1") || s.startsWith("evaluate:pass2")) return true;
  if (s.startsWith("evaluate:storage")) return true;
  if (s === "evaluate:checkbox_click_once") return true;
  if (s === "register" || s.startsWith("register:")) return true;
  if (s.startsWith("floating:sequential")) return true;
  if (s === "fill:single") return true;
  return false;
}

async function handleFormSubmitFieldHints(payload) {
  const { domain, entries } = payload || {};
  if (!domain || !Array.isArray(entries)) return;
  const prepared = [];
  const seenFingerprints = new Set();
  for (const e of entries) {
    const fp = e?.fingerprint;
    if (!fp) continue;
    if (seenFingerprints.has(fp)) continue;
    seenFingerprints.add(fp);
    const val = String(e.value ?? "").trim();
    if (!val) continue;
    const fillSource = String(e.fillSource || "").trim();
    const fillOrigin = String(e.fillOrigin || "").trim();
    const userEdited = e.userEdited === true;
    if (shouldOmitSubmitHintForRuleBasedFill(fillSource)) continue;
    const isLlmAutofill = /(^|:)llm(?::|$)/i.test(fillSource);
    const wasEditedFromFill =
      userEdited && !!fillOrigin && normalizeComparableValue(fillOrigin) !== normalizeComparableValue(val);
    if (!isLlmAutofill && !wasEditedFromFill) continue;
    const questionKey = normalizeQuestionKey(e.labelContext || "");
    const inferredCk = inferProfileFieldKey(e.labelContext || "");
    const existing = await getFieldHint(domain, fp, questionKey, inferredCk);
    prepared.push({
      entry: e,
      existing,
      fingerprint: fp,
      value: val,
      questionKey,
      inferredCanonicalKey: inferredCk,
      isLlmAutofill,
      wasEditedFromFill
    });
  }

  const normalizedMap = await normalizeHintsForStorage(
    domain,
    prepared.map((p) => ({
      fingerprint: p.fingerprint,
      context: p.entry?.labelContext || p.existing?.labelContext || "",
      value: p.value,
      canonicalKey: p.existing?.canonicalKey || p.inferredCanonicalKey
    }))
  );

  for (const p of prepared) {
    const e = p.entry;
    const fp = p.fingerprint;
    const existing = p.existing;
    const normalized = normalizedMap.get(fp);
    const normalizedValue = String(normalized?.value || p.value).trim().slice(0, 500);
    if (existing && hintAlreadyHasValue(existing, normalizedValue)) continue;
    const shortLabel = String(normalized?.shortLabel || "").trim();
    const normalizedCanonicalKey = String(
      normalized?.canonicalKey || existing?.canonicalKey || p.inferredCanonicalKey
    ).trim();
    const ctx = (e.labelContext || existing?.labelContext || "").slice(0, 400);
    const priorGuess = String(existing?.lastGuessedValue ?? "").trim();
    const priorCorrected = String(existing?.correctedValue ?? "").trim();
    const isUserCorrection = p.wasEditedFromFill || (!!priorGuess && priorGuess !== normalizedValue);
    await upsertFieldHint({
      domain,
      fingerprint: fp,
      fingerprints: [fp],
      questionKey:
        normalizeQuestionKey(shortLabel || p.questionKey || existing?.questionKey || ""),
      canonicalKey: normalizedCanonicalKey,
      labelContext: (shortLabel || ctx).slice(0, 400),
      learnedAliases: [shortLabel, p.questionKey, ctx, existing?.questionKey, existing?.labelContext].filter(Boolean),
      controlKind: e.controlKind || existing?.controlKind || "unknown",
      lastGuessedValue: normalizedValue,
      answerValues: [normalizedValue],
      correctedValue: isUserCorrection ? normalizedValue : (priorCorrected || null),
      source: isUserCorrection ? "corrected" : "llm",
      userUpdatedAt: new Date().toISOString()
    });
  }
}

function hintAlreadyHasValue(hint, value) {
  const next = String(value || "").trim().toLowerCase();
  if (!next) return true;
  if (String(hint?.correctedValue || "").trim().toLowerCase() === next) return true;
  if (String(hint?.value || "").trim().toLowerCase() === next) return true;
  if (String(hint?.lastGuessedValue || "").trim().toLowerCase() === next) return true;
  if (Array.isArray(hint?.answerValues)) {
    for (const v of hint.answerValues) {
      if (String(v || "").trim().toLowerCase() === next) return true;
    }
  }
  return false;
}

function normalizeComparableValue(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function pickHintValue(hint) {
  if (!hint) return "";
  const corrected = String(hint.correctedValue ?? "").trim();
  if (corrected) return corrected;
  const value = String(hint.value ?? "").trim();
  if (value) return value;
  const guessed = String(hint.lastGuessedValue ?? "").trim();
  if (guessed) return guessed;
  if (Array.isArray(hint.answerValues)) {
    for (const value of hint.answerValues) {
      const s = String(value || "").trim();
      if (s) return s;
    }
  }
  return "";
}

/**
 * Rejects submit-snapshot / placeholder values (e.g. `|Select...`, `uuid|Select...`) that are not real answers.
 * @param {string} value
 */
function hintValueLooksLikePlaceholderOrBadSnapshot(value) {
  const s = String(value || "").trim();
  if (!s) return true;
  const low = s.toLowerCase().replace(/\s+/g, " ").trim();
  // Submit snapshot `value|label` when nothing real was chosen — leading "|..."
  if (/^\|\s*(select\.{3}|choose|\-\-|pick|\.\.\.)/i.test(s)) return true;
  if (/^(select\.{3}|choose\.{3}|please\s+select|\-\-)$/i.test(low)) return true;
  const parts = s.split("|").map((x) => String(x || "").trim()).filter(Boolean);
  if (parts.length >= 2) {
    const labelPart = parts[parts.length - 1];
    const lp = labelPart.toLowerCase().replace(/\s+/g, "");
    if (/^select\.{3}$|^choose\.{3}$|^pickone|^--$/.test(lp)) return true;
    if (/^select\.{3}|choose\s+one|please\s+select/i.test(labelPart)) return true;
  }
  return false;
}
