import { OPENAI_API_KEY } from "../env.secret.js";

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

/** Shown in diagnose-chat system prompt so the model maps artifacts to the extraction stack. */
const DIAGNOSE_CHAT_PIPELINE_GUIDE = `Ordered field-extraction pipeline (each step consumes the previous):

1) Raw page — The live document in the browser: HTML/CSS/JS rendered into a real DOM. This is the source of truth for what exists on disk vs what the engine actually built.

2) DOM — The document object model (full tree in memory). The "DOM outline" you may see here is only a compact excerpt (tags, key attributes, hierarchy) for debugging—not the entire DOM.

3) Browser snapshot — A serialized accessibility-style tree (e.g. Playwright / ARIA-oriented YAML-like text: roles, names, states). It is produced from the live page/DOM via the browser's accessibility layer, not from raw HTML text alone. This snapshot text is the structured input the extension feeds to its parser.

4) Parsed / extracted fields — Output of the rule-based snapshot parser: candidate form fields (labels, types, control hints) after walking the snapshot string. Nothing in this list was read directly from raw HTML in this pipeline; it came from snapshot → rules.

Optional cross-check: a screenshot is a raster of the same rendered page (parallel to step 1). Use it to verify visible wording or layout when snapshot vs user perception disagrees.

When debugging, trace backward from a wrong or missing extracted field: parsed fields → parser rules → snapshot text → DOM/render → raw page (and screenshot for human-visible copy).`;

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
  return { missingFields };
}

export async function diagnoseFieldsAgainstScreenshot(input) {
  const apiKey = (OPENAI_API_KEY || "").trim();
  if (!apiKey) return { ok: false, error: "No OPENAI_API_KEY (run npm run sync-env after filling .env.local)" };

  const { screenshotDataUrl = "", extractedFields = [] } = input || {};

  const compactFields = Array.isArray(extractedFields)
    ? extractedFields.slice(0, 200).map(compactField).filter(Boolean)
    : [];

  const instructions = `You are diagnosing only field-detection failures for a job-application page.
Compare the screenshot against the extracted fields list.
Treat each visible prompt + answer control pair as a field candidate.
Use exact screenshot wording for missing fields (no paraphrase).
Return strict JSON:
{
  "missingFields": [
    "exact field wording from screenshot"
  ]
}
Rules:
- Focus only on detection/extraction gaps.
- Only include missing fields that are clearly visible in the screenshot but absent from the extracted fields list.
- Do not output markdown.`;

  const contextText = compactFields.length
    ? `Extracted fields (label (type)):\n${compactFields.map((x) => `- ${x}`).join("\n")}`
    : "Extracted fields: (none)";

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
          content: screenshotDataUrl
            ? [
                { type: "text", text: contextText },
                { type: "image_url", image_url: { url: screenshotDataUrl } }
              ]
            : contextText
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
  return { ok: true, diagnosis };
}

export async function runDiagnoseChat({ screenshotDataUrl, extractedFields, snapshotText, domOutline, step2Briefs, userMessage, chatHistory }) {
  const apiKey = (OPENAI_API_KEY || "").trim();
  if (!apiKey) return { ok: false, error: "No OPENAI_API_KEY configured." };
  if (!userMessage) return { ok: false, error: "No message provided." };

  const compactFields = Array.isArray(extractedFields)
    ? extractedFields.slice(0, 200).map(compactField).filter(Boolean)
    : [];

  const contextParts = [
    compactFields.length ? `Extracted fields:\n${compactFields.map(x => `- ${x}`).join("\n")}` : "",
    snapshotText ? `Browser Snapshot:\n${snapshotText.slice(0, 6000)}` : "",
    domOutline ? `DOM Outline:\n${domOutline.slice(0, 4000)}` : "",
    step2Briefs ? `Step 2 code gap analysis:\n${step2Briefs}` : ""
  ].filter(Boolean).join("\n\n");

  const priorMessages = Array.isArray(chatHistory)
    ? chatHistory.slice(-12).map(item => ({
        role: item.role === "assistant" ? "assistant" : "user",
        content: String(item.content || "").slice(0, 1200)
      })).filter(item => item.content)
    : [];

  const userContent = screenshotDataUrl
    ? [{ type: "text", text: userMessage }, { type: "image_url", image_url: { url: screenshotDataUrl } }]
    : userMessage;

  const systemContent = [
    "You are a debugging assistant for form-filling and field-extraction bugs in a browser extension.",
    "",
    DIAGNOSE_CHAT_PIPELINE_GUIDE,
    "",
    "Use the optional context blocks below, the conversation, and any attached screenshot to give concise, actionable answers (what to change in parser code or what evidence proves a gap).",
    contextParts ? `\nContext:\n${contextParts}` : ""
  ].join("\n");

  const response = await fetch(OPENAI_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o",
      temperature: 0,
      messages: [
        {
          role: "system",
          content: systemContent
        },
        ...priorMessages,
        { role: "user", content: userContent }
      ]
    })
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) return { ok: false, error: payload?.error?.message || `OpenAI HTTP ${response.status}` };
  const text = payload?.choices?.[0]?.message?.content;
  if (!text) return { ok: false, error: "Empty chat response." };
  return { ok: true, responseText: String(text) };
}
