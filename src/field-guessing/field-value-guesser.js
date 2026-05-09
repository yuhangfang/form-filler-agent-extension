import { OPENAI_API_KEY } from "../env.secret.js";
import { normalizeSpaces } from "../field-extraction/field-normalization.js";
import "./profile-field-catalog.js";

const { inferProfileFieldKey, PROFILE_FIELD_LABELS } = globalThis.__formFillerProfileFieldCatalog;

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const OPENAI_MODEL = "gpt-4o-mini";

function forwardOpenAiDebugToTab(tabId, payload, logPrefix) {
  const prefix = logPrefix || "[FormFiller][field-fill][openai]";
  if (!tabId || typeof chrome === "undefined" || !chrome.tabs?.sendMessage) return;
  try {
    chrome.tabs.sendMessage(tabId, {
      type: "FLOATING_BAR_PROGRESS",
      text: `${prefix} ${JSON.stringify(payload)}`.slice(0, 12000),
      phase: "field_llm_debug"
    });
  } catch {
    /* ignore */
  }
}

function unwrapJsonFence(content) {
  const raw = String(content || "").trim();
  if (!raw) return "";
  const fenced = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced?.[1]?.trim() || raw;
}

function safeParseJson(content) {
  const text = unwrapJsonFence(content);
  try {
    return JSON.parse(text);
  } catch (_e) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) return null;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch (_e2) {
      return null;
    }
  }
}

function splitDateRangeParts(timeRange) {
  const raw = normalizeSpaces(timeRange);
  if (!raw) return {};
  const parts = raw.split(/\s*(?:-|–|—|to)\s*/i).map((part) => normalizeSpaces(part)).filter(Boolean);
  const start = parts[0] || "";
  const end = parts.slice(1).join(" - ") || "";
  const parsePoint = (value) => {
    const text = normalizeSpaces(value);
    if (!text) return { month: "", year: "" };
    if (/present|current|now/i.test(text)) return { month: "", year: "Present" };
    const year = text.match(/\b(19\d{2}|20\d{2})\b/)?.[1] || "";
    const month =
      text.match(
        /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\b/i
      )?.[1] || "";
    return {
      month: month ? month.slice(0, 1).toUpperCase() + month.slice(1).toLowerCase().replace(/^Sept$/, "Sep") : "",
      year
    };
  };
  const startParts = parsePoint(start);
  const endParts = parsePoint(end);
  return {
    startMonth: startParts.month,
    startYear: startParts.year,
    endMonth: endParts.month,
    endYear: endParts.year
  };
}

function formatDateParts(parts) {
  function formatMonth(monthName) {
    if (!monthName) return "";
    const map = {
      Jan: "01",
      Feb: "02",
      Mar: "03",
      Apr: "04",
      May: "05",
      Jun: "06",
      Jul: "07",
      Aug: "08",
      Sep: "09",
      Oct: "10",
      Nov: "11",
      Dec: "12"
    };
    const num = map[monthName];
    return num ? `${num} (${monthName})` : monthName;
  }
  const bits = [];
  if (parts.startMonth) bits.push(`startMonth=${formatMonth(parts.startMonth)}`);
  if (parts.startYear) bits.push(`startYear=${parts.startYear}`);
  if (parts.endMonth) bits.push(`endMonth=${formatMonth(parts.endMonth)}`);
  if (parts.endYear) bits.push(`endYear=${parts.endYear}`);
  return bits.length ? `; ${bits.join(", ")}` : "";
}

function cleanQuestionForLlm(text) {
  const s = normalizeSpaces(text)
    .replace(/\bquestion\s+\d{5,}\b/gi, " ")
    .replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi, " ")
    .replace(/\b[a-z0-9_-]{18,}\b/gi, " ")
    .replace(/completion is voluntary and will not subject you to adverse treatment/gi, " ")
    .replace(/decline to self[- ]?identify/gi, "prefer not to answer");
  return (s || "").replace(/\s+/g, " ").trim().slice(0, 900);
}

