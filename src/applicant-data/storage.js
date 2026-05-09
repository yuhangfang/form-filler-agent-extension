import { mergeProfileWithDefaults } from "./profile-defaults.js";

const KEYS = {
  profile: "profile.v1",
  resumeRecord: "resumeRecord.v1",
  userContent: "userContent.v1",
  fieldHints: "fieldHints.v1",
  siteSkills: "siteSkills.v1"
};

const USER_CONTENT_FIELD_BY_KEY = {
  [KEYS.profile]: "profile",
  [KEYS.resumeRecord]: "resumeRecord",
  [KEYS.fieldHints]: "fieldHints"
};

function defaultUserContent() {
  return {
    files: {},
    profile: {},
    resumeRecord: null,
    fieldHints: []
  };
}

function normalizeUserContent(input) {
  const value = input && typeof input === "object" ? input : {};
  return {
    files: value.files && typeof value.files === "object" ? value.files : {},
    profile: value.profile && typeof value.profile === "object" ? value.profile : {},
    resumeRecord: value.resumeRecord ?? null,
    fieldHints: Array.isArray(value.fieldHints) ? value.fieldHints : []
  };
}

function normalizeProfile(input) {
  const value = input && typeof input === "object" ? input : {};
  return {
    ...value,
    registerPassword: String(value.registerPassword || "")
  };
}

/** Profile for all fill / evaluate / LLM field paths (saved values only, no demo defaults). */
export async function getProfileForFill() {
  const raw = await getLocal(KEYS.profile, {});
  return mergeProfileWithDefaults(raw);
}

export { mergeProfileWithDefaults, DEFAULT_QUICK_PROFILE } from "./profile-defaults.js";

export async function getLocal(key, fallbackValue) {
  const result = await chrome.storage.local.get(key);
  if (result[key] === undefined) {
    const userContentField = USER_CONTENT_FIELD_BY_KEY[key];
    if (userContentField) {
      const userContent = await getLocal(KEYS.userContent, defaultUserContent());
      if (userContent[userContentField] !== undefined && userContent[userContentField] !== null) {
        return key === KEYS.profile ? normalizeProfile(userContent[userContentField]) : userContent[userContentField];
      }
    }
    return fallbackValue;
  }
  if (key === KEYS.profile) return normalizeProfile(result[key]);
  return result[key];
}

export async function setLocal(key, value) {
  const normalizedValue = key === KEYS.profile ? normalizeProfile(value) : value;
  await chrome.storage.local.set({ [key]: normalizedValue });
  const userContentField = USER_CONTENT_FIELD_BY_KEY[key];
  if (userContentField) {
    const userContent = await getLocal(KEYS.userContent, defaultUserContent());
    const updated = { ...userContent, [userContentField]: normalizedValue };
    await chrome.storage.local.set({ [KEYS.userContent]: updated });
  }
}

function bytesToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export async function saveResumeFileToUserContent(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const userContent = await getLocal(KEYS.userContent, defaultUserContent());
  const updated = {
    ...userContent,
    files: {
      resumePdf: {
        name: file.name,
        type: file.type || (String(file.name || "").toLowerCase().endsWith(".txt") ? "text/plain" : "application/pdf"),
        size: file.size,
        lastModified: file.lastModified,
        uploadedAt: new Date().toISOString(),
        dataBase64: bytesToBase64(bytes)
      }
    }
  };
  await chrome.storage.local.set({ [KEYS.userContent]: updated });
}

export async function getAllLocalData() {
  return chrome.storage.local.get(null);
}

export async function clearAllLocalData() {
  await chrome.storage.local.clear();
}

