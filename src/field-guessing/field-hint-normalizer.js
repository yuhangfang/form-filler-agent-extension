import { OPENAI_API_KEY } from "../env.secret.js";

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

function safeParseJson(content) {
  try {
    return JSON.parse(content);
  } catch (_e) {
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) return null;
    try {
      return JSON.parse(content.slice(start, end + 1));
    } catch (_e2) {
      return null;
    }
  }
}

/**
 * Normalize noisy learned field hints before persistence.
 * @param {{ domain: string, entries: { fingerprint: string, context?: string, value?: string, canonicalKey?: string }[] }} input
 * @returns {Promise<{ ok: boolean, normalized?: { fingerprint: string, canonicalKey: string, shortLabel: string, value: string }[], error?: string }>}
 */
export async function simplifyFieldHintsForStorage({ domain, entries }) {
  const apiKey = (OPENAI_API_KEY || "").trim();
  if (!apiKey) return { ok: false, error: "No OPENAI_API_KEY" };
  if (!Array.isArray(entries) || !entries.length) return { ok: true, normalized: [] };

  const trimmed = entries.slice(0, 40).map((e) => ({
    fingerprint: String(e.fingerprint || "").slice(0, 32),
    context: String(e.context || "").slice(0, 700),
    value: String(e.value || "").slice(0, 500),
    canonicalKey: String(e.canonicalKey || "").slice(0, 80)
  })).filter((e) => e.fingerprint);
  if (!trimmed.length) return { ok: true, normalized: [] };

  const body = {
    model: "gpt-4o-mini",
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `You normalize learned form-field memory before storage.
Return one JSON object: { "normalized": [ { "fingerprint": string, "canonicalKey": string, "shortLabel": string, "value": string } ] }.
Rules:
- Return exactly one object per input fingerprint.
- canonicalKey: stable camelCase semantic key (e.g. workAuthorization, veteranStatus, ethnicity, gender, desiredSalary).
- shortLabel: short human-readable label, 2-6 words, no IDs, no boilerplate.
- value: clean user-facing answer only. Remove duplicated joins like "Female|Female", "x x", repeated phrases, and long legal/boilerplate tails. Keep the intended answer unchanged.
- Do not invent facts; if uncertain keep the original value trimmed.
- Use empty strings only when the input value is empty.`
      },
      {
        role: "user",
        content: `Host: ${domain}\nEntries:\n${JSON.stringify(trimmed)}`
      }
    ]
  };

  const response = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    return { ok: false, error: payload?.error?.message || `OpenAI HTTP ${response.status}` };
  }
  const content = payload?.choices?.[0]?.message?.content;
  if (!content || typeof content !== "string") {
    return { ok: false, error: "Empty OpenAI response" };
  }
  const parsed = safeParseJson(content);
  const normalized = Array.isArray(parsed?.normalized) ? parsed.normalized : null;
  if (!normalized) {
    return { ok: false, error: "Could not parse normalize JSON" };
  }

  const out = normalized
    .map((n) => ({
      fingerprint: String(n?.fingerprint || "").slice(0, 32),
      canonicalKey: String(n?.canonicalKey || "").trim(),
      shortLabel: String(n?.shortLabel || "").trim(),
      value: String(n?.value || "").trim()
    }))
    .filter((n) => n.fingerprint);

  return { ok: true, normalized: out };
}
