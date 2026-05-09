import { parseResumeWithOpenAI } from "./ai-resume-parse.js";

function hashString(input) {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash << 5) - hash + input.charCodeAt(i);
    hash |= 0;
  }
  return `h${Math.abs(hash)}`;
}

function extractFirst(regex, text) {
  const match = text.match(regex);
  return match?.[1]?.trim() || "";
}

function extractPhoneNumber(text) {
  const us =
    extractFirst(/((?:\+?1[\s.-]{0,2})?\(?\d{3}\)?[\s.-]*\d{3}[\s.-]*\d{4})\b/, text) ||
    extractFirst(/(\+?\d[\d\s().-]{7,14}\d)/, text);
  return us.replace(/\s+/g, " ").trim();
}

function extractLines(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

const SECTION_DEFINITIONS = {
  summary: {
    aliases: ["summary", "professional summary", "profile", "about", "overview"],
    keywords: ["summary", "bridging", "track record", "objective", "profile"]
  },
  experience: {
    aliases: ["professional experience", "experience", "work experience", "employment history"],
    keywords: ["experience", "engineer", "scientist", "manager", "present", "company", "designed"]
  },
  education: {
    aliases: ["education", "academic background", "academics"],
    keywords: ["university", "college", "ph.d", "m.s", "bachelor", "degree", "gpa"]
  },
  internships: {
    aliases: ["internships", "internship experience", "internship"],
    keywords: ["intern", "internship", "summer", "co-op"]
  },
  skills: {
    aliases: ["skills", "technical skills", "core skills", "tooling", "tech stack"],
    keywords: ["python", "sql", "aws", "docker", "llm", "machine learning", "skills", "tools"]
  },
  publications: {
    aliases: ["research publications", "publications", "selected publications", "papers"],
    keywords: ["journal", "conference", "doi", "published", "submitted", "et al", "vol."]
  },
  projects: {
    aliases: ["projects", "project experience", "selected projects"],
    keywords: ["project", "built", "implemented", "developed", "deployed"]
  },
  certifications: {
    aliases: ["certifications", "licenses", "certificates"],
    keywords: ["certified", "certificate", "license"]
  },
  awards: {
    aliases: ["awards", "honors", "achievements"],
    keywords: ["award", "honor", "winner", "finalist"]
  },
  other: {
    aliases: [
      "work authorization",
      "authorization",
      "additional information",
      "additional details",
      "references",
      "miscellaneous",
      "misc",
      "other information",
      "volunteer experience",
      "volunteer",
      "interests",
      "activities"
    ],
    keywords: []
  }
};

function normalizeHeading(line) {
  return line.toLowerCase().replace(/[:\-–—]+$/g, "").replace(/\s+/g, " ").trim();
}

function tokenize(input) {
  return normalizeHeading(input)
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function tokenOverlapScore(a, b) {
  const aTokens = new Set(tokenize(a));
  const bTokens = new Set(tokenize(b));
  if (!aTokens.size || !bTokens.size) return 0;
  let shared = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) shared += 1;
  }
  const union = aTokens.size + bTokens.size - shared;
  return union ? shared / union : 0;
}

function contentScore(lines, keywords) {
  if (!lines.length || !keywords.length) return 0;
  const sample = lines.slice(0, 8).join(" ").toLowerCase();
  let hits = 0;
  for (const keyword of keywords) {
    if (sample.includes(keyword.toLowerCase())) hits += 1;
  }
  return Math.min(1, hits / Math.max(1, keywords.length / 2));
}

function detectSection(line) {
  const normalized = normalizeHeading(line);
  let best = { section: null, score: 0 };
  for (const [section, definition] of Object.entries(SECTION_DEFINITIONS)) {
    for (const alias of definition.aliases) {
      const score = tokenOverlapScore(normalized, alias);
      if (score > best.score) {
        best = { section, score };
      }
    }
  }
  return best.score >= 0.5 ? best.section : null;
}

function cleanBullet(line) {
  return line.replace(/^[•·\-\u2022]\s*/, "").trim();
}

