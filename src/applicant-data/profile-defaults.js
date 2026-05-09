/** No fallback demo profile values. */
export const DEFAULT_QUICK_PROFILE = {};

/**
 * @param {Record<string, unknown>} stored — raw profile from storage (may be sparse).
 * @returns {Record<string, unknown>} normalized saved profile for fill/evaluate paths only.
 */
export function mergeProfileWithDefaults(stored) {
  const s = stored && typeof stored === "object" ? stored : {};
  const out = {};
  for (const k of Object.keys(s)) {
    if (k === "registerPassword") continue;
    const value = s[k];
    if (typeof value === "string") {
      out[k] = value.trim();
      continue;
    }
    if (value !== undefined && value !== null) out[k] = value;
  }
  out.registerPassword = String(s.registerPassword ?? "");
  return out;
}