export async function importUserContentSnapshot(snapshot) {
  const normalized = normalizeUserContent(snapshot?.[KEYS.userContent] ?? snapshot?.userContent);
  const profile = normalizeProfile(snapshot?.[KEYS.profile] ?? normalized.profile ?? {});
  const resumeRecord = snapshot?.[KEYS.resumeRecord] ?? normalized.resumeRecord ?? null;
  const fieldHints = snapshot?.[KEYS.fieldHints] ?? normalized.fieldHints ?? [];

  await chrome.storage.local.set({
    [KEYS.userContent]: {
      ...normalized,
      profile,
      resumeRecord,
      fieldHints
    },
    [KEYS.profile]: profile,
    [KEYS.resumeRecord]: resumeRecord,
    [KEYS.fieldHints]: fieldHints
  });
}

const MAX_FIELD_HINTS = 2000;

export async function getFieldHints() {
  return getLocal(KEYS.fieldHints, []);
}

export function normalizeQuestionKey(text) {
  const raw = String(text || "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!raw) return "";
  return raw
    .split(" ")
    .filter((w) => w.length > 1)
    .slice(0, 24)
    .join(" ");
}

function dedupeStrings(values) {
  const out = [];
  const seen = new Set();
  for (const v of values) {
    const s = String(v || "").trim();
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

function chooseLabelContext(existing, incoming) {
  const a = String(existing || "").trim();
  const b = String(incoming || "").trim();
  if (!a) return b;
  if (!b) return a;
  return b.length >= a.length ? b : a;
}

function normalizeLearnedAlias(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter((w) => w.length > 1)
    .slice(0, 32)
    .join(" ");
}

function isMachineGeneratedAlias(alias) {
  const s = String(alias || "").trim().toLowerCase();
  if (!s) return true;
  if (/^field\s+\d+$/i.test(s)) return true;
  if (/^field\s+[0-9a-f]{6,}$/i.test(s)) return true;
  if (/^cards?(?:\s+[0-9a-f]{4,}){2,}\s+field\d+$/i.test(s)) return true;
  const tokens = s.split(/\s+/).filter(Boolean);
  if (tokens.length >= 3) {
    const machineLikeCount = tokens.filter((t) => /^(?:\d+|[0-9a-f]{4,})$/i.test(t)).length;
    if (machineLikeCount / tokens.length >= 0.75) return true;
  }
  return false;
}

function pickHintStoredValue(hint) {
  if (!hint || typeof hint !== "object") return "";
  const corrected = String(hint.correctedValue ?? "").trim();
  if (corrected) return corrected;
  const value = String(hint.value ?? "").trim();
  if (value) return value;
  const guessed = String(hint.lastGuessedValue ?? "").trim();
  if (guessed) return guessed;
  if (Array.isArray(hint.answerValues)) {
    for (const v of hint.answerValues) {
      const s = String(v || "").trim();
      if (s) return s;
    }
  }
  return "";
}

function normalizeHintAliasList(values) {
  return dedupeStrings(Array.isArray(values) ? values : [])
    .map((alias) => normalizeLearnedAlias(alias))
    .filter((alias) => alias.length >= 3 && !isMachineGeneratedAlias(alias))
    .slice(0, 8);
}

function hintAliasList(hint) {
  return normalizeHintAliasList([
    ...(Array.isArray(hint?.learnedAliases) ? hint.learnedAliases : []),
    hint?.questionKey || "",
    hint?.labelContext || ""
  ]);
}

/** @param {{ domain: string, canonicalKey?: string, learnedAliases?: string[], value?: string, correctedValue?: string|null, lastGuessedValue?: string, answerValues?: string[], source?: string, questionKey?: string, labelContext?: string }} entry */
export async function upsertFieldHint(entry) {
  const domain = String(entry?.domain || "").trim();
  if (!domain) return;
  const list = await getLocal(KEYS.fieldHints, []);
  const ck = String(entry?.canonicalKey || "").trim().toLowerCase();
  const normalizedQuestionKey = normalizeQuestionKey(entry?.questionKey || entry?.labelContext || "");
  const entryAliases = normalizeHintAliasList([
    ...(Array.isArray(entry?.learnedAliases) ? entry.learnedAliases : []),
    normalizedQuestionKey
  ]);
  const existing = list.find((x) => {
    if (!x || x.domain !== domain) return false;
    const xCk = String(x.canonicalKey || "").trim().toLowerCase();
    if (ck && xCk && xCk === ck) return true;
    const xAliases = hintAliasList(x);
    if (!xAliases.length || !entryAliases.length) return false;
    return entryAliases.some((alias) => xAliases.includes(alias));
  }) || null;
  const value = pickHintStoredValue(entry) || pickHintStoredValue(existing);
  if (!value) return;
  const next = list.filter((x) => x !== existing);
  const learnedAliases = normalizeHintAliasList([
    ...hintAliasList(existing),
    ...entryAliases
  ]);
  const source = String(entry?.source || existing?.source || "").trim();
  const compactHint = { domain, canonicalKey: ck, value, learnedAliases, source };
  next.unshift(compactHint);
  await setLocal(KEYS.fieldHints, next.slice(0, MAX_FIELD_HINTS));
}

export async function getFieldHint(domain, fingerprint, questionKey = "", canonicalKey = "") {
  const list = await getLocal(KEYS.fieldHints, []);
  const qk = normalizeQuestionKey(questionKey);
  const ck = String(canonicalKey || "").trim().toLowerCase();
  return (
    list.find(
      (x) =>
        x.domain === domain &&
        ((ck && String(x.canonicalKey || "").toLowerCase() === ck) ||
          (qk && hintAliasList(x).includes(qk)))
    ) || null
  );
}

function fieldHintMatchesDeletionTarget(stored, entryOrId) {
  if (typeof entryOrId === "string") {
    const id = entryOrId.trim().toLowerCase();
    const storedCk = String(stored?.canonicalKey || "").trim().toLowerCase();
    return Boolean(id && (storedCk === id || `${stored?.domain || ""}::semantic::${storedCk}` === id));
  }
  if (!entryOrId || typeof entryOrId !== "object") return false;
  const domain = String(entryOrId.domain || "").trim();
  if (!domain || stored.domain !== domain) return false;
  const ck = String(entryOrId.canonicalKey || "").trim().toLowerCase();
  if (ck && String(stored.canonicalKey || "").trim().toLowerCase() === ck) return true;
  const aliases = normalizeHintAliasList(entryOrId.learnedAliases || []);
  if (aliases.length) return aliases.some((alias) => hintAliasList(stored).includes(alias));
  return false;
}

/** @param {string | object} entryOrId — hint id, or full hint row (used when `id` is missing). */
export async function deleteFieldHint(entryOrId) {
  const list = await getLocal(KEYS.fieldHints, []);
  const next = list.filter((x) => !fieldHintMatchesDeletionTarget(x, entryOrId));
  await setLocal(KEYS.fieldHints, next);
}

/**
 * Site skills — learned per-domain fill strategies.
 * Stored as a map: { [domain]: SiteSkill }.
 * Skills are learned by the site agent and persist across sessions.
 */

export async function getSiteSkill(domain) {
  const map = await getLocal(KEYS.siteSkills, {});
  return map[domain] || null;
}

export async function saveSiteSkill(domain, skill) {
  const map = await getLocal(KEYS.siteSkills, {});
  await chrome.storage.local.set({ [KEYS.siteSkills]: { ...map, [domain]: { ...skill, domain } } });
}

export async function updateSiteSkillSuccess(domain) {
  const map = await getLocal(KEYS.siteSkills, {});
  const existing = map[domain];
  if (!existing) return;
  await chrome.storage.local.set({
    [KEYS.siteSkills]: {
      ...map,
      [domain]: {
        ...existing,
        successCount: (existing.successCount || 0) + 1,
        lastUsedAt: new Date().toISOString()
      }
    }
  });
}

export async function deleteSiteSkill(domain) {
  const map = await getLocal(KEYS.siteSkills, {});
  const updated = { ...map };
  delete updated[domain];
  await chrome.storage.local.set({ [KEYS.siteSkills]: updated });
}

export async function getAllSiteSkills() {
  return getLocal(KEYS.siteSkills, {});
}

export { KEYS };