function collectEntries(lines) {
  const entries = [];
  let current = [];
  let sawBulletInCurrent = false;

  for (const line of lines) {
    const cleaned = cleanBullet(line);
    if (!cleaned) continue;

    const isBullet = /^[•·\-\u2022]\s*/.test(line);

    if (isBullet) {
      sawBulletInCurrent = true;
      current.push(cleaned);
      continue;
    }

    if (sawBulletInCurrent && current.length) {
      entries.push(current.join(" ").trim());
      current = [];
      sawBulletInCurrent = false;
    } else if (!sawBulletInCurrent && current.length) {
      current.push(cleaned);
      continue;
    }

    current.push(cleaned);
  }

  if (current.length) {
    entries.push(current.join(" ").trim());
  }

  return entries;
}

function extractTimeRange(text) {
  if (!text) return "";
  const month =
    "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?";
  const year = "(?:19|20)\\d{2}";
  const point = `(?:${month}\\s*,?\\s*${year}|${year}\\s+${month}|${year})`;
  const end = `(?:present|current|now|${point})`;
  const pattern = new RegExp(`(${point}\\s*[-–—]\\s*${end})`, "i");
  const ranged = text.match(pattern)?.[1]?.trim();
  if (ranged) return ranged;

  // Handle compact internship formats like "Jun-Aug 2022".
  const compact = text.match(
    new RegExp(`(${month}\\s*[-–—]\\s*${month}\\s*,?\\s*${year})`, "i")
  )?.[1];
  if (compact) return compact.trim();

  // Handle single date markers like "May, 2024" for education.
  const single = text.match(new RegExp(`(${month}\\s*,?\\s*${year}|${year})`, "i"))?.[1];
  return single?.trim() || "";
}

function isLikelyContactLine(text) {
  const t = String(text || "").toLowerCase();
  return /@|https?:\/\/|linkedin|github/.test(t) || /\+?\(?\d{3}\)?[\s.-]*\d{3}[\s.-]*\d{4}/.test(t);
}

function extractLocation(text) {
  if (!text) return "";
  const segments = text
    .split("|")
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (segments.length < 2) return "";
  return segments[segments.length - 1];
}

function normalizeLineList(lines) {
  return lines.map((line) => line.trim()).filter(Boolean);
}

function isLikelyLocationSegment(text) {
  if (!text) return false;
  return /(?:,\s*[a-z]{2}|usa|china|canada|united states|ca|ny|tx|in|remote|hybrid|onsite|beijing|lafayette|san diego|santa clara)/i.test(
    text
  );
}

function isLikelyCompanySegment(text) {
  if (!text) return false;
  return /(?:inc|corp|llc|ltd|technologies|systems|data|institute|university|lab|labs|group|company|holding|memorial)/i.test(
    text
  );
}

function parseExperienceHeader(line) {
  const rawParts = line
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean);
  const timeRange = extractTimeRange(line);
  const cleanedParts = rawParts.map((part) => part.replace(timeRange, "").trim()).filter(Boolean);
  let company = "";
  let jobTitle = "";
  let location = "";

  if (cleanedParts.length >= 3) {
    [company, jobTitle] = cleanedParts;
    location = cleanedParts[2] || "";
  } else if (cleanedParts.length === 2) {
    const [first, second] = cleanedParts;
    if (isLikelyCompanySegment(first)) {
      company = first;
      jobTitle = second;
    } else {
      company = first;
      if (isLikelyLocationSegment(second)) location = second;
      else jobTitle = second;
    }
  } else if (cleanedParts.length === 1) {
    const solo = cleanedParts[0];
    if (isLikelyCompanySegment(solo)) company = solo;
    else jobTitle = solo;
  }

  if (!location) {
    for (const part of cleanedParts) {
      if (isLikelyLocationSegment(part)) {
        location = part;
        break;
      }
    }
  }

  return {
    company: company || "",
    jobTitle: jobTitle || "",
    role: jobTitle || "",
    location: location || "",
    timeRange: timeRange || "",
    bullets: []
  };
}

