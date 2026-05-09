import { getFieldHints } from "../applicant-data/storage.js";

const MAX_HINTS_INJECTED = 1200;

export async function buildStoredFieldHintsList(domain) {
  if (!domain) return [];
  const all = await getFieldHints();
  const byKey = new Map();
  for (const h of all) {
    if (!h || h.domain !== domain) continue;
    const corrected = String(h.correctedValue ?? "").trim();
    const value = String(h.value ?? "").trim();
    const last = String(h.lastGuessedValue ?? "").trim();
    const fromAnswers = Array.isArray(h.answerValues)
      ? String(h.answerValues.find((x) => String(x || "").trim()) || "").trim()
      : "";
    const v = corrected || value || last || fromAnswers;
    if (!v) continue;
    // Skip internal system IDs (UUIDs) — these are Workday/ATS option identifiers,
    // not human-readable field values. Injecting them causes cascading API failures.
    if (/^[0-9a-f]{32}$/i.test(v) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) continue;
    const fps = Array.isArray(h.fingerprints) ? h.fingerprints : [];
    const allFingerprints = [...fps, h.fingerprint].filter(Boolean);
    for (const fp of allFingerprints) {
      byKey.set(`fp:${fp}`, {
        ...h,
        fingerprint: fp,
        questionKey: h.questionKey || "",
        learnedAliases: Array.isArray(h.learnedAliases) ? h.learnedAliases : [],
        value: v
      });
    }
    if (h.questionKey) {
      byKey.set(`q:${h.questionKey}`, {
        ...h,
        questionKey: h.questionKey,
        learnedAliases: Array.isArray(h.learnedAliases) ? h.learnedAliases : [],
        value: v
      });
    }
  }
  return Array.from(byKey.values()).slice(0, MAX_HINTS_INJECTED);
}
