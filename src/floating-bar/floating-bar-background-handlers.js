import { tryAttachStoredResume } from "../applicant-data/resume-attachment.js";
import { BROWSER_TOOLS_INJECT_CHAIN } from "../browser-capture/browser-tools-inject-chain.js";
import { captureDomThenSnapshot } from "../browser-capture/dom-scan-capture.js";
import { parseSnapshotFieldsWithLLMChunked } from "../field-extraction/llm-snapshot-field-extractor.js";
import { displayLabelForField } from "../field-extraction/field-normalization.js";
import { parseSnapshotFields } from "../field-extraction/snapshot-field-parser.js";

/**
 * Injected before in-page collectors run. Ends with page-form-detection so
 * `__formFillerPageFormTools.isLargeTextareaForAiAssist` exists (same helper the AI assist chip uses).
 */
const PAGE_SCRAPE_AND_FILL_INJECT = [
  ...BROWSER_TOOLS_INJECT_CHAIN,
  "src/field-guessing/profile-field-catalog.js",
  "src/field-learning/learned-field-memory.js",
  "src/field-filling/demographic-field-tools.js",
  "src/field-filling/field-descriptor-tools.js",
  "src/field-filling/control-fill-tools.js",
  "src/field-filling/choice-control-tools.js",
  "src/field-filling/page-fill-engine.js",
  "src/field-filling/page-form-detection.js"
];

const preparedFillContextByTab = new Map();
const stopRequestedByTab = new Set();
const PREPARED_FILL_CONTEXT_TTL_MS = 30000;
/** Pause before the next field so the user can follow — skipped when the previous field was filled by a live LLM guess. */
const DEFAULT_STEP_PAUSE_AFTER_NON_LLM_MS = 180;

/** Service worker console: filter DevTools with `[FormFiller][field-fill]`. */
const FIELD_FILL_LOG_PREFIX = "[FormFiller][field-fill]";
/** Extra diagnostics when AI fallback runs or returns nothing useful — filter `[FormFiller][field-fill][llm]`. */
const FIELD_FILL_LLM_DEBUG_PREFIX = "[FormFiller][field-fill][llm]";

function logFieldFillLine(line) {
  try {
    console.log(line);
  } catch {
    /* ignore */
  }
}

/**
 * Logs LLM troubleshooting info in the service worker and mirrors it to the tab console
 * (same path as `[FormFiller][field-fill] …` lines) so you see debug output in the page DevTools.
 */
async function logFieldFillLlmDebug(payload, emitProgress) {
  try {
    console.log(FIELD_FILL_LLM_DEBUG_PREFIX, payload);
  } catch {
    /* ignore */
  }
  if (typeof emitProgress === "function") {
    try {
      await emitProgress(`${FIELD_FILL_LLM_DEBUG_PREFIX} ${JSON.stringify(payload)}`.slice(0, 12000), {
        phase: "field_llm_debug"
      });
    } catch {
      /* ignore */
    }
  }
}

/** Profile value for logging after deterministic fill (inject does not always return the written string). */
function profileValueForLog(profile, profileKey) {
  const k = String(profileKey || "").trim();
  if (!k || !profile || typeof profile !== "object") return "";
  const v = profile[k];
  return v != null && String(v).trim() ? String(v).trim().slice(0, 120) : "";
}

function deterministicValueForLog(profile, det) {
  if (det?.mappedProfileValue) return String(det.mappedProfileValue).slice(0, 120);
  const pk = String(det?.profileKey || "").trim();
  if (!pk) return "—";
  const fromProf = profileValueForLog(profile, pk);
  return fromProf || `[${pk}]`;
}

function guessApproachLabel(source) {
  const s = String(source || "").trim();
  if (!s || s === "llm") return "llm";
  if (/storage/i.test(s)) return s.replace(/_/g, " ");
  return s;
}

/**
 * One line: description, value, filled state, approach (deterministic / llm / unresolved …).
 */