function parseExperienceLikeEntries(lines) {
  const cleaned = normalizeLineList(lines);
  const entries = [];
  let current = null;

  function looksLikeRoleOnlyLine(text) {
    const lower = text.toLowerCase();
    return (
      /\b(intern|engineer|scientist|manager|assistant|research|developer|analyst|lead|founding)\b/i.test(
        text
      ) && Boolean(extractTimeRange(text)) && !isLikelyCompanySegment(text)
    );
  }

  function startOrPushCurrent() {
    if (current) {
      entries.push(current);
    }
  }

  for (let i = 0; i < cleaned.length; i += 1) {
    const line = cleaned[i];
    const isBullet = /^[•·\-\u2022]\s*/.test(line);
    const plain = cleanBullet(line);

    if (isBullet && current) {
      current.bullets.push(plain);
      continue;
    }

    // Handle two-line headers:
    // Line 1: "Company Location", Line 2: "Role Jun-Aug 2022"
    if (!isBullet && !line.includes("|") && i + 1 < cleaned.length) {
      const nextLine = cleaned[i + 1];
      if (looksLikeRoleOnlyLine(nextLine) && !looksLikeRoleOnlyLine(line)) {
        startOrPushCurrent();
        const nextTimeRange = extractTimeRange(nextLine);
        const role = nextLine.replace(nextTimeRange, "").trim();
        const maybeLocationMatch = line.match(/(.+?)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)$/);
        const company = maybeLocationMatch?.[1]?.trim() || line.trim();
        const location = maybeLocationMatch?.[2]?.trim() || "";
        current = {
          company,
          jobTitle: role,
          role,
          location,
          timeRange: nextTimeRange,
          bullets: []
        };
        i += 1;
        continue;
      }

      // Handle: "Title, Company, Location" on one line, date range on the next line.
      // e.g. "Senior Machine Learning Engineer, Northstar AI, San Francisco, CA"
      //      "March 2021 - Present"
      const nextTimeRange = extractTimeRange(nextLine);
      const lineTimeRange = extractTimeRange(line);
      const hasJobTitleWord = /\b(engineer|scientist|manager|developer|analyst|lead|intern|researcher|consultant|specialist|director|vp|president|officer|architect|designer|coordinator|associate|programmer|administrator)\b/i.test(line);
      if (
        !lineTimeRange &&
        nextTimeRange &&
        hasJobTitleWord &&
        line.includes(",") &&
        !line.includes("|")
      ) {
        startOrPushCurrent();
        const commaParts = line.split(",").map((p) => p.trim()).filter(Boolean);
        current = {
          jobTitle: commaParts[0] || "",
          role: commaParts[0] || "",
          company: commaParts[1] || "",
          location: commaParts.slice(2).join(", ") || "",
          timeRange: nextTimeRange,
          bullets: []
        };
        i += 1;
        continue;
      }
    }

    const looksLikeHeader =
      line.includes("|") ||
      Boolean(extractTimeRange(line)) ||
      /(?:inc|corp|llc|ltd|university|institute|technologies|labs?)\b/i.test(line);

    if (looksLikeHeader) {
      startOrPushCurrent();
      current = parseExperienceHeader(line);
      if (!current.location) {
        current.location = extractLocation(line);
      }
      continue;
    }

    if (!current) {
      current = {
        company: "",
        jobTitle: "",
        location: "",
        timeRange: "",
        role: "",
        bullets: []
      };
    }

    current.bullets.push(plain);
  }

  if (current) {
    entries.push(current);
  }

  return entries.filter(
    (entry) =>
      entry.company || entry.jobTitle || entry.role || entry.timeRange || entry.bullets.length > 0
  );
}

function splitDegreeAndMajor(text) {
  const cleaned = text.replace(/^[\-•·]\s*/, "").trim();
  const degreeMatch = cleaned.match(
    /\b(ph\.?d|doctorate|m\.?s\.?|master(?:'s)?|b\.?s\.?|bachelor(?:'s)?|mba|ma|ba|associate)\b[^,;]*/i
  );
  const degree = degreeMatch?.[0]?.trim() || "";
  const inMajor = cleaned.match(/\bin\s+([^,;]+?)(?=\s*,|\s*$)/i);
  const major = inMajor?.[1]?.trim() || "";
  return { degree, major };
}