function compressOptionsSummary(text) {
  const raw = normalizeSpaces(text);
  if (!raw) return "";
  const chunks = raw.split("|").map((c) => normalizeSpaces(c)).filter(Boolean);
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

function pickPrimaryQuestionText(f) {
  const ctx = String(f.context || "").trim();
  const name = String(f.name || "").trim();
  const help = String(f.helpText || "").trim();
  let base = ctx || name;
  if (help && base && !base.toLowerCase().includes(help.slice(0, Math.min(48, help.length)).toLowerCase())) {
    base = `${base} ${help}`;
  } else if (help && !base) {
    base = help;
  }
  return base || name || ctx;
}

/** Label / name / pipe chunks first — avoids matching EEO boilerplate in full context. */
function profileFieldKeyHintsFromDescriptor(field) {
  if (!field || typeof field !== "object") return [];
  const ctx = String(field.context || "");
  const pipeParts = ctx
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 10);
  return [field.label, field.name, field.helpText, ...pipeParts]
    .filter((x) => x != null && String(x).trim() !== "")
    .map((x) => String(x).trim());
}

function optionFieldKind(kind) {
  const k = String(kind || "").toLowerCase();
  return k === "select" || k === "radio" || k === "checkbox" || k === "ariacombobox";
}

/**
 * Minimal payload describing the control: question text and optional option list only.
 */
function trimFieldForLlmMinimal(f) {
  const question = cleanQuestionForLlm(pickPrimaryQuestionText(f));
  const kind = String(f.kind || "").toLowerCase();
  const rawOpts = String(f.optionsSummary || "").trim();
  const includeOpts = optionFieldKind(kind) && !!rawOpts;
  const out = { question };
  if (includeOpts) out.options = compressOptionsSummary(rawOpts);
  return out;
}

function formatLearnedFieldHint(h) {
  if (!h || typeof h !== "object") return "";
  const parts = [];
  if (h.canonicalKey) parts.push(`canonicalKey: ${h.canonicalKey}`);
  if (h.priorAnswer) parts.push(`priorAnswer: ${h.priorAnswer}`);
  if (Array.isArray(h.answerSamples) && h.answerSamples.length) {
    parts.push(`pastAnswers: ${h.answerSamples.join(" | ")}`);
  }
  return parts.join(". ").slice(0, 450);
}

function trimScalar(value, max = 140) {
  const s = String(value ?? "").trim();
  return s ? s.slice(0, max) : "";
}

export function buildPlannerContextBundle(profile, resumeData) {
  const scalarKeys = [
    "fullName",
    "firstName",
    "lastName",
    "email",
    "phone",
    "currentTitle",
    "currentCompany",
    "city",
    "state",
    "country",
    "address",
    "zip",
    "workAuthorization",
    "requiresSponsorship",
    "authorizedToWork",
    "needVisaSponsorship",
    "yearsOfExperience",
    "disabilityStatus",
    "veteranStatus"
  ];
  const scalars = {};
  for (const key of scalarKeys) {
    const value = trimScalar(profile?.[key], 140);
    if (value) scalars[key] = value;
  }

  const handles = [];
  const education = Array.isArray(resumeData?.education) ? resumeData.education : [];
  for (let i = 0; i < education.length; i += 1) handles.push(`education:${i}`);
  const experience = Array.isArray(resumeData?.experience) ? resumeData.experience : [];
  for (let i = 0; i < experience.length; i += 1) handles.push(`experience:${i}`);
  const internships = Array.isArray(resumeData?.internships) ? resumeData.internships : [];
  for (let i = 0; i < internships.length; i += 1) handles.push(`internship:${i}`);
  if (Array.isArray(resumeData?.skills) && resumeData.skills.length) handles.push("skills");
  if (trimScalar(resumeData?.summary, 20)) handles.push("summary");

  return {
    scalars,
    handles
  };
}

function profileLine(profile, key) {
  if (!profile || typeof profile !== "object") return "";
  const v = profile[key];
  if (v == null) return "";
  const s = String(v).trim();
  if (!s) return "";
  const label = PROFILE_FIELD_LABELS[key] || key;
  return `${label}: ${s.slice(0, 520)}`;
}

