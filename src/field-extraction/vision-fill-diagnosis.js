import { OPENAI_API_KEY } from "../env.secret.js";

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

function safeParseJson(content) {
  try {
    return JSON.parse(content);
  } catch (_error) {
    const start = String(content || "").indexOf("{");
    const end = String(content || "").lastIndexOf("}");
    if (start < 0 || end < 0 || end <= start) return null;
    try {
      return JSON.parse(String(content).slice(start, end + 1));
    } catch (_error2) {
      return null;
    }
  }
}

function compactField(field) {
  const label = String(field?.label || field?.field_label || field?.name || "").trim().slice(0, 180);
  const type = String(field?.type || field?.field_type || "unknown").trim().slice(0, 60) || "unknown";
  if (!label) return "";
  return `${label} (${type})`;
}

function normalizeDiagnosisPayload(parsed) {
  const out = parsed && typeof parsed === "object" ? parsed : {};
  const rawMissing = Array.isArray(out.missingFields)
    ? out.missingFields
    : Array.isArray(out.missingFromExtraction)
      ? out.missingFromExtraction.map((x) => (typeof x === "string" ? x : x?.label || x?.field || ""))
      : [];
  const missingFields = rawMissing
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .slice(0, 20);
  const actions = Array.isArray(out.actions)
    ? out.actions
      .map((item) => {
        const tool = String(item?.tool || "").trim().slice(0, 80);
        const input = item?.input && typeof item.input === "object" ? item.input : {};
        if (!tool) return null;
        return { tool, input };
      })
      .filter(Boolean)
      .slice(0, 8)
    : [];
  return {
    missingFields,
    actions
  };
}

export function formatDiagnosisReport(diagnosis) {
  const d = diagnosis && typeof diagnosis === "object" ? diagnosis : {};
  const lines = [];
  lines.push("Missing fields:");
  if (Array.isArray(d.missingFields) && d.missingFields.length) {
    for (const field of d.missingFields) {
      lines.push(`- ${String(field || "").trim()}`);
    }
  } else {
    lines.push("- None");
  }
  lines.push("");
  lines.push("Actions (tool + input):");
  if (Array.isArray(d.actions) && d.actions.length) {
    for (const action of d.actions) {
      const tool = String(action?.tool || "").trim();
      const input = action?.input && typeof action.input === "object" ? action.input : {};
      lines.push(`- ${tool}: ${JSON.stringify(input)}`);
    }
  } else {
    lines.push("- None");
  }
  return lines.join("\n");
}

export async function diagnoseFieldsAgainstScreenshot(input) {
  const apiKey = (OPENAI_API_KEY || "").trim();
  if (!apiKey) return { ok: false, error: "No OPENAI_API_KEY (run npm run sync-env after filling .env.local)" };

  const {
    screenshotDataUrl = "",
    extractedFields = [],
    operatorMessage = "",
    chatHistory = []
  } = input || {};

  if (!screenshotDataUrl) return { ok: false, error: "Screenshot is required for diagnosis." };

  const compactFields = Array.isArray(extractedFields)
    ? extractedFields.slice(0, 200).map(compactField).filter(Boolean)
    : [];
  const compactChatHistory = Array.isArray(chatHistory)
    ? chatHistory
      .slice(-12)
      .map((item) => ({
        role: String(item?.role || "").slice(0, 20),
        content: String(item?.content || "").slice(0, 1200)
      }))
      .filter((item) => item.role && item.content)
    : [];
  const operatorNote = String(operatorMessage || "").trim();

  const instructions = `You are diagnosing only field-detection failures for a job-application page.
Compare the screenshot against extracted fields.
Treat each visible prompt + answer control pair as a field candidate.
Use exact screenshot wording for missing fields (no paraphrase).
Return strict JSON:
{
  "missingFields": [
    "exact field wording from screenshot"
  ],
  "actions": [
    { "tool": "tool_name", "input": { "key": "value" } }
  ]
}
Rules:
- Focus only on detection/extraction gaps.
- Only include missing fields that are clearly visible in screenshot but absent in extracted fields list.
- actions must be executable next steps for debugging detection misses.
- Each action must be a concrete (tool, input) pair.
- If no action is needed, return an empty actions array.
- Do not output markdown.`;

  const contextText = [
    `Extracted fields (label (type)):\n${compactFields.map((x) => `- ${x}`).join("\n") || "- (none)"}`,
    compactChatHistory.length ? `Recent chat:\n${JSON.stringify(compactChatHistory)}` : "",
    operatorNote ? `Operator message:\n${operatorNote}` : ""
  ].filter(Boolean).join("\n\n");

  const response = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: instructions
        },
        {
          role: "user",
          content: [
            { type: "text", text: contextText },
            { type: "image_url", image_url: { url: screenshotDataUrl } }
          ]
        }
      ]
    })
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    return { ok: false, error: payload?.error?.message || `OpenAI HTTP ${response.status}` };
  }
  const content = payload?.choices?.[0]?.message?.content;
  if (!content || typeof content !== "string") return { ok: false, error: "Empty diagnosis response." };
  const parsed = safeParseJson(content);
  if (!parsed) return { ok: false, error: "Could not parse diagnosis JSON." };
  const diagnosis = normalizeDiagnosisPayload(parsed);
  return {
    ok: true,
    diagnosis,
    reportText: formatDiagnosisReport(diagnosis),
    llmContextText: contextText
  };
}