function parseEducationEntries(lines) {
  const cleaned = normalizeLineList(lines);
  const entries = [];
  let current = null;

  for (const line of cleaned) {
    const plain = cleanBullet(line);
    const lower = plain.toLowerCase();
    const isSchoolLine = /(?:university|college|institute|school)\b/i.test(plain);
    const timeRange = extractTimeRange(plain);
    const isDegreeLine = /\b(ph\.?d|m\.?s\.?|b\.?s\.?|master|bachelor|mba|major)\b/i.test(lower);

    if (timeRange && !isSchoolLine && !isDegreeLine) {
      if (!current) {
        current = {
          school: "",
          major: "",
          degree: "",
          timeRange: "",
          location: ""
        };
      }
      if (!current.timeRange) current.timeRange = timeRange;
      continue;
    }

    if (isSchoolLine) {
      if (current) {
        entries.push(current);
      }
      const schoolParts = plain.split(",").map((part) => part.trim()).filter(Boolean);
      const degreeInfo = isDegreeLine ? splitDegreeAndMajor(schoolParts[0] || plain) : { degree: "", major: "" };
      const uniIdx = schoolParts.findIndex((part) => /(?:university|college|institute|school)\b/i.test(part));
      let school;
      if (uniIdx >= 0) {
        school = schoolParts.slice(uniIdx).join(", ");
      } else {
        school = schoolParts.find((part) => /(?:university|college|institute|school)\b/i.test(part)) || schoolParts[0] || plain;
      }
      const schoolSegs = new Set(school.split(",").map((s) => s.trim().toLowerCase()));
      const location = schoolParts
        .filter((part) => part !== school && part !== (schoolParts[0] || ""))
        .filter((part) => !schoolSegs.has(part.toLowerCase()))
        .join(", ");
      current = {
        school,
        major: degreeInfo.major,
        degree: degreeInfo.degree,
        timeRange,
        location
      };
      continue;
    }

    if (!current) {
      current = {
        school: "",
        major: "",
        degree: "",
        timeRange: "",
        location: ""
      };
    }

    if (isDegreeLine) {
      const { degree, major } = splitDegreeAndMajor(plain);
      if (degree && !current.degree) current.degree = degree;
      if (major && !current.major) current.major = major;
      if (timeRange && !current.timeRange) current.timeRange = timeRange;
      continue;
    }

    if (!current.location && /(usa|china|ca|in|beijing|lafayette|san diego)/i.test(lower)) {
      current.location = plain;
      if (timeRange && !current.timeRange) current.timeRange = timeRange;
      continue;
    }

    if (!current.major && plain.length < 80) {
      current.major = plain;
    }
  }

  if (current) {
    entries.push(current);
  }

  // If a school has multiple degree lines, clone into separate entries by degree.
  const normalized = [];
  for (const entry of entries) {
    if (!entry.school && !entry.degree && !entry.major) continue;
    normalized.push(entry);
  }

  return normalized;
}

function flattenStructuredText(resumeData) {
  const output = [];
  const sections = [
    resumeData.summary,
    ...(resumeData.skills || []),
    ...(resumeData.publications || []),
    ...(resumeData.projects || []),
    ...(resumeData.certifications || []),
    ...(resumeData.awards || []),
    ...(resumeData.other || [])
  ];
  for (const item of sections) {
    if (item) output.push(String(item));
  }

  for (const entry of resumeData.education || []) {
    output.push(entry.school, entry.degree, entry.major, entry.timeRange, entry.location);
  }
  for (const entry of [...(resumeData.experience || []), ...(resumeData.internships || [])]) {
    output.push(
      entry.company,
      entry.jobTitle,
      entry.role,
      entry.location,
      entry.timeRange,
      ...(entry.bullets || [])
    );
  }
  return output.filter(Boolean).join("\n").toLowerCase();
}

function refineResumeDataFromSource(lines, resumeData) {
  const sourceLines = lines.map((line) => line.trim()).filter(Boolean);
  const existingText = flattenStructuredText(resumeData);
  const uncoveredLines = sourceLines.filter((line) => {
    const normalized = line.toLowerCase();
    if (normalized.length < 8) return false;
    if (isLikelyContactLine(normalized)) return false;
    return !existingText.includes(normalized);
  });

  // If coverage is weak, try to recover missed structured entries from uncovered text.
  const recoveredEducation = parseEducationEntries(
    uncoveredLines.filter((line) => /(?:university|college|institute|school|ph\.?d|master|bachelor|m\.?s\.?|b\.?s\.?)/i.test(line))
  );
  const recoveredExperience = parseExperienceLikeEntries(
    uncoveredLines.filter((line) =>
      /(?:\b(?:19|20)\d{2}\b|present|intern|engineer|scientist|manager|llc|corp|inc|company|technologies)/i.test(line) &&
      !/(?:university|college|institute|school|bachelor|master|ph\.?d|education)/i.test(line)
    )
  ).filter((entry) => (entry.company || entry.jobTitle || entry.role) && entry.timeRange);

  const education = mergeUniqueByKey(resumeData.education || [], recoveredEducation, (entry) =>
    `${entry.school}|${entry.degree}|${entry.major}`.toLowerCase()
  );
  const experience = mergeUniqueByKey(resumeData.experience || [], recoveredExperience, (entry) =>
    `${entry.company}|${entry.role}|${entry.timeRange}|${(entry.bullets || []).slice(0, 1).join("")}`.toLowerCase()
  );

  const diagnostics = {
    totalSourceLines: sourceLines.length,
    uncoveredLineCount: uncoveredLines.length,
    recoveredEducationCount: Math.max(0, education.length - (resumeData.education || []).length),
    recoveredExperienceCount: Math.max(0, experience.length - (resumeData.experience || []).length),
    coverageRatio:
      sourceLines.length > 0 ? Number(((sourceLines.length - uncoveredLines.length) / sourceLines.length).toFixed(3)) : 0
  };

  return {
    resumeData: {
      ...resumeData,
      education,
      experience
    },
    diagnostics
  };
}