function dedupeLines(lines) {
  const out = [];
  const seen = new Set();
  for (const line of lines) {
    const t = String(line || "").trim();
    if (!t) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

function firstNonEmptyResumeLocation(resumeData) {
  if (!resumeData || typeof resumeData !== "object") return "";
  const rows = [
    ...(Array.isArray(resumeData.experience) ? resumeData.experience : []),
    ...(Array.isArray(resumeData.internships) ? resumeData.internships : []),
    ...(Array.isArray(resumeData.education) ? resumeData.education : [])
  ];
  for (const e of rows) {
    const L = e?.location;
    if (String(L || "").trim()) return String(L).trim().slice(0, 160);
  }
  return "";
}

function geoInferKeysFromCatalog() {
  return new Set(["city", "state", "country", "address", "zip"]);
}

/** Work / site location (not where the candidate lives). Do not map these to profile city/geo. */
function isEmployerLocationQuestion(norm) {
  return /\b(employer|company|office|site)\s+location\b/i.test(norm);
}

function isLocationStyleQuestion(norm, inferCk) {
  if (isEmployerLocationQuestion(norm)) return false;
  if (inferCk && geoInferKeysFromCatalog().has(inferCk)) return true;
  return (
    /\bcurrent location\b|\byour location\b|\bwhere are you (based|located|living)\b|\bwhere do you live\b|\bhome address\b|\bmailing address\b|\bresidential address\b/i.test(
      norm
    ) || /\blocation\b/i.test(norm)
  );
}

function resumeSnippetsForQuestion(norm, resumeData, inferCk = "") {
  if (!resumeData || typeof resumeData !== "object") return [];

  const lines = [];

  if (/education|degree|university|college|school|gpa|major|field of study|graduation/i.test(norm)) {
    const edu = Array.isArray(resumeData.education) ? resumeData.education : [];
    for (const [idx, e] of edu.slice(0, 3).entries()) {
      const datesObj =
        e.startDate || e.endDate
          ? {
              startMonth: e.startDate?.month || "",
              startYear: e.startDate?.year || "",
              endMonth: e.endDate?.month || "",
              endYear: e.endDate?.year || "",
              isCurrent: e.endDate?.isCurrent || false
            }
          : splitDateRangeParts(e.timeRange);
      lines.push(
        `Education row ${idx + 1}: school=${e.school || ""}; degree=${e.degree || ""}; major=${e.major || ""}; dates=${e.timeRange || ""}${formatDateParts(datesObj)}`.trim()
      );
    }
  }

  if (/experience|employment|employer|work history|previous role|job title|internship|career/i.test(norm)) {
    const exp = [
      ...(Array.isArray(resumeData.experience) ? resumeData.experience : []),
      ...(Array.isArray(resumeData.internships) ? resumeData.internships : [])
    ];
    for (const [idx, e] of exp.slice(0, 3).entries()) {
      const datesObj =
        e.startDate || e.endDate
          ? {
              startMonth: e.startDate?.month || "",
              startYear: e.startDate?.year || "",
              endMonth: e.endDate?.month || "",
              endYear: e.endDate?.year || "",
              isCurrent: e.endDate?.isCurrent || false
            }
          : splitDateRangeParts(e.timeRange);
      const desc = e.description || (Array.isArray(e.bullets) ? e.bullets.join("; ") : "");
      lines.push(
        `Experience row ${idx + 1}: ${e.jobTitle || e.role || ""} at ${e.company || ""}; ${e.timeRange || ""}${formatDateParts(datesObj)}`.trim()
      );
      if (desc) lines.push(`  ${desc.slice(0, 420)}`);
    }
  }

  if (/skill|technology|programming|stack|tools?|framework/i.test(norm) && Array.isArray(resumeData.skills) && resumeData.skills.length) {
    lines.push(`Skills: ${resumeData.skills.slice(0, 28).join(", ")}`);
  }

  if (isLocationStyleQuestion(norm, inferCk)) {
    const locPick = firstNonEmptyResumeLocation(resumeData);
    if (locPick) lines.push(`Resume location (reference): ${locPick}`);
  }

  if (
    /summary|about|tell us|describe|why |motivat|cover letter|additional|essay|comment|ai |artificial intelligence|llm|machine learning|workflow|impact/i.test(
      norm
    ) &&
    resumeData.summary &&
    !isLocationStyleQuestion(norm, inferCk)
  ) {
    lines.push(`Professional summary: ${String(resumeData.summary).slice(0, 480)}`);
  }

  if (!lines.length && resumeData.summary && !isLocationStyleQuestion(norm, inferCk)) {
    lines.push(`Professional summary: ${String(resumeData.summary).slice(0, 380)}`);
  }

  return lines.map((s) => s.slice(0, 580));
}

function parseResumeRefKey(ref) {
  const raw = String(ref || "").trim().toLowerCase();
  if (!raw) return null;
  if (raw === "skills") return { kind: "skills", index: -1 };
  if (raw === "summary") return { kind: "summary", index: -1 };
  const m = raw.match(/^(education|experience|internship):(\d{1,2})$/);
  if (!m) return null;
  return { kind: m[1], index: Number(m[2]) };
}

function rowSnippetsFromRef(parsedRef, resumeData, facets = []) {
  if (!parsedRef || !resumeData || typeof resumeData !== "object") return [];
  const facetSet = new Set((Array.isArray(facets) ? facets : []).map((x) => String(x || "").toLowerCase().trim()).filter(Boolean));
  const includeAll = facetSet.size === 0;
  if (parsedRef.kind === "skills") {
    const skills = Array.isArray(resumeData.skills) ? resumeData.skills : [];
    if (!skills.length) return [];
    return [`Skills: ${skills.slice(0, 40).join(", ")}`];
  }
  if (parsedRef.kind === "summary") {
    const summary = trimScalar(resumeData.summary, 850);
    return summary ? [`Professional summary: ${summary}`] : [];
  }
  const listKey = parsedRef.kind === "internship" ? "internships" : `${parsedRef.kind}s`;
  const rows = Array.isArray(resumeData[listKey]) ? resumeData[listKey] : [];
  const row = rows[parsedRef.index];
  if (!row || typeof row !== "object") return [];
  if (parsedRef.kind === "education") {
    const school = trimScalar(row.school, 140);
    const degree = trimScalar(row.degree, 140);
    const major = trimScalar(row.major, 140);
    const timeRange = trimScalar(row.timeRange, 80);
    const out = [];
    if (includeAll || facetSet.has("school")) if (school) out.push(`Education school: ${school}`);
    if (includeAll || facetSet.has("degree")) if (degree) out.push(`Education degree: ${degree}`);
    if (includeAll || facetSet.has("major") || facetSet.has("field")) if (major) out.push(`Education major: ${major}`);
    if (includeAll || facetSet.has("dates") || facetSet.has("timerange")) if (timeRange) out.push(`Education dates: ${timeRange}`);
    return out;
  }
  const title = trimScalar(row.jobTitle || row.role, 140);
  const company = trimScalar(row.company, 140);
  const timeRange = trimScalar(row.timeRange, 80);
  const location = trimScalar(row.location, 140);
  const desc = trimScalar(row.description || (Array.isArray(row.bullets) ? row.bullets.join("; ") : ""), 550);
  const out = [];
  if (includeAll || facetSet.has("title") || facetSet.has("jobtitle") || facetSet.has("role")) if (title) out.push(`Experience title: ${title}`);
  if (includeAll || facetSet.has("company") || facetSet.has("employer")) if (company) out.push(`Experience company: ${company}`);
  if (includeAll || facetSet.has("dates") || facetSet.has("timerange")) if (timeRange) out.push(`Experience dates: ${timeRange}`);
  if (includeAll || facetSet.has("location")) if (location) out.push(`Experience location: ${location}`);
  if ((includeAll || facetSet.has("description") || facetSet.has("bullets")) && desc) out.push(`Experience details: ${desc}`);
  return out;
}

function snippetsFromRetrievalPlan(profile, resumeData, retrievalPlan) {
  const plan = retrievalPlan && typeof retrievalPlan === "object" ? retrievalPlan : null;
  if (!plan) return [];
  const refs = Array.isArray(plan.resumeRefs) ? plan.resumeRefs : [];
  const facets = Array.isArray(plan.facets) ? plan.facets : [];
  const lines = [];
  for (const ref of refs.slice(0, 8)) {
    const parsed = parseResumeRefKey(ref);
    if (!parsed) continue;
    lines.push(...rowSnippetsFromRef(parsed, resumeData, facets));
  }
  const profileKeys = Array.isArray(plan.profileKeys) ? plan.profileKeys : [];
  for (const key of profileKeys.slice(0, 8)) {
    const line = profileLine(profile, key);
    if (line) lines.push(line);
  }
  return lines;
}

/** Push city/state/country/address/zip profile lines for residence-style questions (deduped). */
function pushGeoProfileBundle(profile, lines) {
  const seen = new Set(lines.map((l) => l.toLowerCase()));
  for (const k of ["city", "state", "country", "address", "zip"]) {
    const line = profileLine(profile, k);
    if (!line) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(line);
  }
}

/** Core facts without direct identifiers (no name, email, phone, social URLs). */
function fallbackProfileLines(profile) {
  if (!profile || typeof profile !== "object") return [];
  const keys = [
    "currentTitle",
    "currentCompany",
    "city",
    "state",
    "country",
    "yearsOfExperience",
    "workAuthorization",
    "requiresSponsorship"
  ];
  const lines = [];
  for (const k of keys) {
    const line = profileLine(profile, k);
    if (line) lines.push(line);
  }
  return lines.slice(0, 10);
}

/**
 * Short, question-targeted applicant snippets (no full profile or resume dump).
 */
function buildRelevantApplicantSnippets(profile, resumeData, questionText, learnedFieldHint, field) {
  const norm = String(questionText || "").toLowerCase();
  const learned = formatLearnedFieldHint(learnedFieldHint);
  const lines = [];
  const retrievalPlan = field?.retrievalPlan && typeof field.retrievalPlan === "object"
    ? field.retrievalPlan
    : null;

  if (learned) lines.push(`Learned field (this site): ${learned}`);

  if (retrievalPlan) {
    lines.push(...snippetsFromRetrievalPlan(profile, resumeData, retrievalPlan));
  }

  const keyHints = profileFieldKeyHintsFromDescriptor(field);
  let ck = inferProfileFieldKey(questionText || "", keyHints.length ? keyHints : undefined);
  if (isEmployerLocationQuestion(norm)) ck = "";
  if (ck) {
    const direct = profileLine(profile, ck);
    if (direct) lines.push(direct);
  }

  if (isLocationStyleQuestion(norm, ck)) {
    pushGeoProfileBundle(profile, lines);
  }

  lines.push(...resumeSnippetsForQuestion(norm, resumeData, ck));

  if (!lines.filter((l) => !l.startsWith("Learned field")).length) {
    lines.push(...fallbackProfileLines(profile));
  }

  const filled = String(field?.currentValue ?? "").trim();
  if (filled) {
    lines.push(`Current control value (verify or replace): ${filled.slice(0, 240)}`);
  }

  return dedupeLines(lines).join("\n").slice(0, 2200);
}

function singleFieldSystemPrompt() {
  return `You fill job application forms for one applicant.

You receive:
1) "Relevant applicant context", and
2) a JSON object with "question" and optionally "options" (pipe-separated value:Label pairs).

Return ONE JSON object: { "value": string }.

Rules:
- "value" must be plain text (no JSON, no markdown).
- If "options" are given: choose exactly one Label from the list and copy it verbatim (never paraphrase).
- If no options are given: answer only from relevant context.
- Respect explicit constraints in the question (format, sentence count, date part, etc.).
- Keep "Current control value" only when it already matches the question and context.
- If you cannot answer honestly from the context, use "".`;
}

function plannerSystemPrompt() {
  return `You are the LLMPlanner for a form filler.

You receive:
1) plannerContextBundle:
   - scalars: short applicant facts
   - handles: retrieval handles only (e.g. education:0, experience:1, internship:0, skills, summary)
2) fields: unresolved fields with fingerprint/question/kind/optionsSummary/currentValue.

Output STRICT NDJSON (one JSON object per line), no markdown, no prose.
Each line must include fingerprint and intent:
- direct: {"fingerprint":"...", "intent":"direct", "value":"..."}
- retrieve: {"fingerprint":"...", "intent":"retrieve", "resumeRefs":["education:0"], "profileKeys":["workAuthorization"], "facets":["degree"]}

Rules:
- Use only provided handles in resumeRefs.
- direct only when high confidence and value should be filled literally.
- retrieve when answer needs context resolution.
- Never invent unavailable profile keys or handles.
- Return one line per input field fingerprint.`;
}

function normalizePlannerRow(row, knownFingerprints, knownHandles) {
  if (!row || typeof row !== "object") return null;
  const fingerprint = String(row.fingerprint || "").slice(0, 32);
  if (!fingerprint || !knownFingerprints.has(fingerprint)) return null;
  const intentRaw = String(row.intent || "").trim().toLowerCase();
  const intent = intentRaw === "direct" ? "direct" : "retrieve";
  if (intent === "direct") {
    const value = String(row.value ?? "").trim();
    if (!value) return null;
    return { fingerprint, intent, value: value.slice(0, 600) };
  }
  const resumeRefs = (Array.isArray(row.resumeRefs) ? row.resumeRefs : [])
    .map((x) => String(x || "").trim().toLowerCase())
    .filter((x) => knownHandles.has(x))
    .slice(0, 8);
  const profileKeys = (Array.isArray(row.profileKeys) ? row.profileKeys : [])
    .map((x) => String(x || "").trim())
    .filter((x) => /^[a-zA-Z][a-zA-Z0-9_]{1,50}$/.test(x))
    .slice(0, 8);
  const facets = (Array.isArray(row.facets) ? row.facets : [])
    .map((x) => String(x || "").trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 8);
  if (!resumeRefs.length && !profileKeys.length) return null;
  return { fingerprint, intent, resumeRefs, profileKeys, facets };
}

function extractPlannerRowsFromParsed(parsed, knownFingerprints, knownHandles) {
  const rows = [];
  if (!parsed) return rows;
  const arr = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed.plans)
      ? parsed.plans
      : Array.isArray(parsed.rows)
        ? parsed.rows
        : parsed.fingerprint
          ? [parsed]
          : [];
  for (const row of arr) {
    const normalized = normalizePlannerRow(row, knownFingerprints, knownHandles);
    if (normalized) rows.push(normalized);
  }
  return rows;
}

export async function runFieldPlannerStream({ profile, resumeData, fields, onRow, debugTabId }) {
  const apiKey = (OPENAI_API_KEY || "").trim();
  if (!apiKey) return { ok: false, error: "No OPENAI_API_KEY (run npm run sync-env after filling .env.local)", rows: [] };
  if (!Array.isArray(fields) || !fields.length) return { ok: true, rows: [] };

  const plannerContextBundle = buildPlannerContextBundle(profile, resumeData);
  const plannerFields = fields.map((f) => {
    const minimalField = trimFieldForLlmMinimal(f);
    return {
      fingerprint: String(f.fingerprint || "").slice(0, 32),
      question: minimalField.question || "",
      kind: String(f.kind || "text"),
      optionsSummary: String(minimalField.options || "").slice(0, 1000),
      currentValue: String(f.currentValue || "").slice(0, 200)
    };
  }).filter((f) => f.fingerprint);
  if (!plannerFields.length) return { ok: true, rows: [] };

  const knownFingerprints = new Set(plannerFields.map((f) => f.fingerprint));
  const knownHandles = new Set((plannerContextBundle.handles || []).map((h) => String(h || "").toLowerCase()));
  const body = {
    model: OPENAI_MODEL,
    temperature: 0.1,
    stream: true,
    messages: [
      { role: "system", content: plannerSystemPrompt() },
      {
        role: "user",
        content: JSON.stringify({
          plannerContextBundle,
          fields: plannerFields
        })
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
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    return { ok: false, error: payload?.error?.message || `OpenAI HTTP ${response.status}`, rows: [] };
  }
  if (!response.body) return { ok: false, error: "Empty planner stream body", rows: [] };

  const rows = [];
  const seen = new Set();
  const decoder = new TextDecoder();
  let sseBuffer = "";
  let ndjsonBuffer = "";
  let fullText = "";
  const emitRow = async (row) => {
    if (!row || !row.fingerprint || seen.has(row.fingerprint)) return;
    seen.add(row.fingerprint);
    rows.push(row);
    if (typeof onRow === "function") await onRow(row);
  };
  const parseNdjsonBuffer = async () => {
    const parts = ndjsonBuffer.split(/\r?\n/);
    ndjsonBuffer = parts.pop() || "";
    for (const lineRaw of parts) {
      const line = lineRaw.trim();
      if (!line) continue;
      const parsed = safeParseJson(line);
      const parsedRows = extractPlannerRowsFromParsed(parsed, knownFingerprints, knownHandles);
      for (const row of parsedRows) await emitRow(row);
    }
  };

  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    sseBuffer += decoder.decode(value, { stream: true });
    const events = sseBuffer.split("\n");
    sseBuffer = events.pop() || "";
    for (const evt of events) {
      const line = evt.trim();
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      const json = safeParseJson(data);
      const delta = String(json?.choices?.[0]?.delta?.content || "");
      if (!delta) continue;
      fullText += delta;
      ndjsonBuffer += delta;
      await parseNdjsonBuffer();
    }
  }
  const tail = ndjsonBuffer.trim();
  if (tail) {
    const tailLines = tail.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    let parsedAny = false;
    for (const line of tailLines) {
      const parsed = safeParseJson(line);
      const parsedRows = extractPlannerRowsFromParsed(parsed, knownFingerprints, knownHandles);
      if (parsedRows.length) parsedAny = true;
      for (const row of parsedRows) await emitRow(row);
    }
    if (!parsedAny) {
      const parsed = safeParseJson(tail);
      const parsedRows = extractPlannerRowsFromParsed(parsed, knownFingerprints, knownHandles);
      for (const row of parsedRows) await emitRow(row);
    }
  }

  if (!rows.length && fullText.trim()) {
    const parsed = safeParseJson(fullText);
    const parsedRows = extractPlannerRowsFromParsed(parsed, knownFingerprints, knownHandles);
    for (const row of parsedRows) await emitRow(row);
  }

  const dbg = {
    phase: "planner_rows",
    rows: rows.length,
    fields: plannerFields.length,
    handles: knownHandles.size
  };
  console.log("[FormFiller][field-fill][planner]", dbg);
  forwardOpenAiDebugToTab(debugTabId, dbg, "[FormFiller][field-fill][planner]");
  return { ok: true, rows };
}

function parseSingleFieldResponse(content) {
  const parsed = safeParseJson(content);
  if (!parsed) return null;
  let row = null;
  if (parsed.value !== undefined) row = parsed;
  else if (Array.isArray(parsed.guesses) && parsed.guesses.length) row = parsed.guesses[0];
  else row = parsed;
  if (!row) return null;
  const rawValue =
    row.value ??
    row.answer ??
    row.text ??
    row.label ??
    row.option ??
    row.selected ??
    row.result ??
    row.location ??
    row.city ??
    row.state ??
    row.country ??
    "";
  const value =
    rawValue && typeof rawValue === "object"
      ? String(rawValue.label ?? rawValue.value ?? rawValue.text ?? "").trim()
      : String(rawValue ?? "").trim();
  return {
    value
  };
}

/**
 * One OpenAI chat completion for a single form field.
 * guess.canonicalKey is inferred locally (inferProfileFieldKey + question/context), not returned by the model.
 * @returns {Promise<{ ok: boolean, guess?: { fingerprint: string, value: string, canonicalKey: string }, error?: string }>}
 */
async function guessOneFormField({ apiKey, profile, resumeData, field, debugTabId }) {
  const expectedFp = String(field.fingerprint || "").slice(0, 32);
  if (!expectedFp) {
    return { ok: false, error: "Missing fingerprint" };
  }

  const minimalField = trimFieldForLlmMinimal(field);
  const keyHints = profileFieldKeyHintsFromDescriptor(field);
  const relevant = buildRelevantApplicantSnippets(
    profile,
    resumeData,
    minimalField.question || pickPrimaryQuestionText(field),
    field.learnedFieldHint,
    field
  );

  const relevantDebug = {
    phase: "relevant_applicant_context",
    fingerprint: expectedFp,
    questionPreview: String(minimalField.question || pickPrimaryQuestionText(field) || "").slice(0, 200),
    relevantChars: relevant.length,
    relevant: relevant.trim() ? relevant : "(empty — model gets no applicant snippets)"
  };
  console.log("[FormFiller][field-fill][context]", relevantDebug);
  forwardOpenAiDebugToTab(debugTabId, relevantDebug, "[FormFiller][field-fill][context]");

  const userParts = [];
  if (relevant.trim()) userParts.push(`Relevant applicant context:\n${relevant}`);
  userParts.push(`Field to fill:\n${JSON.stringify(minimalField)}`);

  const body = {
    model: OPENAI_MODEL,
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: singleFieldSystemPrompt()
      },
      {
        role: "user",
        content: userParts.join("\n\n")
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
    const message = payload?.error?.message || `OpenAI HTTP ${response.status}`;
    return { ok: false, error: message };
  }

  const content = payload?.choices?.[0]?.message?.content;
  if (!content || typeof content !== "string") {
    return { ok: false, error: "Empty OpenAI response" };
  }

  const parsed = parseSingleFieldResponse(content);
  if (!parsed) {
    const dbg = {
      phase: "parse_failed",
      fingerprint: expectedFp,
      contentHead: String(content).slice(0, 200)
    };
    console.log("[FormFiller][field-fill][openai]", dbg);
    forwardOpenAiDebugToTab(debugTabId, dbg);
    return { ok: false, error: "Could not parse guess JSON" };
  }

  const questionForInfer = pickPrimaryQuestionText(field);
  const canonicalKey = inferProfileFieldKey(questionForInfer || "", keyHints.length ? keyHints : undefined);
  const trimmedValue = String(parsed.value ?? "").trim();
  if (!trimmedValue) {
    const dbg = {
      phase: "empty_value_after_parse",
      fingerprint: expectedFp,
      canonicalKey,
      questionPreview: String(minimalField.question || questionForInfer || "").slice(0, 120),
      relevantContextChars: relevant.length,
      rawJsonHead: String(content).slice(0, 160)
    };
    console.log("[FormFiller][field-fill][openai]", dbg);
    forwardOpenAiDebugToTab(debugTabId, dbg);
  }

  return {
    ok: true,
    guess: {
      fingerprint: expectedFp,
      value: parsed.value,
      canonicalKey
    }
  };
}

/**
 * Sequential OpenAI calls: one completion per field (no batching in a single request).
 * @param {{ profile: Record<string, string>, resumeData?: object, fields: object[], debugTabId?: number }} input
 * @returns {Promise<{ ok: boolean, guesses?: { fingerprint: string, value: string }[], error?: string }>}
 */
export async function batchGuessFormFields({ profile, resumeData, fields, debugTabId }) {
  const apiKey = (OPENAI_API_KEY || "").trim();
  if (!apiKey) {
    return { ok: false, error: "No OPENAI_API_KEY (run npm run sync-env after filling .env.local)" };
  }
  if (!Array.isArray(fields) || !fields.length) {
    return { ok: true, guesses: [] };
  }

  const guesses = [];
  for (let i = 0; i < fields.length; i += 1) {
    const f = fields[i];
    console.log("[FormFiller OpenAI] Field", i + 1, "/", fields.length);
    const one = await guessOneFormField({
      apiKey,
      profile,
      resumeData,
      field: f,
      debugTabId
    });
    if (!one.ok) {
      return { ok: false, error: one.error, guesses };
    }
    if (one.guess) guesses.push(one.guess);
  }

  return { ok: true, guesses };
}

/**
 * Same as {@link batchGuessFormFields} but invokes `onGuess` after each field completes (incremental UI).
 * Uses one non-streaming completion per field (no multi-field SSE batch).
 * @param {{ profile: Record<string, string>, resumeData?: object, fields: object[], onGuess?: (guess: { fingerprint: string, value: string, canonicalKey?: string }) => Promise<void>|void, debugTabId?: number }} input
 * @returns {Promise<{ ok: boolean, guesses?: { fingerprint: string, value: string, canonicalKey?: string }[], error?: string }>}
 */
export async function batchGuessFormFieldsStream({ profile, resumeData, fields, onGuess, debugTabId }) {
  const apiKey = (OPENAI_API_KEY || "").trim();
  if (!apiKey) return { ok: false, error: "No OPENAI_API_KEY (run npm run sync-env after filling .env.local)" };
  if (!Array.isArray(fields) || !fields.length) return { ok: true, guesses: [] };

  const all = [];
  for (let i = 0; i < fields.length; i += 1) {
    const f = fields[i];
    const one = await guessOneFormField({
      apiKey,
      profile,
      resumeData,
      field: f,
      debugTabId
    });
    if (!one.ok) {
      return { ok: false, error: one.error, guesses: all };
    }
    const g = one.guess;
    if (g) {
      all.push(g);
      if (typeof onGuess === "function") await onGuess(g);
    }
  }
  return { ok: true, guesses: all };
}
