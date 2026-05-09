/**
 * Single source of truth for profile-field identity and matching metadata.
 *
 * Keep per-field metadata here; compatibility modules derive their exported maps
 * from this catalog so new fields are added in one place.
 */
(function attachProfileFieldCatalog(global) {

const PROFILE_FIELD_DEFINITIONS = [
  {
    key: "fullName",
    label: "Full name",
    aliases: [
      "full name",
      "legal name",
      "full legal name",
      "name",
      "display name",
      "your name",
      "applicant name",
      "first name last name",
      "first & last name",
      "first and last name"
    ]
  },
  {
    key: "firstName",
    label: "First name",
    aliases: ["first name", "given name", "forename", "first"]
  },
  {
    key: "lastName",
    label: "Last name",
    aliases: ["last name", "surname", "family name", "last"]
  },
  {
    key: "email",
    label: "Email",
    aliases: ["email", "e-mail", "email address", "work email", "contact email", "mail", "correo"]
  },
  {
    key: "phone",
    label: "Phone",
    aliases: [
      "phone",
      "phone number",
      "mobile",
      "mobile number",
      "cell",
      "cell phone",
      "telephone",
      "contact number",
      "tel",
      "whatsapp"
    ]
  },
  {
    key: "linkedin",
    label: "LinkedIn",
    aliases: ["linkedin", "linkedin url", "linkedin profile", "linkedin link"]
  },
  {
    key: "github",
    label: "GitHub",
    aliases: ["github", "github url", "github profile", "github link", "github username"]
  },
  {
    key: "website",
    label: "Website",
    aliases: [
      "website",
      "portfolio",
      "personal site",
      "personal website",
      "homepage",
      "portfolio url",
      "personal url",
      "url"
    ]
  },
  {
    key: "address",
    label: "Address",
    aliases: [
      "address",
      "street address",
      "street",
      "address line 1",
      "address line1",
      "mailing address",
      "home address",
      "residential address"
    ]
  },
  {
    key: "city",
    label: "City",
    aliases: [
      "city",
      "town",
      "locality",
      "municipality",
      "city of residence",
      "location",
      "current location",
      "your location",
      "where are you located",
      "where are you based",
      "where do you live"
    ]
  },
  {
    key: "state",
    label: "State",
    aliases: ["state", "province", "region", "state province", "state or province"]
  },
  {
    key: "zip",
    label: "ZIP/postal code",
    aliases: ["zip", "postal code", "zip code", "postcode", "postal", "zip postal code"]
  },
  {
    key: "country",
    label: "Country",
    aliases: ["country", "nation", "country of residence", "country name"]
  },
  {
    key: "currentTitle",
    label: "Current title",
    aliases: [
      "current title",
      "job title",
      "position",
      "title",
      "current position",
      "current job title",
      "role",
      "current role",
      "job position",
      "your title",
      "your current title",
      "occupation"
    ]
  },
  {
    key: "currentCompany",
    label: "Current company",
    aliases: [
      "current company",
      "current employer",
      "company",
      "employer",
      "organization",
      "current organization",
      "your company",
      "company name",
      "employer name",
      "workplace"
    ]
  },
  {
    key: "yearsOfExperience",
    label: "Years of experience",
    aliases: [
      "years of experience",
      "years experience",
      "experience years",
      "total experience",
      "years of work experience",
      "how many years",
      "total years of experience",
      "professional experience years"
    ]
  },
  {
    key: "highestDegree",
    label: "Highest degree",
    aliases: [
      "degree",
      "highest degree",
      "education level",
      "highest education",
      "level of education",
      "educational background",
      "qualification",
      "degree type",
      "academic degree"
    ]
  },
  {
    key: "major",
    label: "Major",
    aliases: [
      "major",
      "field of study",
      "degree major",
      "area of study",
      "concentration",
      "study field",
      "specialization",
      "course of study"
    ]
  },
  {
    key: "university",
    label: "University",
    aliases: [
      "university",
      "college",
      "school",
      "institution",
      "alma mater",
      "educational institution",
      "university college"
    ]
  },
  {
    key: "graduationYear",
    label: "Graduation year",
    aliases: ["graduation year", "year of graduation", "graduated", "graduation date"]
  },
  {
    key: "workAuthorization",
    label: "Work authorization",
    aliases: [
      "work authorization",
      "visa status",
      "authorized to work",
      "authorised to work",
      "legally authorized to work",
      "legally authorised to work",
      "work permit",
      "work eligibility",
      "us work authorization",
      "right to work",
      "employment authorization",
      "visa type",
      "immigration status"
    ]
  },
  {
    key: "requiresSponsorship",
    label: "Sponsorship",
    aliases: [
      "sponsorship",
      "require sponsorship",
      "visa sponsorship",
      "need sponsorship",
      "require work sponsorship",
      "will you need sponsorship",
      "employer sponsorship",
      "need for employer sponsorship",
      "without the need for employer sponsorship"
    ]
  },
  {
    key: "desiredSalary",
    label: "Desired salary",
    aliases: [
      "desired salary",
      "expected salary",
      "salary expectation",
      "salary range",
      "compensation expectation",
      "salary requirement",
      "expected compensation",
      "target salary",
      "salary expectations"
    ]
  },
  {
    key: "noticePeriod",
    label: "Notice period",
    aliases: [
      "notice period",
      "notice",
      "availability date",
      "available date",
      "earliest start date",
      "when can you start",
      "start date",
      "available to start",
      "how soon can you start"
    ]
  },
  {
    key: "willingToRelocate",
    label: "Willing to relocate",
    aliases: [
      "willing to relocate",
      "relocation",
      "open to relocation",
      "willing to move",
      "relocate",
      "are you willing to relocate"
    ]
  },
  {
    key: "gender",
    label: "Gender",
    aliases: ["gender", "gender identity", "sex", "gender expression", "what is your gender"]
  },
  {
    key: "pronouns",
    label: "Pronouns",
    aliases: [
      "pronouns",
      "preferred pronouns",
      "what are your pronouns",
      "your pronouns",
      "please select your pronouns",
      "which pronouns"
    ]
  },
  {
    key: "ethnicity",
    label: "Race/ethnicity",
    aliases: ["race", "ethnicity", "race/ethnicity", "racial background", "ethnic group", "racial or ethnic"]
  },
  {
    key: "veteranStatus",
    label: "Veteran status",
    aliases: [
      "veteran",
      "veteran status",
      "military service",
      "protected veteran",
      "served in the military",
      "military veteran"
    ]
  },
  {
    key: "disabilityStatus",
    label: "Disability status",
    aliases: [
      "disability",
      "disability status",
      "have a disability",
      "person with a disability",
      "accommodation",
      "disabled"
    ]
  },
  {
    key: "registerPassword",
    label: "Register password",
    aliases: ["register password", "password", "create password"]
  }
];

/**
 * Canonical shape of parsed resume objects (`profile.__resumeData` / `resumeRecord.resumeData`).
 * Aligns with `applicant-data/resume-parser.js` (`normalizeResumeData` and AI parse output).
 * Repeatable form rows read from these arrays using {@link REPEATABLE_SECTION_DEFINITIONS}.
 */
const RESUME_DATA_SCHEMA = {
  version: 1,
  root: {
    summary: { kind: "string", label: "Professional summary" },
    skills: { kind: "string[]", label: "Skills" },
    education: { kind: "array", itemShape: "educationEntry", resumeKey: "education", label: "Education" },
    experience: { kind: "array", itemShape: "experienceEntry", resumeKey: "experience", label: "Experience" },
    internships: { kind: "array", itemShape: "experienceEntry", resumeKey: "internships", label: "Internships" },
    publications: { kind: "string[]", label: "Publications" },
    projects: { kind: "string[]", label: "Projects" },
    certifications: { kind: "string[]", label: "Certifications" },
    awards: { kind: "string[]", label: "Awards" },
    other: { kind: "string[]", label: "Other" }
  },
  entryShapes: {
    educationEntry: {
      school: { type: "string" },
      degree: { type: "string" },
      major: { type: "string" },
      location: { type: "string" },
      timeRange: { type: "string" },
      startDate: { type: "object" },
      endDate: { type: "object" }
    },
    experienceEntry: {
      company: { type: "string" },
      jobTitle: { type: "string" },
      role: { type: "string" },
      description: { type: "string" },
      bullets: { type: "string[]" },
      location: { type: "string" },
      timeRange: { type: "string" },
      startDate: { type: "object" },
      endDate: { type: "object" }
    }
  }
};

/**
 * Repeatable ATS sections: DOM label cues → logical field → resume property on row objects.
 * `slotKey` is the synthetic key returned by the fill engine for tracing (not a Quick Profile key).
 *
 * @typedef {{ aliases: string[], slotKey: string, resumeProperty?: string, resumeFallbackProperty?: string, computed?: "date"|"current"|"description"|"websiteRow" }} RepeatableFieldDef
 */
const REPEATABLE_SECTION_DEFINITIONS = {
  education: {
    label: "Education",
    resumeArrays: ["education"],
    aliases: [
      "education",
      "school",
      "degree",
      "academic",
      "university",
      "college",
      "major",
      "field of study",
      "discipline",
      "graduation"
    ],
    fields: {
      school: {
        aliases: ["school", "university", "college", "institution"],
        slotKey: "educationSchool",
        resumeProperty: "school"
      },
      degree: {
        aliases: ["degree", "qualification", "education level"],
        slotKey: "educationDegree",
        resumeProperty: "degree"
      },
      major: {
        aliases: ["major", "field of study", "discipline", "course of study", "area of study", "concentration"],
        slotKey: "educationMajor",
        resumeProperty: "major"
      },
      location: {
        aliases: ["location", "city", "state", "country"],
        slotKey: "educationLocation",
        resumeProperty: "location"
      },
      date: {
        aliases: [
          "graduation",
          "graduated",
          "start date",
          "end date",
          "start month",
          "end month",
          "start year",
          "end year",
          "from",
          "to",
          "month",
          "year",
          "date"
        ],
        slotKey: "educationDate",
        computed: "date"
      }
    }
  },
  experience: {
    label: "Work experience",
    resumeArrays: ["experience", "internships"],
    aliases: [
      "work experience",
      "employment",
      "employment history",
      "work history",
      "professional experience",
      "job history",
      "organization",
      "role",
      "position",
      "responsibilities",
      "current job",
      "currently work",
      "i currently work",
      "present"
    ],
    fields: {
      current: {
        aliases: ["currently", "current job", "present", "i currently work"],
        slotKey: "experienceCurrent",
        computed: "current"
      },
      company: {
        aliases: ["company", "employer", "organization", "workplace"],
        slotKey: "experienceCompany",
        resumeProperty: "company"
      },
      description: {
        aliases: ["description", "responsibilities", "summary", "duties", "achievements"],
        slotKey: "experienceDescription",
        computed: "description"
      },
      title: {
        aliases: ["job title", "title", "role", "position", "occupation"],
        slotKey: "experienceTitle",
        resumeProperty: "jobTitle",
        resumeFallbackProperty: "role"
      },
      location: {
        aliases: ["location", "city", "state", "country"],
        slotKey: "experienceLocation",
        resumeProperty: "location"
      },
      date: {
        aliases: ["start date", "end date", "start month", "end month", "start year", "end year", "from", "to", "month", "year", "date"],
        slotKey: "experienceDate",
        computed: "date"
      }
    }
  },
  website: {
    label: "Website",
    resumeArrays: [],
    aliases: ["website", "websites", "web address", "social", "social link", "online profile"],
    fields: {
      name: {
        aliases: ["type", "name", "label", "platform", "network"],
        slotKey: "websiteName",
        resumeProperty: "name",
        computed: "websiteRow"
      },
      url: {
        aliases: ["website", "url", "link", "address", "web address", "online profile"],
        slotKey: "websiteUrl",
        resumeProperty: "url",
        computed: "websiteRow"
      }
    }
  }
};

const PROFILE_FIELD_KEYS = PROFILE_FIELD_DEFINITIONS.map((field) => field.key);

const PROFILE_FIELD_LABELS = Object.fromEntries(
  PROFILE_FIELD_DEFINITIONS.map((field) => [field.key, field.label])
);

const FIELD_ALIASES = Object.fromEntries(
  PROFILE_FIELD_DEFINITIONS.map((field) => [field.key, field.aliases])
);

function escapeRegExp(input) {
  return String(input).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Match catalog aliases as tokens/phrases, not arbitrary substrings ("work" inside "workplace").
 */
function aliasMatchesWordBoundary(normLower, aliasLower) {
  if (!aliasLower || !normLower) return false;
  const escaped = escapeRegExp(aliasLower.toLowerCase());
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(normLower);
}

function bestProfileFieldKeyForNormalizedText(normLower) {
  let bestKey = "";
  let bestLen = 0;
  for (const [key, aliases] of Object.entries(FIELD_ALIASES)) {
    for (const alias of aliases) {
      if (!aliasMatchesWordBoundary(normLower, alias.toLowerCase())) continue;
      if (alias.length > bestLen) {
        bestLen = alias.length;
        bestKey = key;
      }
    }
  }
  return bestKey;
}

/**
 * Map question/context text to a Quick Profile key.
 * @param {string} context — full question + surrounding context (may include long EEO boilerplate).
 * @param {string|string[]|undefined} shortHints — label, name, or pipe-separated chunks tried first so "City"
 *   wins over "gender identity" / "military service" buried in the same block.
 */
function inferProfileFieldKey(context, shortHints) {
  const tryHints = [];
  if (shortHints) {
    if (Array.isArray(shortHints)) tryHints.push(...shortHints);
    else tryHints.push(shortHints);
  }
  for (const raw of tryHints) {
    const norm = String(raw || "").toLowerCase().trim();
    if (!norm) continue;
    const key = bestProfileFieldKeyForNormalizedText(norm);
    if (key) return key;
  }
  const normFull = String(context || "").toLowerCase();
  return bestProfileFieldKeyForNormalizedText(normFull);
}

function normalizeText(input) {
  return String(input || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function hasAnyTerm(text, terms) {
  const norm = normalizeText(text);
  if (!norm) return false;
  return (terms || []).some((term) => {
    const normalizedTerm = normalizeText(term);
    if (!normalizedTerm) return false;
    return new RegExp(`\\b${escapeRegExp(normalizedTerm)}\\b`, "i").test(norm);
  });
}

function repeatableKindFromText(text) {
  for (const [kind, definition] of Object.entries(REPEATABLE_SECTION_DEFINITIONS)) {
    if (hasAnyTerm(text, definition.aliases)) return kind;
  }
  return "";
}

function repeatableFieldKindFromText(sectionKind, text) {
  const fields = REPEATABLE_SECTION_DEFINITIONS[sectionKind]?.fields || {};
  for (const [fieldKind, def] of Object.entries(fields)) {
    const aliases = def?.aliases;
    if (Array.isArray(aliases) && hasAnyTerm(text, aliases)) return fieldKind;
  }
  return "";
}

function getRepeatableFieldDef(sectionKind, fieldKind) {
  if (!fieldKind) return null;
  return REPEATABLE_SECTION_DEFINITIONS[sectionKind]?.fields?.[fieldKind] || null;
}

function collectResumeEntriesForRepeatableSection(sectionKind, resumeData, profile, buildWebsiteEntries) {
  if (sectionKind === "website") {
    return typeof buildWebsiteEntries === "function" ? buildWebsiteEntries(profile) : [];
  }
  const keys = REPEATABLE_SECTION_DEFINITIONS[sectionKind]?.resumeArrays ?? [];
  return keys.flatMap((k) => (Array.isArray(resumeData?.[k]) ? resumeData[k] : []));
}

const catalog = {
  PROFILE_FIELD_DEFINITIONS,
  RESUME_DATA_SCHEMA,
  REPEATABLE_SECTION_DEFINITIONS,
  PROFILE_FIELD_KEYS,
  PROFILE_FIELD_LABELS,
  FIELD_ALIASES,
  inferProfileFieldKey,
  repeatableKindFromText,
  repeatableFieldKindFromText,
  getRepeatableFieldDef,
  collectResumeEntriesForRepeatableSection
};

global.__formFillerProfileFieldCatalog = catalog;
global.__formFiller_PROFILE_FIELD_DEFINITIONS = PROFILE_FIELD_DEFINITIONS;
global.__formFiller_FIELD_ALIASES = FIELD_ALIASES;
global.__formFiller_PROFILE_FIELD_LABELS = PROFILE_FIELD_LABELS;
})(typeof globalThis !== "undefined" ? globalThis : window);