function mergeUniqueByKey(existing, incoming, keyFn) {
  const map = new Map();
  for (const item of existing) {
    map.set(keyFn(item), item);
  }
  for (const item of incoming) {
    const key = keyFn(item);
    if (!map.has(key)) {
      map.set(key, item);
    }
  }
  return Array.from(map.values());
}

function normalizeWhitespace(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueStrings(values) {
  const seen = new Set();
  const output = [];
  for (const value of values || []) {
    const normalized = normalizeWhitespace(value);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(normalized);
  }
  return output;
}

function dedupeEducation(entries) {
  const seen = new Set();
  const output = [];
  for (const entry of entries || []) {
    const normalized = {
      school: normalizeWhitespace(entry.school),
      degree: normalizeWhitespace(entry.degree),
      major: normalizeWhitespace(entry.major),
      timeRange: normalizeWhitespace(entry.timeRange),
      location: normalizeWhitespace(entry.location)
    };
    const key = [
      normalized.school.toLowerCase(),
      normalized.degree.toLowerCase(),
      normalized.major.toLowerCase(),
      normalized.timeRange.toLowerCase()
    ].join("|");
    if (!key.replace(/\|/g, "")) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(normalized);
  }
  return output;
}

function dedupeExperience(entries) {
  const seen = new Set();
  const output = [];
  for (const entry of entries || []) {
    const normalized = {
      company: normalizeWhitespace(entry.company),
      jobTitle: normalizeWhitespace(entry.jobTitle || entry.role),
      role: normalizeWhitespace(entry.role || entry.jobTitle),
      location: normalizeWhitespace(entry.location),
      timeRange: normalizeWhitespace(entry.timeRange),
      bullets: uniqueStrings(entry.bullets || [])
    };
    const key = [
      normalized.company.toLowerCase(),
      normalized.jobTitle.toLowerCase(),
      normalized.timeRange.toLowerCase(),
      normalized.location.toLowerCase()
    ].join("|");
    if (!key.replace(/\|/g, "") && normalized.bullets.length === 0) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(normalized);
  }
  return output;
}

function normalizeResumeData(resumeData) {
  return {
    ...resumeData,
    summary: normalizeWhitespace(resumeData.summary),
    skills: uniqueStrings(resumeData.skills || []),
    publications: uniqueStrings(resumeData.publications || []),
    projects: uniqueStrings(resumeData.projects || []),
    certifications: uniqueStrings(resumeData.certifications || []),
    awards: uniqueStrings(resumeData.awards || []),
    other: uniqueStrings(resumeData.other || []),
    education: dedupeEducation(resumeData.education || []),
    experience: dedupeExperience(resumeData.experience || []),
    internships: dedupeExperience(resumeData.internships || [])
  };
}

function buildResumeData(lines) {
  const sections = {
    summary: [],
    experience: [],
    education: [],
    internships: [],
    skills: [],
    publications: [],
    projects: [],
    certifications: [],
    awards: [],
    other: []
  };

  let currentSection = "other";
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const explicitSection = detectSection(line);
    if (explicitSection) {
      currentSection = explicitSection;
      continue;
    }

    const headingLike = line === line.toUpperCase() || /[:\-–—]\s*$/.test(line);
    const shortLikelyHeading = headingLike && tokenize(line).length > 0 && tokenize(line).length <= 5 && !/[.,]/.test(line);
    if (shortLikelyHeading) {
      let inferred = null;
      let bestScore = 0;
      const lookAhead = lines.slice(i + 1, i + 9);
      for (const [section, definition] of Object.entries(SECTION_DEFINITIONS)) {
        const headingScore = definition.aliases.reduce(
          (max, alias) => Math.max(max, tokenOverlapScore(line, alias)),
          0
        );
        const semanticScore = contentScore(lookAhead, definition.keywords);
        const combined = headingScore * 0.45 + semanticScore * 0.55;
        if (combined > bestScore) {
          bestScore = combined;
          inferred = section;
        }
      }
      if (inferred && bestScore >= 0.42) {
        currentSection = inferred;
        continue;
      }
    }

    sections[currentSection].push(line);
  }

  const skillRows = sections.skills.join("\n").split(/\n/).map((row) => row.trim()).filter(Boolean);
  const skillItems = [];
  for (const row of skillRows) {
    const labeled = row.match(/^[^:]+:\s*(.+)$/);
    const segment = labeled ? labeled[1] : row;
    for (const raw of segment.split(/[|,]/)) {
      const item = raw.replace(/^[\-•·]\s*/, "").trim();
      if (item.length > 1) skillItems.push(item);
    }
  }

  return {
    summary: sections.summary.join(" "),
    experience: parseExperienceLikeEntries(sections.experience),
    education: parseEducationEntries(sections.education),
    internships: parseExperienceLikeEntries(sections.internships),
    skills: Array.from(new Set(skillItems)),
    publications: collectEntries(sections.publications),
    projects: collectEntries(sections.projects),
    certifications: collectEntries(sections.certifications),
    awards: collectEntries(sections.awards),
    other: uniqueStrings(sections.other)
  };
}

