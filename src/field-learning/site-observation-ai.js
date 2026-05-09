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

// Tool definitions exposed to the agent for probe-selection
const AVAILABLE_TOOLS = [
  { name: "probeSelector", description: "Test a CSS selector — use to verify hypotheses about the page structure.", params: { selector: "CSS selector string" } },
  { name: "probeInputBehavior", description: "Check if a specific input element is React-controlled or framework-managed.", params: { selector: "CSS selector for one input" } }
];

/**
 * Two-phase LLM call for site analysis:
 *   phase "probe_select" → decides which extra tools to run given initial observations
 *   phase "build_skill"  → produces a full site skill from all observations
 *
 * @param {{ phase: "probe_select"|"build_skill", domain: string, observations: object }} input
 * @returns {Promise<{ ok: boolean, result?: object, error?: string }>}
 */
export async function analyzeSiteObservations({ phase, domain, observations }) {
  const apiKey = (OPENAI_API_KEY || "").trim();
  if (!apiKey) return { ok: false, error: "No OPENAI_API_KEY" };

  let systemPrompt, userContent;

  if (phase === "probe_select") {
    systemPrompt = `You are a web form automation expert. Given initial observations about a job application page, decide which additional targeted probes to run to resolve ambiguities.

Available extra tools:
${JSON.stringify(AVAILABLE_TOOLS, null, 2)}

Return JSON: { "probes": [ { "tool": "<toolName>", "args": ["<arg1>", ...], "reason": "<why>" } ] }
Rules:
- Only include probes that would meaningfully change your understanding.
- Limit to 4 probes.
- If initial observations are already sufficient, return { "probes": [] }.`;

    userContent = `Domain: ${domain}\nInitial observations:\n${JSON.stringify(observations, null, 2)}`;
  } else {
    systemPrompt = `You are a web form automation expert. Based on all observations about a job application page, produce a "site skill" that tells a form-filler agent how to interact with this site.

Return JSON with EXACTLY this structure:
{
  "platform": "workday"|"greenhouse"|"lever"|"icims"|"taleo"|"successfactors"|"smartrecruiters"|"bamboohr"|"jobvite"|"ashby"|"linkedin"|"indeed"|"custom",
  "platformLabel": "<human readable name, e.g. 'Workday v2'>",
  "labelMethod": "dataAutomationId"|"ariaLabel"|"labelFor"|"placeholder"|"wrapperText"|"mixed",
  "dropdownType": "standard"|"ariaCombobox"|"customList"|"mixed",
  "needsAriaCombobox": true|false,
  "needsAsyncInteraction": true|false,
  "fieldIdentifier": "dataAutomationId"|"dataQa"|"dataTestid"|"name"|"id"|"ariaLabel",
  "primaryFieldSelector": "<CSS selector for form field wrappers, or empty string>",
  "iframeForm": true|false,
  "shadowDomForm": true|false,
  "confidence": <0.0–1.0>,
  "notes": "<one sentence summary of key characteristics>"
}`;

    userContent = `Domain: ${domain}\nAll observations:\n${JSON.stringify(observations, null, 2)}`;
  }

  const response = await fetch(OPENAI_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userContent }]
    })
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    return { ok: false, error: payload?.error?.message || `OpenAI HTTP ${response.status}` };
  }
  const content = payload?.choices?.[0]?.message?.content;
  if (!content) return { ok: false, error: "Empty response" };
  const parsed = safeParseJson(content);
  if (!parsed) return { ok: false, error: "Could not parse JSON" };
  return { ok: true, result: parsed };
}
