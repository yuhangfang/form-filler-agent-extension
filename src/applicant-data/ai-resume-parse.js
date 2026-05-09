import { OPENAI_API_KEY } from "../env.secret.js";

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

const RESUME_JSON_SCHEMA_HINT = `Return a single JSON object with this exact shape (arrays may be empty):
{
  "summary": string,
  "experience": [{ "company": string, "jobTitle": string, "role": string, "location": string, "timeRange": string, "startDate": { "month": string, "year": string }, "endDate": { "month": string, "year": string, "isCurrent": boolean }, "bullets": string[] }],
  "internships": [{ same shape as experience }],
  "education": [{ "school": string, "major": string, "degree": string, "timeRange": string, "startDate": { "month": string, "year": string }, "endDate": { "month": string, "year": string, "isCurrent": boolean }, "location": string }],
  "skills": string[],
  "publications": string[],
  "projects": string[],
  "certifications": string[],
  "awards": string[],
  "other": string[]
}
Rules:
- Parse ONLY from the resume plain text provided. Do not invent employers, degrees, dates, or skills.
- Put paid/primary roles under "experience"; internships under "internships" (include teaching assistant roles there if they are listed as internships, otherwise experience).
- Each job: one object with company, title/role, location, date range, and bullet strings under "bullets".
- Education: separate entry per degree if multiple lines; school vs city/country in location when clear.
- Strip page footers like "-- 1 of 2 --" and "Page 2" from content consideration.
- Use empty string "" or [] when unknown.`;

function truncate(text, maxChars) {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[...truncated for API size...]`;
}

function safeParseJson(content) {
  try {
    return JSON.parse(content);
  } catch (_error) {
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) return null;
    try {
      return JSON.parse(content.slice(start, end + 1));
    } catch (_error2) {
      return null;
    }
  }
}

export function normalizeAiResumeData(raw) {
  if (!raw || typeof raw !== "object") return null;
  const skills = Array.isArray(raw.skills) ? raw.skills.map(String) : [];
  const publications = Array.isArray(raw.publications) ? raw.publications.map(String) : [];
  const projects = Array.isArray(raw.projects) ? raw.projects.map(String) : [];
  const certifications = Array.isArray(raw.certifications) ? raw.certifications.map(String) : [];
  const awards = Array.isArray(raw.awards) ? raw.awards.map(String) : [];
  const other = Array.isArray(raw.other) ? raw.other.map(String) : [];

  const mapExp = (list) =>
    (Array.isArray(list) ? list : []).map((item) => ({
      company: String(item?.company || ""),
      jobTitle: String(item?.jobTitle || item?.role || ""),
      role: String(item?.role || item?.jobTitle || ""),
      location: String(item?.location || ""),
      timeRange: String(item?.timeRange || ""),
      startDate: {
        month: String(item?.startDate?.month || ""),
        year: String(item?.startDate?.year || "")
      },
      endDate: {
        month: String(item?.endDate?.month || ""),
        year: String(item?.endDate?.year || ""),
        isCurrent: Boolean(item?.endDate?.isCurrent || false)
      },
      bullets: Array.isArray(item?.bullets) ? item.bullets.map(String) : []
    }));

  const mapEdu = (list) =>
    (Array.isArray(list) ? list : []).map((item) => ({
      school: String(item?.school || ""),
      major: String(item?.major || ""),
      degree: String(item?.degree || ""),
      timeRange: String(item?.timeRange || ""),
      startDate: {
        month: String(item?.startDate?.month || ""),
        year: String(item?.startDate?.year || "")
      },
      endDate: {
        month: String(item?.endDate?.month || ""),
        year: String(item?.endDate?.year || ""),
        isCurrent: Boolean(item?.endDate?.isCurrent || false)
      },
      location: String(item?.location || "")
    }));

  return {
    summary: String(raw.summary || ""),
    experience: mapExp(raw.experience),
    internships: mapExp(raw.internships),
    education: mapEdu(raw.education),
    skills,
    publications,
    projects,
    certifications,
    awards,
    other
  };
}

/**
 * Primary parser: structured resume from plain text only (no rule-based draft).
 */
export async function parseResumeWithOpenAI(fullText) {
  const apiKey = (OPENAI_API_KEY || "").trim();
  if (!apiKey) {
    return { ok: false, error: "No OPENAI_API_KEY (run npm run sync-env after filling .env.local)" };
  }

  const textBlock = truncate(fullText, 32000);

  const body = {
    model: "gpt-4o-mini",
    temperature: 0.05,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `You are an expert resume parser. Extract structured data for a job-application form filler.\n${RESUME_JSON_SCHEMA_HINT}`
      },
      {
        role: "user",
        content: `Resume plain text (may include line breaks from PDF extraction):\n---\n${textBlock}\n---`
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

  const parsed = safeParseJson(content);
  const normalized = normalizeAiResumeData(parsed);
  if (!normalized) {
    return { ok: false, error: "Could not parse OpenAI JSON" };
  }

  return { ok: true, resumeData: normalized };
}