async function extractPdfText(file) {
  const buffer = await file.arrayBuffer();
  const data = new Uint8Array(buffer);
  const utf8Fallback = () => new TextDecoder("utf-8", { fatal: false }).decode(buffer);
  try {
    const pdfjs = await import("../../node_modules/pdfjs-dist/build/pdf.mjs");
    const { getDocument, GlobalWorkerOptions } = pdfjs;
    if (typeof chrome !== "undefined" && chrome.runtime?.getURL) {
      GlobalWorkerOptions.workerSrc = chrome.runtime.getURL(
        "node_modules/pdfjs-dist/build/pdf.worker.mjs"
      );
    }
    const loadingTask = getDocument({ data, isEvalSupported: false });
    const document = await loadingTask.promise;
    const pages = [];

    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const pageText = content.items
        .map((item) => ("str" in item ? item.str : ""))
        .join("\n")
        .trim();

      if (pageText) {
        pages.push(pageText);
      }
    }

    const extracted = pages.join("\n").trim();
    return extracted || utf8Fallback();
  } catch (_error) {
    // Keep a deterministic fallback so parsing still produces a result if pdf.js
    // fails due to unusual browser/runtime constraints.
    return utf8Fallback();
  }
}

async function extractResumeText(file) {
  const name = String(file?.name || "").toLowerCase();
  const type = String(file?.type || "").toLowerCase();
  if (type.startsWith("text/") || name.endsWith(".txt")) {
    return file.text();
  }
  return extractPdfText(file);
}

