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
 * Assist long-form textarea content with either polish or generation.
 * @param {{
 *  domain?: string,
 *  mode?: "polish"|"generate",
 *  label?: string,
 *  placeholder?: string,
 *  currentText?: string,
 *  instruction?: string,
 *  profile?: Record<string, string>
 * }} input
 * @returns {Promise<{ ok: boolean, text?: string, error?: string }>}
 */
export async function assistLargeTextboxText(input) {
  const apiKey = (OPENAI_API_KEY || "").trim();
  if (!apiKey) return { ok: false, error: "No OPENAI_API_KEY (run npm run sync-env after filling .env.local)" };

  const mode = String(input?.mode || "generate").toLowerCase() === "polish" ? "polish" : "generate";
  console.log("[FormFiller TextAssist][AI] dispatch", {
    mode,
    label: String(input?.label || "").slice(0, 120),
    currentTextLength: String(input?.currentText || "").length,
    instructionLength: String(input?.instruction || "").length
  });
  return mode === "polish"
    ? assistLargeTextboxPolish({ apiKey, input })
    : assistLargeTextboxGenerate({ apiKey, input });
}

async function assistLargeTextboxPolish({ apiKey, input }) {
  const label = String(input?.label || "").trim();
  const placeholder = String(input?.placeholder || "").trim();
  const currentText = String(input?.currentText || "").trim();
  const question = label || placeholder || "(no question provided)";
  const systemPrompt = `You polish text written for job application long-form fields.
You must return exactly one JSON object: { "text": string }.
Rules:
- Output only the polished text in "text" (no markdown, no preface).
- You are given only a question and the user's draft answer.
- Preserve original meaning and factual claims; do not add new facts.
- Keep a professional tone.
- Keep the answer concise, fluent, and directly responsive to the question.`;
  const userPrompt = `Question:
${question}

User text:
---
${currentText || "(empty)"}
---`;
  console.log("[FormFiller TextAssist][AI] polish prompt", {
    questionLength: question.length,
    question,
    userTextLength: currentText.length
  });
  return callLargeTextboxWriter({
    apiKey,
    systemPrompt,
    userPrompt,
    temperature: 0.2
  });
}

async function assistLargeTextboxGenerate({ apiKey, input }) {
  const label = String(input?.label || "").trim();
  const placeholder = String(input?.placeholder || "").trim();
  const currentText = String(input?.currentText || "").trim();
  const instruction = String(input?.instruction || "").trim();
  const question = label || placeholder || "(no question provided)";
  const profile = input?.profile && typeof input.profile === "object" ? input.profile : {};
  const promptContext = `${label} ${placeholder} ${instruction}`.toLowerCase();
  const relevantProfile = pickRelevantProfileForLongText(profile, promptContext);
  const requestedReferences = await collectRequestedReferenceContext({ instruction, profile });
  console.log("[FormFiller TextAssist][AI] generate context", {
    questionLength: question.length,
    question,
    userWordsLength: currentText.length,
    instruction,
    relevantProfile,
    requestedReferencesCount: Array.isArray(requestedReferences) ? requestedReferences.length : 0,
    requestedReferences
  });
  const systemPrompt = `You draft answers for job application long-form text fields.
You must return exactly one JSON object: { "text": string }.
Question to answer:
${question}

Relevant local fields:
${JSON.stringify(relevantProfile || {})}

Rules:
- Output only the final field text in "text" (no markdown, no preface).
- Directly answer the provided question.
- Do not write a generic summary when the question asks for a specific answer.
- Use only the provided "Relevant local fields" as factual context.
- Do not invent employers, schools, dates, achievements, or credentials.
- Keep the tone professional and concise.
- If reference excerpts are provided, use them as supporting context.
- If a custom instruction is provided, follow it unless it conflicts with factuality rules.`;
  const userPrompt = `User instruction:
${instruction || "(none)"}

Requested reference excerpts:
${JSON.stringify(requestedReferences || [])}

User words:
---
${currentText || "(empty)"}
---`;
  return callLargeTextboxWriter({
    apiKey,
    systemPrompt,
    userPrompt,
    temperature: 0.4
  });
}

async function callLargeTextboxWriter({ apiKey, systemPrompt, userPrompt, temperature }) {
  console.log("[FormFiller TextAssist][AI] call start", {
    temperature,
    systemPromptLength: String(systemPrompt || "").length,
    userPromptLength: String(userPrompt || "").length
  });
  const response = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ]
    })
  });

  const payload = await response.json().catch(() => null);
  console.log("[FormFiller TextAssist][AI] call response", {
    ok: response.ok,
    status: response.status,
    hasChoice: !!payload?.choices?.[0]?.message?.content,
    error: String(payload?.error?.message || "")
  });
  if (!response.ok) {
    return { ok: false, error: payload?.error?.message || `OpenAI HTTP ${response.status}` };
  }
  const content = payload?.choices?.[0]?.message?.content;
  if (!content || typeof content !== "string") return { ok: false, error: "Empty OpenAI response" };
  const parsed = safeParseJson(content);
  const text = String(parsed?.text || "").trim();
  console.log("[FormFiller TextAssist][AI] parsed", {
    hasText: !!text,
    textLength: text.length
  });
  if (!text) return { ok: false, error: "Model returned empty text" };
  return { ok: true, text };
}