function formatFieldFillLine({ index, total, description, value, filled, approach }) {
  const d = String(description || "").replace(/\s+/g, " ").trim().slice(0, 100);
  const vRaw = String(value ?? "").trim();
  const v = vRaw ? vRaw.slice(0, 120) : "—";
  let filledCol = "no";
  if (filled === "skipped") filledCol = "skipped (already set)";
  else if (filled === true || filled === "yes") filledCol = "yes";
  const a = String(approach || "").trim().slice(0, 72);
  return `${FIELD_FILL_LOG_PREFIX} ${index}/${total} · ${d} · value: ${v} · filled: ${filledCol} · ${a}`;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function formatPauseDuration(ms) {
  const n = Math.max(0, Number(ms) || 0);
  if (n < 1000) return `${Math.round(n)}ms`;
  const s = n / 1000;
  const t = s >= 10 ? Math.round(s) : Math.round(s * 10) / 10;
  return `${String(t).replace(/\.0$/, "")}s`;
}

function desiredRepeatRowsFromResume(resumeRecord) {
  const resumeData = resumeRecord?.resumeData || {};
  const educationCount = Array.isArray(resumeData.education) ? resumeData.education.length : 0;
  const experienceCount = Array.isArray(resumeData.experience) ? resumeData.experience.length : 0;
  const internshipCount = Array.isArray(resumeData.internships) ? resumeData.internships.length : 0;
  return {
    desiredEducationRows: Math.max(1, Math.min(6, educationCount || 1)),
    desiredExperienceRows: Math.max(1, Math.min(8, experienceCount + internshipCount || 1))
  };
}

/**
 * Message-handler implementations for floating-bar actions (fill, field scan, clear, etc.).
 * Dependencies are injected so the service worker can supply LLM batch handlers without circular imports.
 */
export function createFloatingBarHandlers(deps) {
  const {
    applyTrustedDropdownGuesses,
    getProfileForFill,
    getLocal,
    KEYS,
    handleFormFieldsLlmBatch
  } = deps;

  function preparedContextKey(tabId, tabUrl) {
    return `${tabId}:${String(tabUrl || "")}`;
  }

  function isPreparedContextFresh(context) {
    return !!context && Date.now() - Number(context.preparedAt || 0) < PREPARED_FILL_CONTEXT_TTL_MS;
  }

  function snapshotFieldLabel(field) {
    return displayLabelForField(field);
  }

  function snapshotFieldType(field) {
    return String(field?.field_type || field?.type || "").toLowerCase();
  }

  function enrichCandidatesWithSnapshotFields(candidates, snapshotFields) {
    const fields = Array.isArray(snapshotFields) ? snapshotFields : [];
    if (!fields.length) return candidates;
    const byRef = new Map();
    for (const field of fields) {
      const ref = String(field?.id || field?.ref || "").trim();
      const label = snapshotFieldLabel(field);
      if (ref && label) {
        byRef.set(ref, field);
        byRef.set(ref.toLowerCase(), field);
      }
    }
    return candidates.map((candidate) => {
      const ref = String(candidate?.snapshotRef || candidate?.ref || "").trim();
      const matched = ref ? byRef.get(ref) || byRef.get(ref.toLowerCase()) : null;
      if (!matched) return candidate;
      const label = snapshotFieldLabel(matched);
      if (!label) return candidate;
      return {
        ...candidate,
        snapshotRef: ref || String(matched?.id || matched?.ref || "").trim(),
        question: label,
        label,
        name: label,
        cardLabel: label,
        snapshotType: snapshotFieldType(matched)
      };
    });
  }

  /**
   * Same human-readable title as Prev/Next cards (`snapshotFields` / domFields).
   * Ref map first, then token overlap against live control text (fingerprint) per frame.
   */
  async function resolveSnapshotCardLabelsForFill(tabId, candidates, snapshotFields) {
    const list = Array.isArray(candidates) ? candidates : [];
    const fields = Array.isArray(snapshotFields) ? snapshotFields : [];
    if (!list.length || !fields.length) return list;
    const normalizedSnapshotFields = fields.map((field) => ({
      ...field,
      _cardLabel: snapshotFieldLabel(field)
    }));

    const refToCard = new Map();
    for (const f of normalizedSnapshotFields) {
      const ref = String(f?.id || f?.ref || "").trim();
      const card = String(f?._cardLabel || "").trim();
      if (!ref || !card) continue;
      refToCard.set(ref, card);
      refToCard.set(ref.toLowerCase(), card);
    }

    let out = list.map((c) => {
      const r = String(c.snapshotRef || c.ref || "").trim();
      if (!r) return { ...c };
      const lab = refToCard.get(r) || refToCard.get(r.toLowerCase());
      return lab ? { ...c, cardLabel: String(c.cardLabel || "").trim() || lab } : { ...c };
    });

    const missing = out.filter((c) => !String(c.cardLabel || "").trim());
    if (!missing.length) return out;

    let rows;
    try {
      rows = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: (miss, snaps) => {
          const fieldTools = globalThis.__formFillerFieldDescriptorTools;
          const fillTools = globalThis.__formFillerControlFillTools;
          const choiceTools = globalThis.__formFillerChoiceControlTools;
          const host = typeof location !== "undefined" ? location.hostname : "";
          if (!fieldTools || !fillTools || !choiceTools) return [];
          const norm = (t) => String(t || "").replace(/\s+/g, " ").trim().toLowerCase();
          const tok = (t) =>
            new Set(
              norm(t)
                .replace(/[^a-z0-9\s]/g, " ")
                .split(/\s+/)
                .filter((x) => x.length >= 3)
            );
          const overlap = (a, b) => {
            let hit = 0;
            for (const x of a) if (b.has(x)) hit += 1;
            return hit;
          };
          const scoreLab = (controlText, snapLabel) => {
            const A = tok(controlText);
            const B = tok(snapLabel);
            if (!A.size || !B.size) return 0;
            const hits = overlap(A, B);
            const denom = Math.min(A.size, B.size);
            return hits / Math.max(1, denom);
          };

          const results = [];
          for (const c of miss) {
            if (String(c.frameHost || "") && String(c.frameHost || "") !== host) continue;
            const fp = String(c.fingerprint || "");
            if (!fp) continue;
            let control = null;
            try {
              for (const el of choiceTools.collectFormControlsAndRoleCheckables(document)) {
                if (fieldTools.computeFieldFingerprint(el) === fp) {
                  control = el;
                  break;
                }
              }
            } catch {
              continue;
            }
            if (!(control instanceof Element)) continue;

            const sem = fieldTools.getPlaywrightSemanticParts(control);
            const extended = fieldTools.extendedGuessContext(control);
            const help = fieldTools.collectControlHelpText(control);
            const bundle = norm(
              [sem?.section, sem?.name, extended, help, c.name, c.context, c.section].filter(Boolean).join(" ")
            );

            let best = "";
            let bestScore = 0;
            for (const sf of snaps) {
              const lab = String(sf?._cardLabel || sf?.label || sf?.field_label || sf?.name || "")
                .replace(/\s+/g, " ")
                .trim();
              if (!lab || lab.length < 4) continue;
              const s =
                scoreLab(bundle, lab) * 0.55 +
                scoreLab(norm(sem?.name || ""), lab) * 0.28 +
                scoreLab(norm(sem?.section || ""), lab) * 0.17;
              if (s > bestScore) {
                bestScore = s;
                best = lab;
              }
            }
            if (best && bestScore >= 0.32) {
              results.push({ fingerprint: fp, frameHost: host, cardLabel: best.slice(0, 240) });
            }
          }
          return results;
        },
        args: [missing, normalizedSnapshotFields]
      });
    } catch {
      rows = [];
    }

    const pickMap = new Map();
    for (const row of rows || []) {
      if (row.error || !Array.isArray(row.result)) continue;
      for (const p of row.result) {
        if (!p?.fingerprint || !p.cardLabel) continue;
        pickMap.set(`${p.fingerprint}|${String(p.frameHost || "")}`, p.cardLabel);
      }
    }

    out = out.map((c) => {
      if (String(c.cardLabel || "").trim()) return c;
      const k = `${c.fingerprint}|${String(c.frameHost || "")}`;
      const lab = pickMap.get(k);
      return lab ? { ...c, cardLabel: lab } : c;
    });

    return out;
  }

  async function focusCandidateInTab(tabId, candidate) {
    if (!candidate) return;
    try {
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: (fp, autoId, expectedHost) => {
          const fn = globalThis.__focusFieldByFingerprint;
          if (typeof fn !== "function") return { ok: false };
          return fn(fp, autoId, expectedHost);
        },
        args: [candidate.fingerprint, candidate.autoId || "", String(candidate?.frameHost || "")]
      });
    } catch {
      // ignore focus issues
    }
  }

  async function applySingleCandidateGuess(tabId, candidate, guess) {
    if (candidate?.kind === "ariacombobox" && candidate?.autoId) {
      try {
        const rows = await chrome.scripting.executeScript({
          target: { tabId, allFrames: true },
          func: async (autoId, value, expectedHost) => {
            const host = typeof location !== "undefined" ? location.hostname : "";
            if (expectedHost && host && host !== expectedHost) {
              return { applied: 0, logs: [], skippedHost: host };
            }
            const fn = globalThis.__applyAriaComboboxGuesses;
            if (typeof fn !== "function") return { applied: 0 };
            return fn([{ autoId, value }]);
          },
          args: [candidate.autoId, guess.value, String(candidate?.frameHost || "")]
        });
        const usable = (rows || [])
          .filter((r) => !r.error && r.result)
          .map((r) => r.result)
          .filter((r) => !r.skippedHost);
        const applied = usable.reduce((s, r) => s + Number(r?.applied || 0), 0);
        const logs = usable.flatMap((r) => (Array.isArray(r?.logs) ? r.logs : []));
        return { applied, logs };
      } catch {
        return { applied: 0 };
      }
    }
    try {
      const rows = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: async (g) => {
          const fn = globalThis.__applyFieldGuessVerbose;
          if (typeof fn !== "function") return { applied: 0, steps: ["apply:missing_applyFieldGuessVerbose"] };
          return await fn(g);
        },
        args: [{ ...guess, frameHost: candidate?.frameHost || "" }]
      });
      const result = (rows || []).find((r) => !r.error && r.result)?.result;
      if (!result) {
        const errRow = (rows || []).find((r) => r.error);
        return {
          applied: 0,
          steps: ["apply:no_injected_result"],
          applyError: errRow?.error ? String(errRow.error) : "no_script_result"
        };
      }
      return { applied: Number(result?.applied || 0), steps: result?.steps || [] };
    } catch (error) {
      return {
        applied: 0,
        steps: ["apply:exception"],
        applyError: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async function collectFieldFillQueue(tabId) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        files: PAGE_SCRAPE_AND_FILL_INJECT
      });
    } catch {
      // Some frames may not be injectable; collect from the frames that are available.
    }

    let rows;
    try {
      rows = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: () => {
          const fieldTools = globalThis.__formFillerFieldDescriptorTools;
          const fillTools = globalThis.__formFillerControlFillTools;
          const choiceTools = globalThis.__formFillerChoiceControlTools;
          if (!fieldTools || !fillTools || !choiceTools) {
            return { candidates: [], frameHost: typeof location !== "undefined" ? location.hostname : "" };
          }
          const frameHost = typeof location !== "undefined" ? location.hostname : "";
          const seen = new Set();
          const candidates = [];
          const browserRefs = globalThis.__browserToolRefs;
          const refForControl = (control) => {
            if (!browserRefs?.entries || !(control instanceof Element)) return "";
            try {
              for (const [ref, el] of browserRefs.entries()) {
                if (!(el instanceof Element)) continue;
                if (el === control || el.contains(control) || control.contains(el)) return String(ref || "");
              }
            } catch {
              // Best-effort only; fallback matching uses visual order.
            }
            return "";
          };
          const visual = (el) => {
            const rect = el.getBoundingClientRect?.();
            return {
              visualTop: rect ? Math.round(rect.top + window.scrollY) : Number.POSITIVE_INFINITY,
              visualLeft: rect ? Math.round(rect.left + window.scrollX) : Number.POSITIVE_INFINITY
            };
          };
          const pushCandidate = (control, kind, extra = {}) => {
            if (!(control instanceof Element)) return;
            if (!fillTools.isVisibleForScrape(control)) return;
            if (control.disabled || control.readOnly) return;
            const fp = fieldTools.computeFieldFingerprint(control);
            if (!fp || seen.has(fp)) return;
            const semantic = fieldTools.getPlaywrightSemanticParts(control);
            const context = fieldTools.extendedGuessContext(control);
            if (!context && !semantic?.name) return;
            seen.add(fp);
            candidates.push({
              fingerprint: fp,
              snapshotRef: refForControl(control),
              elementId: control.id || "",
              elementName: control.name || "",
              context: String(context || "").slice(0, 900),
              role: semantic.role || "",
              name: semantic.name || "",
              section: semantic.section || "",
              type: semantic.inputType || kind,
              helpText: fieldTools.collectControlHelpText(control),
              kind,
              frameHost,
              ...visual(control),
              ...extra
            });
          };

          for (const control of fillTools.sortElementsByVisualOrder(fillTools.collectFormControls(document))) {
            if (control instanceof HTMLSelectElement) {
              if (!fillTools.selectLooksUnfilled(control)) continue;
              const options = Array.from(control.options || [])
                .slice(0, 45)
                .map((o) => String(o.textContent || "").trim())
                .filter(Boolean);
              pushCandidate(control, "select", {
                options,
                optionsSummary: Array.from(control.options || [])
                  .slice(0, 45)
                  .map((o) => `${(o.value || "").trim()}: ${(o.textContent || "").trim()}`.slice(0, 72))
                  .join(" | ")
                  .slice(0, 1500)
              });
              continue;
            }
            if (control instanceof HTMLTextAreaElement) {
              if ((control.value || "").trim()) continue;
              const largeAssist = globalThis.__formFillerPageFormTools?.isLargeTextareaForAiAssist;
              if (typeof largeAssist === "function" && largeAssist(control)) continue;
              pushCandidate(control, "textarea");
              continue;
            }
            if (!(control instanceof HTMLInputElement)) continue;
            const type = (control.type || "text").toLowerCase();
            if (type === "password") {
              if ((control.value || "").trim()) continue;
              const detectReg = globalThis.__detectRegisterIntentForPage;
              if (typeof detectReg !== "function" || !detectReg()) continue;
              pushCandidate(control, "password");
              continue;
            }
            if (["hidden", "submit", "button", "image", "file"].includes(type)) continue;
            if (type === "radio" || type === "checkbox") continue;
            if ((control.value || "").trim()) continue;
            pushCandidate(control, type || "text");
          }

          const seenRadioGroupKeys = new Set();
          const radioSeeds = choiceTools.collectFormControlsAndRoleCheckables(document).filter(
            (el) => choiceTools.checkableType(el) === "radio" && !choiceTools.checkableDisabled(el)
          );
          for (const seed of fillTools.sortElementsByVisualOrder(radioSeeds)) {
            if (!fillTools.isVisibleForScrape(seed)) continue;
            const members = choiceTools.collectRadioGroupMembers(seed);
            if (!members.length) continue;
            const namedInput = members.find(
              (m) =>
                m instanceof HTMLInputElement &&
                (m.type || "").toLowerCase() === "radio" &&
                (m.name || "").trim()
            );
            const groupKey =
              namedInput instanceof HTMLInputElement
                ? `name:${(namedInput.name || "").trim()}`
                : `anon:${fieldTools.simpleHash(
                    members
                      .map((m) => choiceTools.checkboxOrRadioLabel(m))
                      .join("|")
                      .slice(0, 400)
                  )}`;
            if (seenRadioGroupKeys.has(groupKey)) continue;
            seenRadioGroupKeys.add(groupKey);
            if (members.some((m) => choiceTools.checkableChecked(m))) continue;
            const rep = members[0];
            const options = members.map((m) => choiceTools.checkboxOrRadioLabel(m)).filter(Boolean);
            pushCandidate(rep, "radio", {
              options,
              optionsSummary: members
                .slice(0, 20)
                .map((m) => {
                  const val =
                    m instanceof HTMLInputElement
                      ? (m.value || "").trim()
                      : String(m.getAttribute("value") || "").trim();
                  return `${val}: ${choiceTools.checkboxOrRadioLabel(m)}`.slice(0, 80);
                })
                .join(" | ")
                .slice(0, 1500)
            });
          }

          const seenCheckboxGroupKeys = new Set();
          const checkboxSeeds = choiceTools.collectFormControlsAndRoleCheckables(document).filter(
            (el) => choiceTools.checkableType(el) === "checkbox" && !choiceTools.checkableDisabled(el)
          );
          for (const seed of fillTools.sortElementsByVisualOrder(checkboxSeeds)) {
            if (!fillTools.isVisibleForScrape(seed)) continue;
            const members = choiceTools.collectCheckboxGroupMembers(seed);
            if (!members.length) continue;
            const namedInput = members.find(
              (m) =>
                m instanceof HTMLInputElement &&
                (m.type || "").toLowerCase() === "checkbox" &&
                (m.name || "").trim()
            );
            const groupKey =
              namedInput instanceof HTMLInputElement
                ? `chkname:${(namedInput.name || "").trim()}`
                : `chkanon:${fieldTools.simpleHash(
                    members
                      .map((m) => choiceTools.checkboxOrRadioLabel(m))
                      .join("|")
                      .slice(0, 400)
                  )}`;
            if (seenCheckboxGroupKeys.has(groupKey)) continue;
            seenCheckboxGroupKeys.add(groupKey);
            if (members.some((m) => choiceTools.checkableChecked(m))) continue;
            const rep = members[0];
            const options = members.map((m) => choiceTools.checkboxOrRadioLabel(m)).filter(Boolean);
            pushCandidate(rep, "checkbox", {
              options,
              optionsSummary: members
                .slice(0, 24)
                .map((m) => {
                  const val =
                    m instanceof HTMLInputElement
                      ? (m.value || "").trim()
                      : String(m.getAttribute("value") || "").trim();
                  return `${val}: ${choiceTools.checkboxOrRadioLabel(m)}`.slice(0, 80);
                })
                .join(" | ")
                .slice(0, 1500)
            });
          }

          return { candidates, frameHost };
        }
      });
    } catch {
      return [];
    }

    const candidates = [];
    for (const row of rows || []) {
      if (row.error || !row.result) continue;
      for (const candidate of row.result.candidates || []) {
        candidates.push({ ...candidate, frameHost: candidate.frameHost || row.result.frameHost || "" });
      }
    }
    const seenFingerprints = new Set(candidates.map((candidate) => candidate.fingerprint));
    let ariaRows;
    try {
      ariaRows = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: () => {
          const fn = globalThis.__collectAriaComboboxGaps;
          return typeof fn === "function" ? fn() : { candidates: [], frameHost: "" };
        }
      });
    } catch {
      ariaRows = [];
    }
    for (const row of ariaRows || []) {
      if (row.error || !row.result) continue;
      for (const candidate of row.result.candidates || []) {
        if (!candidate?.fingerprint || seenFingerprints.has(candidate.fingerprint)) continue;
        seenFingerprints.add(candidate.fingerprint);
        candidates.push({ ...candidate, frameHost: candidate.frameHost || row.result.frameHost || "" });
      }
    }
    candidates.sort((a, b) => {
      const ah = String(a?.frameHost || "");
      const bh = String(b?.frameHost || "");
      if (ah && bh && ah !== bh) return ah.localeCompare(bh);
      const at = Number(a?.visualTop ?? Number.POSITIVE_INFINITY);
      const bt = Number(b?.visualTop ?? Number.POSITIVE_INFINITY);
      if (at !== bt) return at - bt;
      const al = Number(a?.visualLeft ?? Number.POSITIVE_INFINITY);
      const bl = Number(b?.visualLeft ?? Number.POSITIVE_INFINITY);
      if (al !== bl) return al - bl;
      return String(a?.fingerprint || "").localeCompare(String(b?.fingerprint || ""));
    });
    return candidates;
  }

  async function tryDeterministicCandidate(tabId, candidate, profile) {
    try {
      const rows = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: (c, p) => {
          const expectedHost = String(c?.frameHost || "");
          const host = typeof location !== "undefined" ? location.hostname : "";
          const pack = (r) => ({ ...r, frameHost: host });
          if (expectedHost && host && expectedHost !== host) return pack({ ok: false, reason: "frame_mismatch" });
          const fieldTools = globalThis.__formFillerFieldDescriptorTools;
          const fillTools = globalThis.__formFillerControlFillTools;
          const choiceTools = globalThis.__formFillerChoiceControlTools;
          const tryFill = globalThis.__tryFillSingleControlFromProfile;
          const resolveLabel = globalThis.__resolveMappedValueFromLabelText;
          const demographicFieldTools = globalThis.__formFillerDemographicFieldTools;
          if (!fieldTools || !fillTools || !choiceTools || typeof tryFill !== "function") {
            return pack({ ok: false, reason: "deterministic_unavailable" });
          }
          const fp = String(c?.fingerprint || "");
          if (!fp) return pack({ ok: false, reason: "missing_fingerprint" });
          const controls = choiceTools.collectFormControlsAndRoleCheckables(document);
          const target = controls.find((control) => {
            try {
              return fieldTools.computeFieldFingerprint(control) === fp;
            } catch {
              return false;
            }
          });
          if (!target) return pack({ ok: false, reason: "control_not_found" });

          const direct = tryFill(target, p);
          if (direct?.ok) return pack({ ok: true, reason: direct.reason || "deterministic", profileKey: direct.profileKey || "" });
          if (direct?.reason === "has_value" || direct?.reason === "select_skip") {
            return pack({ ok: true, alreadyFilled: true, reason: direct.reason });
          }

          if (choiceTools.checkableType(target) === "radio" && typeof resolveLabel === "function") {
            const labelText = [c?.name, c?.context, c?.section].filter(Boolean).join(" ");
            const mapped = resolveLabel(labelText, p);
            if (!mapped?.value) {
              return pack({
                ok: false,
                reason: direct?.reason || "no_map",
                labelUsedForMap: String(labelText || "").slice(0, 200)
              });
            }
            const hit = choiceTools.findMatchingRadioInGroup(target, [mapped.value]);
            if (!hit) {
              return pack({
                ok: false,
                reason: "radio_no_match",
                profileKey: mapped.profileKey || "",
                mappedProfileValue: String(mapped.value || "").slice(0, 160)
              });
            }
            hit.focus?.();
            hit.click();
            hit.dispatchEvent(new Event("input", { bubbles: true }));
            hit.dispatchEvent(new Event("change", { bubbles: true }));
            return pack({ ok: true, reason: "deterministic_radio", profileKey: mapped.profileKey || "" });
          }

          if (
            choiceTools.checkableType(target) === "checkbox" &&
            typeof resolveLabel === "function" &&
            demographicFieldTools &&
            typeof demographicFieldTools.choiceCandidatesForProfileValue === "function"
          ) {
            const labelText = [c?.name, c?.context, c?.section].filter(Boolean).join(" ");
            const mapped = resolveLabel(labelText, p);
            if (!mapped?.value) {
              return pack({
                ok: false,
                reason: direct?.reason || "no_map",
                labelUsedForMap: String(labelText || "").slice(0, 200)
              });
            }
            const cands = demographicFieldTools.choiceCandidatesForProfileValue(
              mapped.value,
              mapped.profileKey || ""
            );
            const ok = choiceTools.selectCheckboxChoice(target, cands);
            if (!ok) {
              return pack({
                ok: false,
                reason: "checkbox_no_match",
                profileKey: mapped.profileKey || "",
                mappedProfileValue: String(mapped.value || "").slice(0, 160)
              });
            }
            return pack({ ok: true, reason: "deterministic_checkbox", profileKey: mapped.profileKey || "" });
          }

          return pack({ ok: false, reason: direct?.reason || "unresolved" });
        },
        args: [candidate, profile]
      });
      const attempts = (rows || [])
        .filter((row) => !row.error && row.result)
        .map((row) => {
          const r = row.result;
          return {
            frameHost: String(r?.frameHost || ""),
            ok: !!r?.ok,
            reason: String(r?.reason || ""),
            alreadyFilled: !!r?.alreadyFilled,
            profileKey: String(r?.profileKey || ""),
            labelUsedForMap: r?.labelUsedForMap,
            mappedProfileValue: r?.mappedProfileValue
          };
        });
      const result = (rows || [])
        .filter((row) => !row.error && row.result && row.result.reason !== "frame_mismatch")
        .map((row) => row.result)
        .find((res) => res.ok) ||
        (rows || [])
          .filter((row) => !row.error && row.result && row.result.reason !== "frame_mismatch")
          .map((row) => row.result)[0];
      const base = result || { ok: false, reason: "not_processed" };
      return { ...base, attempts };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : "deterministic_failed", attempts: [] };
    }
  }

  async function probeCandidateFillFailure(tabId, candidate) {
    try {
      const rows = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: (c) => {
          const expectedHost = String(c?.frameHost || "");
          const host = typeof location !== "undefined" ? location.hostname : "";
          if (expectedHost && host && expectedHost !== host) return null;
          const fieldTools = globalThis.__formFillerFieldDescriptorTools;
          const fillTools = globalThis.__formFillerControlFillTools;
          const choiceTools = globalThis.__formFillerChoiceControlTools;
          if (!fieldTools || !fillTools || !choiceTools) return null;
          const fp = String(c?.fingerprint || "");
          if (!fp) return null;
          const controls = choiceTools.collectFormControlsAndRoleCheckables(document);
          const control = controls.find((el) => {
            try {
              return fieldTools.computeFieldFingerprint(el) === fp;
            } catch {
              return false;
            }
          });
          if (!(control instanceof Element)) {
            return { frameHost: host, found: false, reason: "control_not_found" };
          }
          const rect = control.getBoundingClientRect?.();
          const type = control instanceof HTMLInputElement
            ? String(control.type || "text").toLowerCase()
            : control instanceof HTMLSelectElement
              ? "select"
              : control instanceof HTMLTextAreaElement
                ? "textarea"
                : String(control.getAttribute("role") || control.tagName || "").toLowerCase();
          const choiceType = choiceTools.checkableType(control);
          const isVisible = !!fillTools.isVisibleForScrape(control);
          const isDisabled = !!(control.disabled || control.readOnly || control.getAttribute("aria-disabled") === "true");
          let optionCount = 0;
          let optionPreview = [];
          if (control instanceof HTMLSelectElement) {
            optionCount = Number(control.options?.length || 0);
            optionPreview = Array.from(control.options || [])
              .slice(0, 6)
              .map((opt) => String(opt.textContent || "").trim())
              .filter(Boolean);
          } else if (choiceType === "radio" || choiceType === "checkbox") {
            const members = choiceType === "radio"
              ? choiceTools.collectRadioGroupMembers(control)
              : choiceTools.collectCheckboxGroupMembers(control);
            optionCount = members.length;
            optionPreview = members
              .slice(0, 6)
              .map((m) => choiceTools.checkboxOrRadioLabel(m))
              .filter(Boolean);
          }
          return {
            frameHost: host,
            found: true,
            isVisible,
            isDisabled,
            type: choiceType || type,
            optionCount,
            optionPreview,
            rect: rect
              ? { w: Math.round(rect.width || 0), h: Math.round(rect.height || 0) }
              : null
          };
        },
        args: [candidate]
      });
      const result = (rows || []).find((row) => !row.error && row.result)?.result;
      return result || { found: false, reason: "probe_no_result" };
    } catch (error) {
      return { found: false, reason: error instanceof Error ? error.message : "probe_failed" };
    }
  }

  async function runFieldByFieldFill(tabId, profile, domain, options = {}) {
    const emitProgress = typeof options.onProgress === "function" ? options.onProgress : async () => {};
    const aiFallbackEnabled = options.aiFallbackEnabled !== false;
    const stepPauseAfterNonLlmMs = Math.max(
      0,
      Number(
        options.pauseAfterNonLlmFillMs !== undefined && options.pauseAfterNonLlmFillMs !== null
          ? options.pauseAfterNonLlmFillMs
          : options.llmPauseAfterMs !== undefined && options.llmPauseAfterMs !== null
            ? options.llmPauseAfterMs
            : DEFAULT_STEP_PAUSE_AFTER_NON_LLM_MS
      ) || 0
    );
    const preparedCandidates = Array.isArray(options.candidates) ? options.candidates : [];
    await emitProgress(preparedCandidates.length ? "Using prepared field list..." : "Preparing field list...");
    const candidates = preparedCandidates.length ? preparedCandidates : await collectFieldFillQueue(tabId);
    const startLine = `${FIELD_FILL_LOG_PREFIX} start · ${candidates.length} field(s) · ${domain}${aiFallbackEnabled ? "" : " · AI off"}`;
    logFieldFillLine(startLine);
    await emitProgress(startLine, {
      phase: "fill_run_start",
      totalFields: candidates.length,
      domain,
      aiFallbackEnabled
    });
    const decisions = [];
    /** Per-field diagnostics (also echoed to console with prefix `[FormFiller][field-fill]`). */
    const fieldFillLog = [];
    let deterministicFilled = 0;
    let alreadyFilled = 0;
    let llmApplied = 0;
    let unresolved = 0;
    let troubleshootingRecovered = 0;
    let previousDeterministicFilled = false;
    const llmQueue = [];
    const unresolvedQueue = [];
    const unresolvedSeen = new Set();
    const fieldQuestion = (candidate) =>
      (
        String(candidate?.cardLabel || "").trim() ||
        displayLabelForField(candidate) ||
        String(candidate?.kind || "field").trim()
      ).slice(0, 140);
    const traceField = async ({ index, total, description, value, filled, approach, field }) => {
      const line = formatFieldFillLine({
        index,
        total,
        description,
        value,
        filled,
        approach
      });
      fieldFillLog.push({
        index,
        total,
        description: String(description || "").slice(0, 200),
        value: String(value ?? "").slice(0, 200),
        filled,
        approach
      });
      logFieldFillLine(line);
      await emitProgress(line, {
        phase: "field_trace",
        index,
        total,
        outcome: approach,
        ...(field ? { field } : {})
      });
    };
    const decisionDetail = (parts) => parts.filter(Boolean).join(" — ").slice(0, 420);
    const rememberUnresolved = (item) => {
      const fp = String(item?.candidate?.fingerprint || "").slice(0, 32);
      if (!fp || unresolvedSeen.has(fp)) return;
      unresolvedSeen.add(fp);
      unresolvedQueue.push(item);
    };

    // Pass 1: deterministic over all fields (bulk-first behavior).
    for (let i = 0; i < candidates.length; i += 1) {
      if (stopRequestedByTab.has(tabId)) {
        stopRequestedByTab.delete(tabId);
        const filledCount = deterministicFilled + llmApplied;
        return {
          ok: true,
          stopped: true,
          filledCount,
          deterministicFilled,
          alreadyFilled,
          llmApplied,
          unresolved,
          decisions,
          fieldFillLog,
          timestamp: new Date().toISOString(),
          summary: `Stopped. Filled ${filledCount} field(s): deterministic ${deterministicFilled}, AI ${llmApplied}, unresolved ${unresolved}.`
        };
      }
      const candidate = candidates[i];
      if (i > 0 && previousDeterministicFilled && stepPauseAfterNonLlmMs > 0) {
        await emitProgress(
          `Pause ${formatPauseDuration(stepPauseAfterNonLlmMs)} before field ${i + 1}/${candidates.length} (follow deterministic / non-AI step)…`,
          {
            phase: "pause_catch_up",
            index: i + 1,
            total: candidates.length,
            pauseMs: stepPauseAfterNonLlmMs
          }
        );
        await sleep(stepPauseAfterNonLlmMs);
      }

      await focusCandidateInTab(tabId, candidate);
      const question = fieldQuestion(candidate);
      await emitProgress(`Field ${i + 1}/${candidates.length}: ${question} — deterministic fill...`, {
        field: candidate,
        phase: "deterministic",
        index: i + 1,
        total: candidates.length
      });
      const deterministic = await tryDeterministicCandidate(tabId, candidate, profile);
      const detAttempts = Array.isArray(deterministic?.attempts) ? deterministic.attempts.slice(0, 20) : [];

      if (deterministic?.ok) {
        if (deterministic.alreadyFilled) alreadyFilled += 1;
        else deterministicFilled += 1;
        const detail = deterministic.alreadyFilled
          ? decisionDetail(["already had value / skip", deterministic.reason, `frames: ${JSON.stringify(detAttempts)}`])
          : decisionDetail(["filled via profile / rules", deterministic.reason, deterministic.profileKey, `frames: ${JSON.stringify(detAttempts)}`]);
        await traceField({
          index: i + 1,
          total: candidates.length,
          description: question,
          value: deterministic.alreadyFilled ? "—" : deterministicValueForLog(profile, deterministic),
          filled: deterministic.alreadyFilled ? "skipped" : "yes",
          approach: deterministic.alreadyFilled ? "deterministic (already set)" : "deterministic",
          field: candidate
        });
        decisions.push({
          fingerprint: candidate.fingerprint,
          field: candidate.name || candidate.elementName || candidate.kind || "field",
          reason: deterministic.reason || "deterministic",
          source: "deterministic",
          profileKey: deterministic.profileKey || "",
          detail
        });
        previousDeterministicFilled = true;
        continue;
      }

      if (stopRequestedByTab.has(tabId)) {
        stopRequestedByTab.delete(tabId);
        const filledCount = deterministicFilled + llmApplied;
        return {
          ok: true,
          stopped: true,
          filledCount,
          deterministicFilled,
          alreadyFilled,
          llmApplied,
          unresolved,
          decisions,
          fieldFillLog,
          timestamp: new Date().toISOString(),
          summary: `Stopped. Filled ${filledCount} field(s): deterministic ${deterministicFilled}, AI ${llmApplied}, unresolved ${unresolved}.`
        };
      }

      if (!aiFallbackEnabled) {
        unresolved += 1;
        const detail = decisionDetail([
          "unresolved: AI fallback disabled",
          `deterministic reason: ${deterministic?.reason || "unknown"}`,
          `per-frame: ${JSON.stringify(detAttempts)}`
        ]);
        await traceField({
          index: i + 1,
          total: candidates.length,
          description: question,
          value: "—",
          filled: "no",
          approach: "unresolved · AI disabled",
          field: candidate
        });
        decisions.push({
          fingerprint: candidate.fingerprint,
          field: candidate.name || candidate.elementName || candidate.kind || "field",
          reason: deterministic?.reason || "deterministic_unresolved_ai_disabled",
          source: "unresolved",
          detail
        });
        rememberUnresolved({
          index: i + 1,
          total: candidates.length,
          question,
          candidate,
          detAttempts,
          deterministicReason: deterministic?.reason || "deterministic_unresolved_ai_disabled"
        });
        previousDeterministicFilled = false;
        continue;
      }

      const candidateKind = String(candidate?.kind || candidate?.type || "").toLowerCase();
      if (candidateKind === "password") {
        unresolved += 1;
        const detail = decisionDetail([
          "unresolved: password fields skip LLM in floating fill",
          `deterministic reason: ${deterministic?.reason || "unknown"}`,
          `per-frame: ${JSON.stringify(detAttempts)}`
        ]);
        await traceField({
          index: i + 1,
          total: candidates.length,
          description: question,
          value: "—",
          filled: "no",
          approach: "unresolved · password (no AI)",
          field: candidate
        });
        decisions.push({
          fingerprint: candidate.fingerprint,
          field: candidate.name || candidate.elementName || candidate.kind || "field",
          reason: deterministic?.reason || "password_no_llm",
          source: "unresolved",
          detail
        });
        rememberUnresolved({
          index: i + 1,
          total: candidates.length,
          question,
          candidate,
          detAttempts,
          deterministicReason: deterministic?.reason || "password_no_llm"
        });
        previousDeterministicFilled = false;
        continue;
      }
      llmQueue.push({
        index: i + 1,
        total: candidates.length,
        question,
        candidate,
        detAttempts,
        deterministicReason: deterministic?.reason || "unknown"
      });
      previousDeterministicFilled = false;
      await traceField({
        index: i + 1,
        total: candidates.length,
        description: question,
        value: "—",
        filled: "no",
        approach: "queued · AI bulk pass",
        field: candidate
      });
    }

    // Pass 2: one bulk LLM request for unresolved (planner + case routing now inside handleFormFieldsLlmBatch).
    if (llmQueue.length) {
      await emitProgress(`Deterministic pass done. Sending ${llmQueue.length} unresolved field(s) to AI (bulk)...`);
      await logFieldFillLlmDebug(
        {
          phase: "before_bulk_llm_batch",
          queued: llmQueue.length,
          fingerprints: llmQueue.map((x) => String(x.candidate?.fingerprint || "").slice(0, 32))
        },
        emitProgress
      );
      const byFp = new Map(
        llmQueue.map((x) => [String(x.candidate?.fingerprint || "").slice(0, 32), x])
      );
      const streamedApplied = new Set();
      let streamApplyChain = Promise.resolve();
      const applyOneGuessOutcome = async (item, guess, { streamed = false } = {}) => {
        if (!item || !guess?.value) return;
        await focusCandidateInTab(tabId, item.candidate);
        await emitProgress(`Field ${item.index}/${item.total}: ${item.question} — applying AI suggestion...`, {
          field: item.candidate,
          phase: streamed ? "llm_apply_stream" : "llm_apply",
          index: item.index,
          total: item.total
        });
        const apply = await applySingleCandidateGuess(tabId, item.candidate, guess);
        const ok = Number(apply?.applied || 0) > 0;
        if (ok) {
          llmApplied += Number(apply?.applied || 0);
          const detail = decisionDetail([
            streamed ? "filled via streamed AI/planner" : "filled via LLM or storage-assisted guess",
            `value: ${String(guess?.value || "").slice(0, 100)}`,
            `source: ${guess?.source || "llm"}`,
            `apply steps: ${(apply?.steps || []).join(" → ")}`
          ]);
          await traceField({
            index: item.index,
            total: item.total,
            description: item.question,
            value: String(guess?.value || "").slice(0, 120),
            filled: "yes",
            approach: guessApproachLabel(guess?.source),
            field: item.candidate
          });
          decisions.push({
            fingerprint: item.candidate?.fingerprint,
            field: item.candidate?.name || item.candidate?.elementName || item.candidate?.kind || "field",
            reason: streamed ? "llm_streamed" : "llm_fallback",
            source: "llm",
            value: String(guess?.value || "").slice(0, 120),
            detail
          });
          streamedApplied.add(String(item.candidate?.fingerprint || "").slice(0, 32));
          return;
        }
        unresolved += 1;
        const detail = decisionDetail([
          streamed ? "unresolved: streamed guess did not apply to DOM" : "unresolved: guess did not apply to DOM",
          `tried value: ${String(guess?.value || "").slice(0, 100)}`,
          `guess source: ${guess?.source || "llm"}`,
          `apply steps: ${(apply?.steps || []).join(" → ")}`,
          apply?.applyError ? `applyError: ${apply.applyError}` : "",
          `deterministic had failed with: ${item.deterministicReason || "unknown"}`,
          `per-frame: ${JSON.stringify(item.detAttempts || [])}`
        ]);
        await traceField({
          index: item.index,
          total: item.total,
          description: item.question,
          value: String(guess?.value || "").slice(0, 120),
          filled: "no",
          approach: apply?.applyError
            ? `unresolved · ${String(apply.applyError).slice(0, 48)}`
            : "unresolved · apply failed",
          field: item.candidate
        });
        decisions.push({
          fingerprint: item.candidate?.fingerprint,
          field: item.candidate?.name || item.candidate?.elementName || item.candidate?.kind || "field",
          reason: streamed ? "llm_stream_apply_failed" : "llm_apply_failed",
          source: "unresolved",
          value: String(guess?.value || "").slice(0, 120),
          detail
        });
        rememberUnresolved(item);
      };
      const llm = await handleFormFieldsLlmBatch({
        tabId,
        domain,
        profile,
        candidates: llmQueue.map((x) => x.candidate),
        onGuess: async (guess) => {
          const item = byFp.get(String(guess?.fingerprint || "").slice(0, 32));
          if (!item || !guess?.value) return;
          streamApplyChain = streamApplyChain
            .then(() => applyOneGuessOutcome(item, guess, { streamed: true }))
            .catch(() => {});
          await Promise.resolve();
        }
      });
      await streamApplyChain;
      const guesses = Array.isArray(llm?.guesses) ? llm.guesses : [];
      const guessByFp = new Map(
        guesses
          .filter((g) => g?.fingerprint)
          .map((g) => [String(g.fingerprint).slice(0, 32), g])
      );
      if (llm?.llmError) {
        await logFieldFillLlmDebug(
          {
            phase: "bulk_llm_error",
            error: String(llm.llmError || "")
          },
          emitProgress
        );
      }

      const applyConcurrency = Math.max(1, Number(options.llmApplyConcurrency || 3) | 0);
      for (let offset = 0; offset < llmQueue.length; offset += applyConcurrency) {
        const chunk = llmQueue.slice(offset, offset + applyConcurrency);
        const outcomes = await Promise.all(chunk.map(async (item) => {
          if (streamedApplied.has(String(item.candidate?.fingerprint || "").slice(0, 32))) {
            return { ...item, alreadyHandled: true };
          }
          const guess = guessByFp.get(String(item.candidate?.fingerprint || "").slice(0, 32));
          if (!guess?.value) {
            return {
              ...item,
              ok: false,
              missingGuess: true
            };
          }
          await focusCandidateInTab(tabId, item.candidate);
          await emitProgress(`Field ${item.index}/${item.total}: ${item.question} — applying AI suggestion...`, {
            field: item.candidate,
            phase: "llm_apply",
            index: item.index,
            total: item.total
          });
          const apply = await applySingleCandidateGuess(tabId, item.candidate, guess);
          return {
            ...item,
            ok: Number(apply?.applied || 0) > 0,
            guess,
            apply
          };
        }));
        for (const out of outcomes) {
          if (out.alreadyHandled) continue;
          if (out.ok) {
            llmApplied += Number(out.apply?.applied || 0);
            const detail = decisionDetail([
              "filled via LLM or storage-assisted guess",
              `value: ${String(out.guess?.value || "").slice(0, 100)}`,
              `source: ${out.guess?.source || "llm"}`,
              `apply steps: ${(out.apply?.steps || []).join(" → ")}`
            ]);
            await traceField({
              index: out.index,
              total: out.total,
              description: out.question,
              value: String(out.guess?.value || "").slice(0, 120),
              filled: "yes",
              approach: guessApproachLabel(out.guess?.source),
              field: out.candidate
            });
            decisions.push({
              fingerprint: out.candidate?.fingerprint,
              field: out.candidate?.name || out.candidate?.elementName || out.candidate?.kind || "field",
              reason: "llm_fallback",
              source: "llm",
              value: String(out.guess?.value || "").slice(0, 120),
              detail
            });
            continue;
          }
          unresolved += 1;
          if (out.missingGuess) {
            const detail = decisionDetail([
              "unresolved: no value from LLM / storage merge",
              `deterministic reason: ${out.deterministicReason || "unknown"}`,
              llm?.llmError ? `llmError: ${llm.llmError}` : "",
              `guess count: ${guesses.length}`,
              `per-frame: ${JSON.stringify(out.detAttempts || [])}`
            ]);
            await traceField({
              index: out.index,
              total: out.total,
              description: out.question,
              value: "—",
              filled: "no",
              approach: llm?.llmError
                ? `unresolved · ${String(llm.llmError).slice(0, 56)}`
                : "unresolved · no AI guess",
              field: out.candidate
            });
            decisions.push({
              fingerprint: out.candidate?.fingerprint,
              field: out.candidate?.name || out.candidate?.elementName || out.candidate?.kind || "field",
              reason: llm?.llmError ? "llm_error" : out.deterministicReason || "no_llm_guess",
              source: "unresolved",
              detail
            });
            rememberUnresolved(out);
            continue;
          }
          const detail = decisionDetail([
            "unresolved: guess did not apply to DOM",
            `tried value: ${String(out.guess?.value || "").slice(0, 100)}`,
            `guess source: ${out.guess?.source || "llm"}`,
            `apply steps: ${(out.apply?.steps || []).join(" → ")}`,
            out.apply?.applyError ? `applyError: ${out.apply.applyError}` : "",
            `deterministic had failed with: ${out.deterministicReason || "unknown"}`,
            `per-frame: ${JSON.stringify(out.detAttempts || [])}`
          ]);
          await traceField({
            index: out.index,
            total: out.total,
            description: out.question,
            value: String(out.guess?.value || "").slice(0, 120),
            filled: "no",
            approach: out.apply?.applyError
              ? `unresolved · ${String(out.apply.applyError).slice(0, 48)}`
              : "unresolved · apply failed",
            field: out.candidate
          });
          decisions.push({
            fingerprint: out.candidate?.fingerprint,
            field: out.candidate?.name || out.candidate?.elementName || out.candidate?.kind || "field",
            reason: "llm_apply_failed",
            source: "unresolved",
            value: String(out.guess?.value || "").slice(0, 120),
            detail
          });
          rememberUnresolved(out);
        }
      }
    }

    // Pass 3: troubleshoot unresolved fields one by one (probe + targeted AI retry).
    if (unresolvedQueue.length && aiFallbackEnabled) {
      await emitProgress(`Troubleshooting ${unresolvedQueue.length} unresolved field(s) one by one...`, {
        phase: "fill_troubleshoot_start",
        unresolved: unresolvedQueue.length
      });
      for (const item of unresolvedQueue) {
        const fingerprint = String(item?.candidate?.fingerprint || "").slice(0, 32);
        if (!fingerprint) continue;
        const question = String(item?.question || fieldQuestion(item?.candidate)).slice(0, 140);
        await focusCandidateInTab(tabId, item.candidate);
        const probe = await probeCandidateFillFailure(tabId, item.candidate);
        const probeSummary = [
          probe?.found === false ? `probe:${probe?.reason || "not_found"}` : "",
          probe?.isVisible === false ? "hidden" : "",
          probe?.isDisabled ? "disabled" : "",
          Number(probe?.optionCount || 0) <= 0 &&
            (String(item?.candidate?.kind || "").toLowerCase() === "select" ||
             String(item?.candidate?.kind || "").toLowerCase() === "radio" ||
             String(item?.candidate?.kind || "").toLowerCase() === "checkbox")
            ? "no_options_visible"
            : "",
          Array.isArray(probe?.optionPreview) && probe.optionPreview.length
            ? `options:${probe.optionPreview.join(" | ").slice(0, 180)}`
            : ""
        ].filter(Boolean).join(" — ");

        await emitProgress(
          `Troubleshoot field ${item.index}/${item.total}: ${question}...`,
          { phase: "fill_troubleshoot_field", index: item.index, total: item.total, field: item.candidate }
        );

        const retry = await handleFormFieldsLlmBatch({
          tabId,
          domain,
          profile,
          candidates: [item.candidate]
        });
        const retryGuess = Array.isArray(retry?.guesses)
          ? retry.guesses.find((g) => String(g?.fingerprint || "").slice(0, 32) === fingerprint && String(g?.value || "").trim())
          : null;

        if (retryGuess?.value) {
          const apply = await applySingleCandidateGuess(tabId, item.candidate, retryGuess);
          if (Number(apply?.applied || 0) > 0) {
            llmApplied += Number(apply?.applied || 0);
            troubleshootingRecovered += 1;
            unresolved = Math.max(0, unresolved - 1);
            await traceField({
              index: item.index,
              total: item.total,
              description: question,
              value: String(retryGuess.value || "").slice(0, 120),
              filled: "yes",
              approach: "llm retry (troubleshoot)",
              field: item.candidate
            });
            decisions.push({
              fingerprint: item.candidate?.fingerprint,
              field: item.candidate?.name || item.candidate?.elementName || item.candidate?.kind || "field",
              reason: "llm_troubleshoot_recovered",
              source: "llm",
              value: String(retryGuess.value || "").slice(0, 120),
              detail: decisionDetail([
                "resolved in per-field troubleshooting",
                `retry source: ${retryGuess.source || "llm"}`,
                `apply steps: ${(apply?.steps || []).join(" → ")}`,
                probeSummary
              ])
            });
            continue;
          }
        }

        decisions.push({
          fingerprint: item.candidate?.fingerprint,
          field: item.candidate?.name || item.candidate?.elementName || item.candidate?.kind || "field",
          reason: "troubleshoot_unresolved",
          source: "unresolved",
          detail: decisionDetail([
            "still unresolved after per-field troubleshooting",
            retry?.llmError ? `retry llmError: ${retry.llmError}` : "",
            !retryGuess?.value ? "retry returned no value" : "retry value could not apply",
            probeSummary
          ])
        });
      }
    }

    let resumeAttached = false;
    try {
      resumeAttached = await tryAttachStoredResume(tabId);
    } catch {
      /* ignore */
    }
    if (resumeAttached) {
      await emitProgress("Attached your stored resume to the file upload on this page.", {
        phase: "resume_upload",
        attached: true
      });
      logFieldFillLine(`${FIELD_FILL_LOG_PREFIX} resume · attached from chrome.storage (userContent.files.resumePdf)`);
    }

    const filledCount = deterministicFilled + llmApplied;
    const baseSummary = `Filled ${filledCount} field(s): deterministic ${deterministicFilled}, AI ${llmApplied}${aiFallbackEnabled ? "" : " (off)"}, unresolved ${unresolved}${troubleshootingRecovered ? `, recovered ${troubleshootingRecovered} in troubleshooting` : ""}.`;
    return {
      filledCount,
      deterministicFilled,
      alreadyFilled,
      llmApplied,
      unresolved,
      troubleshootingRecovered,
      decisions,
      fieldFillLog,
      resumeAttached,
      timestamp: new Date().toISOString(),
      summary: resumeAttached ? `${baseSummary} Resume file attached from storage.` : baseSummary
    };
  }

  async function prepareFillContext(sender, options = {}) {
    const tabId = sender?.tab?.id;
    const tabUrl = sender?.tab?.url;
    if (!tabId || !tabUrl) return { ok: false, error: "No active tab context." };
    const key = preparedContextKey(tabId, tabUrl);
    const existing = preparedFillContextByTab.get(key);
    if (!options.force && isPreparedContextFresh(existing)) {
      return {
        ok: true,
        prepared: true,
        cached: true,
        fieldCount: existing.candidates.length,
        preparedAt: existing.preparedAt
      };
    }

    const profile = await getProfileForFill();
    const domain = new URL(tabUrl).hostname;
    const resumeRecord = await getLocal(KEYS.resumeRecord, null);
    const { desiredEducationRows, desiredExperienceRows } = desiredRepeatRowsFromResume(resumeRecord);
    // Snapshot first so `__browserToolRefs` is populated when we build the queue (`snapshotRef` matches card refs).
    const snapshotCapture = await captureDomThenSnapshot(tabId).catch(() => null);
    const candidatesRaw = await collectFieldFillQueue(tabId);
    const snapshotScan = snapshotCapture?.ok
      ? parseSnapshotFields({
        url: snapshotCapture.url || tabUrl,
        title: snapshotCapture.title || "",
        snapshotText: snapshotCapture.snapshot_text || ""
      })
      : null;
    const snapshotFields = Array.isArray(snapshotScan?.domFields) ? snapshotScan.domFields : [];
    const merged = enrichCandidatesWithSnapshotFields(candidatesRaw, snapshotFields);
    const candidates = await resolveSnapshotCardLabelsForFill(tabId, merged, snapshotFields);
    const context = {
      tabId,
      tabUrl,
      domain,
      profile,
      desiredEducationRows,
      desiredExperienceRows,
      candidates,
      snapshotFields,
      preparedAt: Date.now()
    };
    preparedFillContextByTab.set(key, context);
    return {
      ok: true,
      prepared: true,
      cached: false,
      fieldCount: candidates.length,
      preparedAt: context.preparedAt
    };
  }

  async function handleFloatingBarStop(sender) {
    const tabId = sender?.tab?.id;
    if (!tabId) return { ok: false, error: "No active tab context." };
    stopRequestedByTab.add(tabId);
    return { ok: true, stopped: true };
  }

  async function getPreparedFillContext(sender) {
    const tabId = sender?.tab?.id;
    const tabUrl = sender?.tab?.url;
    if (!tabId || !tabUrl) return null;
    const key = preparedContextKey(tabId, tabUrl);
    const existing = preparedFillContextByTab.get(key);
    if (isPreparedContextFresh(existing)) {
      if (
        Array.isArray(existing?.candidates) &&
        existing.candidates.some((c) => !String(c?.cardLabel || "").trim()) &&
        Array.isArray(existing?.snapshotFields) &&
        existing.snapshotFields.length
      ) {
        const labeled = await resolveSnapshotCardLabelsForFill(tabId, existing.candidates, existing.snapshotFields);
        const next = { ...existing, candidates: labeled };
        preparedFillContextByTab.set(key, next);
        return next;
      }
      return existing;
    }
    await prepareFillContext(sender, { force: true });
    return preparedFillContextByTab.get(key) || null;
  }

  async function handleFloatingBarFill(sender, payload = {}) {
    const tabId = sender?.tab?.id;
    const tabUrl = sender?.tab?.url;
    if (!tabId || !tabUrl) return { ok: false, error: "No active tab context." };
    stopRequestedByTab.delete(tabId);
    const sendProgress = async (text, detail = {}) => {
      try {
        await chrome.tabs.sendMessage(tabId, {
          type: "FLOATING_BAR_PROGRESS",
          text: String(text || ""),
          ...detail
        });
      } catch {
        // ignore progress delivery failures
      }
    };
    const prepared = await getPreparedFillContext(sender);
    if (!prepared) return { ok: false, error: "Could not prepare fill context." };
    await sendProgress("Starting field-by-field fill…");
    const merged = await runFieldByFieldFill(tabId, prepared.profile, prepared.domain, {
      onProgress: sendProgress,
      desiredEducationRows: prepared.desiredEducationRows,
      desiredExperienceRows: prepared.desiredExperienceRows,
      candidates: prepared.candidates,
      aiFallbackEnabled: payload?.aiFallbackEnabled !== false
    });
    const platformLabel = merged.pageSetup?.platformLabel || merged.pageSetup?.label || "";
    const result = {
      filledCount: merged.filledCount,
      decisions: merged.decisions,
      fieldFillLog: merged.fieldFillLog || [],
      unresolved: merged.unresolved,
      timestamp: merged.timestamp,
      mode: "fill",
      agentHint: merged.summary,
      diagnosis: merged.diagnosis,
      missingNotes: merged.missingNotes,
      deterministicFilled: merged.deterministicFilled ?? 0,
      llmApplied: merged.llmApplied ?? 0,
      troubleshootingRecovered: merged.troubleshootingRecovered ?? 0,
      llmNote: merged.llmNote || "",
      platform: merged.pageSetup?.platform || "",
      platformLabel,
      agentTrace: merged.agentTrace,
      diagnostics: merged.diagnostics
    };
    preparedFillContextByTab.delete(preparedContextKey(tabId, tabUrl));
    return {
      ok: true,
      filledCount: result.filledCount || 0,
      summary: merged.summary || "Done.",
      fieldFillLog: result.fieldFillLog || [],
      fillReport: {
        filledCount: Number(result.filledCount || 0),
        deterministicFilled: Number(result.deterministicFilled || 0),
        llmApplied: Number(result.llmApplied || 0),
        troubleshootingRecovered: Number(result.troubleshootingRecovered || 0),
        unresolved: Number(result.unresolved || 0),
        decisions: Array.isArray(result.decisions) ? result.decisions : [],
        fieldFillLog: Array.isArray(result.fieldFillLog) ? result.fieldFillLog : [],
        timestamp: result.timestamp || new Date().toISOString(),
        summary: merged.summary || "Done."
      }
    };
  }

  async function handleFloatingBarTrustedDropdown(sender, payload) {
    const tabId = sender?.tab?.id;
    if (!tabId) return { ok: false, error: "No active tab context." };
    const guesses = Array.isArray(payload?.guesses) ? payload.guesses : [];
    if (!guesses.length) return { ok: false, error: "No dropdown guesses provided." };
    const progress = async (text) => {
      try {
        await chrome.tabs.sendMessage(tabId, { type: "FLOATING_BAR_PROGRESS", text: String(text || "") });
      } catch {
        // ignore progress delivery failures
      }
    };
    const result = await applyTrustedDropdownGuesses(tabId, guesses, progress);
    return { ok: Number(result?.applied || 0) > 0, applied: Number(result?.applied || 0) };
  }

  async function handleFloatingBarClear(sender) {
    const tabId = sender?.tab?.id;
    if (!tabId) return { ok: false, error: "No active tab context." };
    const rows = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        const clear = globalThis.__clearFormFillerFields;
        return typeof clear === "function" ? clear() : 0;
      }
    });
    const clearedCount = rows.reduce((sum, row) => sum + Number(row?.result || 0), 0);
    return {
      ok: true,
      clearedCount,
      summary: `Cleared ${clearedCount} field(s).`
    };
  }

  function readSnapshotFromPayload(payload = {}, tabUrl = "") {
    const source = payload?.snapshot && typeof payload.snapshot === "object" ? payload.snapshot : payload;
    const snapshotText = String(source?.snapshot_text || source?.snapshotText || "");
    if (!snapshotText) return null;
    return {
      url: String(source?.url || tabUrl || ""),
      requested_url: String(source?.requested_url || tabUrl || ""),
      title: String(source?.title || ""),
      domOutline: String(source?.domOutline || source?.dom_outline || ""),
      snapshot_text: snapshotText,
      snapshot_source: String(source?.snapshot_source || source?.snapshotSource || "provided_snapshot"),
      timings: source?.timings || {}
    };
  }

  async function handleParseSnapshotRules(sender, payload = {}) {
    const started = Date.now();
    const tabId = Number(payload?.tabId || sender?.tab?.id || 0);
    const tabUrl = String(payload?.tabUrl || sender?.tab?.url || "");
    const providedSnapshot = readSnapshotFromPayload(payload, tabUrl);
    const usedProvidedSnapshot = !!providedSnapshot;
    let snapshot = providedSnapshot;
    if (!snapshot) {
      if (!tabId || !tabUrl) return { ok: false, error: "No active tab context." };
      const captured = await captureDomThenSnapshot(tabId);
      if (!captured.ok) return captured;
      snapshot = {
        url: String(captured.url || tabUrl || ""),
        requested_url: tabUrl,
        title: String(captured.title || ""),
        domOutline: String(captured.domOutline || ""),
        snapshot_text: String(captured.snapshot_text || ""),
        snapshot_source: String(captured.snapshot_source || "extension_browser_snapshot"),
        timings: captured.timings || {}
      };
    }
    const parsedFieldScan = parseSnapshotFields({
      url: snapshot.url || "",
      title: snapshot.title || "",
      snapshotText: snapshot.snapshot_text || ""
    });
    const snapshotFields = Array.isArray(parsedFieldScan.domFields) ? parsedFieldScan.domFields : [];
    const normalizedParsedFieldScan = {
      ok: !!parsedFieldScan?.ok,
      error: parsedFieldScan?.error || "",
      viewTitle: "Fields To Fill",
      domFields: snapshotFields,
      fieldCount: snapshotFields.length,
      stats: parsedFieldScan?.stats || {}
    };
    const rulesMs = Date.now() - started;
    return {
      ok: true,
      summary: `${snapshotFields.length} visible field(s) are found`,
      snapshot,
      scan: {
        url: snapshot.url || "",
        requested_url: snapshot.requested_url || "",
        title: snapshot.title || "",
        viewTitle: "Fields To Fill",
        domOutline: snapshot.domOutline || "",
        snapshot_text: snapshot.snapshot_text || "",
        snapshot_source: snapshot.snapshot_source || "extension_browser_snapshot",
        parsedFieldScan: normalizedParsedFieldScan,
        experiment_features: {
          parseMode: "rules",
          usedProvidedSnapshot
        },
        timings: {
          dom_capture_ms: Number(snapshot?.timings?.dom_capture_ms || 0),
          snapshot_capture_ms: Number(snapshot?.timings?.snapshot_capture_ms || 0),
          rules_ms: Date.now() - started
        }
      }
    };
  }

  async function handleParseSnapshotLlm(sender, payload = {}) {
    const started = Date.now();
    const mode = String(payload?.mode || "chunked").toLowerCase();
    if (mode !== "chunked") {
      return { ok: false, error: "SNAPSHOT_PARSE_LLM currently supports only mode='chunked'." };
    }
    const unfilledOnly = !!(payload?.unfilledOnly || payload?.unfilled_only);
    const tabId = Number(payload?.tabId || sender?.tab?.id || 0);
    const tabUrl = String(payload?.tabUrl || sender?.tab?.url || "");
    const providedSnapshot = readSnapshotFromPayload(payload, tabUrl);
    const usedProvidedSnapshot = !!providedSnapshot;
    let snapshot = providedSnapshot;
    if (!snapshot) {
      if (!tabId || !tabUrl) return { ok: false, error: "No active tab context." };
      const captured = await captureDomThenSnapshot(tabId);
      if (!captured.ok) return captured;
      snapshot = {
        url: String(captured.url || tabUrl || ""),
        requested_url: tabUrl,
        title: String(captured.title || ""),
        domOutline: String(captured.domOutline || ""),
        snapshot_text: String(captured.snapshot_text || ""),
        snapshot_source: String(captured.snapshot_source || "extension_browser_snapshot"),
        timings: captured.timings || {}
      };
    }
    const baseTimings = {
      dom_capture_ms: Number(snapshot?.timings?.dom_capture_ms || 0),
      snapshot_capture_ms: Number(snapshot?.timings?.snapshot_capture_ms || 0)
    };

    const llmStart = Date.now();
    const chunkedAi = await parseSnapshotFieldsWithLLMChunked({
      url: snapshot.url || "",
      title: snapshot.title || "",
      snapshotText: snapshot.snapshot_text || "",
      unfilledOnly
    }).catch((error) => ({
      ok: false,
      error: error instanceof Error ? error.message : String(error || "Chunked LLM scan failed.")
    }));
    const chunkedScan = {
      ok: !!chunkedAi?.ok,
      error: chunkedAi?.error || "",
      viewTitle: "Fields To Fill (Chunked LLM)",
      domFields: Array.isArray(chunkedAi?.domFields) ? chunkedAi.domFields : [],
      fieldCount: Array.isArray(chunkedAi?.domFields) ? chunkedAi.domFields.length : 0,
      stats: chunkedAi?.stats || {}
    };
    return {
      ok: !!chunkedAi.ok,
      error: chunkedAi.error || "",
      summary: chunkedAi.ok
        ? `Chunked LLM scan found ${Array.isArray(chunkedAi.fields) ? chunkedAi.fields.length : 0} ${unfilledOnly ? "unfilled" : "visible"} field(s).`
        : chunkedAi.error || "Chunked LLM scan failed.",
      snapshot,
      scan: {
        ...chunkedScan,
        chunks: Array.isArray(chunkedAi?.chunks) ? chunkedAi.chunks : [],
        unfilledOnly,
        unfilled_only: unfilledOnly,
        url: snapshot.url || "",
        requested_url: snapshot.requested_url || "",
        title: snapshot.title || "",
        domOutline: snapshot.domOutline || "",
        dom_outline: snapshot.domOutline || "",
        snapshot_text: snapshot.snapshot_text || "",
        snapshot_source: snapshot.snapshot_source || "extension_browser_snapshot",
        experiment_features: {
          parseMode: "llm_chunked",
          usedProvidedSnapshot,
          unfilledOnly
        },
        timings: {
          ...baseTimings,
          llm_ms: Date.now() - llmStart,
          total_ms: Date.now() - started
        }
      }
    };
  }

  return {
    prepareFillContext,
    handleFloatingBarStop,
    handleFloatingBarFill,
    handleFloatingBarTrustedDropdown,
    handleFloatingBarClear,
    handleParseSnapshotRules,
    handleParseSnapshotLlm
  };
}