/** Rule-based stages only (no PDF, no OpenAI). For tests / `npm run eval:parse`. */
export function evaluateRuleParseFromPlainText(text) {
  const lines = extractLines(text);
  const joined = lines.join("\n");
  const initialResumeData = buildResumeData(lines);
  const { resumeData: refinedResumeData, diagnostics } = refineResumeDataFromSource(lines, initialResumeData);
  const resumeData = normalizeResumeData(refinedResumeData);
  const email = extractFirst(/([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i, joined);
  const phone = extractPhoneNumber(joined);
  return { lines, joined, resumeData, diagnostics, email, phone };
}

function extractYearFromRange(timeRange) {
  const matches = String(timeRange || "").match(/\b(20\d{2}|19\d{2})\b/g);
  if (!matches) return "";
  return matches[matches.length - 1];
}

function estimateYearsOfExperience(experience) {
  const allYears = (experience || [])
    .flatMap((e) => String(e.timeRange || "").match(/\b(20\d{2}|19\d{2})\b/g) || [])
    .map(Number);
  if (!allYears.length) return "";
  const earliest = Math.min(...allYears);
  const years = new Date().getFullYear() - earliest;
  return years > 0 && years < 60 ? String(years) : "";
}

export async function parsePdfLocally(file) {
  const text = await extractResumeText(file);
  if (!String(text || "").trim()) {
    throw new Error(
      "Could not extract text from this file. If it is a scanned/image-only PDF, export it as text-searchable PDF (OCR) or upload a .txt resume."
    );
  }
  const lines = extractLines(text);
  const joined = lines.join("\n");

  let resumeData;
  let parseSource;
  let diagnostics = {};
  let aiError = "";

  let aiResult;
  try {
    aiResult = await parseResumeWithOpenAI(text);
  } catch (error) {
    aiResult = {
      ok: false,
      error: error instanceof Error ? `AI request failed: ${error.message}` : "AI request failed"
    };
  }
  if (aiResult.ok) {
    resumeData = normalizeResumeData(aiResult.resumeData);
    parseSource = "openai+json";
    diagnostics = { parseMode: "ai-primary" };
  } else {
    aiError = aiResult.error || "AI parse unavailable";
    const rule = evaluateRuleParseFromPlainText(text);
    resumeData = rule.resumeData;
    parseSource = "rule+fallback";
    diagnostics = {
      ...rule.diagnostics,
      aiError,
      parseMode: "rules-fallback"
    };
  }

  const email = extractFirst(/([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i, joined);
  const phone = extractPhoneNumber(joined);
  const linkedin =
    extractFirst(/(https?:\/\/(?:www\.)?linkedin\.com\/[^\s]+)/i, joined) ||
    extractFirst(/((?:www\.)?linkedin\.com\/[^\s]+)/i, joined);
  const github =
    extractFirst(/(https?:\/\/(?:www\.)?github\.com\/[^\s]+)/i, joined) ||
    extractFirst(/((?:www\.)?github\.com\/[^\s]+)/i, joined);
  const website = extractFirst(
    /(https?:\/\/(?!www\.linkedin\.com|www\.github\.com|github\.com)[^\s]+)/i,
    joined
  );
  const fullName = lines[0] || "";
  const nameParts = fullName.trim().split(/\s+/);
  const firstName = nameParts[0] || "";
  const lastName = nameParts.slice(1).join(" ") || "";

  const mostRecentExp = resumeData.experience?.[0] || resumeData.internships?.[0] || {};
  const mostRecentEdu = resumeData.education?.[0] || {};

  const skillSummary = resumeData.skills.slice(0, 20).join(", ");
  const sectionCoverage =
    Number(Boolean(resumeData.summary)) +
    Number(resumeData.experience.length > 0) +
    Number(resumeData.education.length > 0) +
    Number(resumeData.skills.length > 0) +
    Number(resumeData.publications.length > 0);
  const coverageRatio =
    typeof diagnostics.coverageRatio === "number" ? diagnostics.coverageRatio : 0;

  let confidence;
  if (parseSource === "openai+json") {
    confidence = Math.min(
      0.97,
      0.55 +
        Number(Boolean(email || phone)) * 0.15 +
        sectionCoverage * 0.06
    );
  } else {
    confidence = Math.min(
      0.75,
      0.25 +
        Number(Boolean(email || phone)) * 0.15 +
        sectionCoverage * 0.08 +
        Math.min(0.12, coverageRatio * 0.12)
    );
  }

  return {
    fileName: file.name,
    fileHash: hashString(`${file.name}:${file.size}:${file.lastModified}`),
    parsedAt: new Date().toISOString(),
    parseSource,
    confidence,
    rawPreview: lines.slice(0, 20).join(" | "),
    diagnostics,
    resumeData,
    profilePatch: {
      fullName,
      firstName,
      lastName,
      email,
      phone,
      linkedin,
      github: github || "",
      website: website || "",
      currentTitle: mostRecentExp.jobTitle || mostRecentExp.role || "",
      currentCompany: mostRecentExp.company || "",
      yearsOfExperience: estimateYearsOfExperience(resumeData.experience),
      highestDegree: mostRecentEdu.degree || "",
      major: mostRecentEdu.major || "",
      university: mostRecentEdu.school || "",
      graduationYear: extractYearFromRange(mostRecentEdu.timeRange) || "",
      summary: resumeData.summary,
      skills: skillSummary
    }
  };
}