function shouldFetchReferences(instruction) {
  const s = String(instruction || "").toLowerCase();
  if (!s) return false;
  return /\b(reference|refer|based on|from my|according to|using my|use my|cite)\b/.test(s);
}

async function collectRequestedReferenceContext({ instruction, profile }) {
  if (!shouldFetchReferences(instruction)) return [];
  const s = String(instruction || "").toLowerCase();
  const urls = [];
  const add = (label, key) => {
    const v = String(profile?.[key] || "").trim();
    if (!v) return;
    try {
      const u = new URL(v);
      if (!/^https?:$/i.test(u.protocol)) return;
      urls.push({ label, url: u.toString() });
    } catch {
      // ignore invalid URL
    }
  };

  const specific = {
    linkedin: /\blinkedin\b/.test(s),
    github: /\bgithub\b/.test(s),
    website: /\b(website|portfolio|personal site|homepage)\b/.test(s)
  };
  const askedSpecific = specific.linkedin || specific.github || specific.website;

  if (!askedSpecific || specific.linkedin) add("LinkedIn", "linkedin");
  if (!askedSpecific || specific.github) add("GitHub", "github");
  if (!askedSpecific || specific.website) add("Website", "website");

  const uniqueByUrl = new Map();
  for (const item of urls) if (!uniqueByUrl.has(item.url)) uniqueByUrl.set(item.url, item);
  const selected = Array.from(uniqueByUrl.values()).slice(0, 2);
  if (!selected.length) return [];

  const out = [];
  for (const item of selected) {
    const excerpt = await fetchReferenceExcerpt(item.url);
    if (!excerpt) continue;
    out.push({ source: item.label, url: item.url, excerpt });
  }
  return out;
}

async function fetchReferenceExcerpt(url) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: { Accept: "text/html,application/xhtml+xml,text/plain" }
    });
    clearTimeout(timer);
    if (!response.ok) return "";
    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    if (!/text\/html|text\/plain|application\/xhtml\+xml/.test(contentType)) return "";
    const raw = String(await response.text()).slice(0, 120000);
    const excerpt = raw
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 1800);
    return excerpt;
  } catch {
    return "";
  }
}

function pickRelevantProfileForLongText(profile, promptContext) {
  const p = profile && typeof profile === "object" ? profile : {};
  const out = {};
  const add = (key) => {
    const raw = p[key];
    const value = typeof raw === "string" ? raw.trim() : String(raw || "").trim();
    if (value) out[key] = value;
  };

  const alwaysUseful = ["fullName", "firstName", "lastName", "email", "phone", "currentTitle", "currentCompany"];
  for (const k of alwaysUseful) add(k);

  const addKeys = (keys) => { for (const k of keys) add(k); };
  const has = (re) => re.test(promptContext);

  if (has(/\b(cover letter|why (?:do you|are you|want)|motivation|why .*role|why .*company|interest in)\b/)) {
    addKeys(["currentTitle", "currentCompany", "yearsOfExperience", "highestDegree", "major", "university", "website", "linkedin", "github"]);
  }
  if (has(/\b(experience|experienced|background|worked|work history|career)\b/)) {
    addKeys(["currentTitle", "currentCompany", "yearsOfExperience", "linkedin", "github", "website"]);
  }
  if (has(/\b(education|degree|major|school|university|college|graduation)\b/)) {
    addKeys(["highestDegree", "major", "university", "graduationYear"]);
  }
  if (has(/\b(skill|skills|technology|tech stack|tool|tools|language|languages)\b/)) {
    addKeys(["currentTitle", "yearsOfExperience", "website", "github", "linkedin"]);
  }
  if (has(/\b(relocate|relocation)\b/)) add("willingToRelocate");
  if (has(/\b(sponsorship|visa|work authorization|authorized to work|immigration)\b/)) {
    addKeys(["workAuthorization", "requiresSponsorship"]);
  }
  if (has(/\b(salary|compensation|pay)\b/)) add("desiredSalary");
  if (has(/\b(start date|notice period|available to start|availability)\b/)) add("noticePeriod");
  if (has(/\b(linkedin)\b/)) add("linkedin");
  if (has(/\b(github)\b/)) add("github");
  if (has(/\b(portfolio|website|personal site)\b/)) add("website");

  return out;
}
