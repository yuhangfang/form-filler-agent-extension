import { parsePdfLocally } from "../applicant-data/resume-parser.js";
import {
  KEYS,
  clearAllLocalData,
  deleteFieldHint,
  getAllLocalData,
  getFieldHints,
  getLocal,
  importUserContentSnapshot,
  saveResumeFileToUserContent,
  setLocal
} from "../applicant-data/storage.js";

const resumeFileInput = document.getElementById("resumeFile");
const resumeStatus = document.getElementById("resumeStatus");
const refreshResumeDataButton = document.getElementById("refreshResumeData");
const skillsList = document.getElementById("skillsList");
const experienceStructured = document.getElementById("experienceStructured");
const internshipsStructured = document.getElementById("internshipsStructured");
const educationStructured = document.getElementById("educationStructured");
const fieldHintsContainer = document.getElementById("fieldHintsContainer");

const fullNameInput = document.getElementById("fullName");
const firstNameInput = document.getElementById("firstName");
const lastNameInput = document.getElementById("lastName");
const emailInput = document.getElementById("email");
const registerPasswordInput = document.getElementById("registerPassword");
const phoneInput = document.getElementById("phone");
const addressInput = document.getElementById("address");
const cityInput = document.getElementById("city");
const stateInput = document.getElementById("state");
const zipInput = document.getElementById("zip");
const countryInput = document.getElementById("country");
const linkedinInput = document.getElementById("linkedin");
const githubInput = document.getElementById("github");
const websiteInput = document.getElementById("website");
const currentTitleInput = document.getElementById("currentTitle");
const currentCompanyInput = document.getElementById("currentCompany");
const yearsOfExperienceInput = document.getElementById("yearsOfExperience");
const highestDegreeInput = document.getElementById("highestDegree");
const majorInput = document.getElementById("major");
const universityInput = document.getElementById("university");
const graduationYearInput = document.getElementById("graduationYear");
const workAuthorizationInput = document.getElementById("workAuthorization");
const requiresSponsorshipInput = document.getElementById("requiresSponsorship");
const desiredSalaryInput = document.getElementById("desiredSalary");
const noticePeriodInput = document.getElementById("noticePeriod");
const willingToRelocateInput = document.getElementById("willingToRelocate");
const genderInput = document.getElementById("gender");
const ethnicityInput = document.getElementById("ethnicity");
const veteranStatusInput = document.getElementById("veteranStatus");
const disabilityStatusInput = document.getElementById("disabilityStatus");
const saveProfileButton = document.getElementById("saveProfile");

const fillStatus = document.getElementById("fillStatus");
const exportStorageButton = document.getElementById("exportStorage");
const importStorageFileInput = document.getElementById("importStorageFile");
const clearStorageButton = document.getElementById("clearStorage");
const storageSummary = document.getElementById("storageSummary");

init();

function initProfileTabs() {
  const tablist = document.querySelector('[role="tablist"]');
  if (!tablist) return;
  const tabs = [...tablist.querySelectorAll('[role="tab"]')];

  function activateTab(selected) {
    for (const tab of tabs) {
      const isSelected = tab === selected;
      tab.setAttribute("aria-selected", String(isSelected));
      tab.tabIndex = isSelected ? 0 : -1;
      const panelId = tab.getAttribute("aria-controls");
      const panel = panelId ? document.getElementById(panelId) : null;
      if (panel) panel.hidden = !isSelected;
    }
  }

  for (const tab of tabs) {
    tab.addEventListener("click", () => activateTab(tab));
  }

  tablist.addEventListener("keydown", (e) => {
    const focused = document.activeElement;
    const i = tabs.indexOf(focused);
    if (i < 0) return;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      const ni = (i + 1) % tabs.length;
      activateTab(tabs[ni]);
      tabs[ni].focus();
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      const ni = (i - 1 + tabs.length) % tabs.length;
      activateTab(tabs[ni]);
      tabs[ni].focus();
    }
  });
}

async function init() {
  initProfileTabs();

  const profile = await getLocal(KEYS.profile, {});
  setProfileInputs(profile);

  const userContent = await getLocal(KEYS.userContent, null);
  const storedResume = userContent?.files?.resumePdf;
  if (storedResume?.name) {
    resumeStatus.textContent = `Stored resume available: ${storedResume.name}`;
  }
  await renderResumeDataView();
  await renderStorageSummary();
  initLiveStorageRefresh();
}

let liveRefreshTimer = null;
function scheduleLiveRefresh() {
  if (liveRefreshTimer) clearTimeout(liveRefreshTimer);
  liveRefreshTimer = setTimeout(async () => {
    liveRefreshTimer = null;
    await renderFieldHintsView();
    await renderStorageSummary();
  }, 120);
}

function initLiveStorageRefresh() {
  if (!chrome?.storage?.onChanged?.addListener) return;
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes) return;
    if (changes[KEYS.fieldHints] || changes[KEYS.userContent]) {
      scheduleLiveRefresh();
    }
  });
}

function isResumePdfOrTxt(file) {
  const name = String(file?.name || "").toLowerCase();
  if (name.endsWith(".pdf") || name.endsWith(".txt")) return true;
  const t = String(file?.type || "").toLowerCase();
  return t === "application/pdf" || t === "text/plain";
}

resumeFileInput.addEventListener("change", async () => {
  const file = resumeFileInput.files?.[0];
  if (!file) return;

  if (!isResumePdfOrTxt(file)) {
    resumeStatus.textContent = "Please upload a PDF or plain text (.txt) resume.";
    resumeFileInput.value = "";
    return;
  }

  try {
    await setLocal(KEYS.resumeRecord, null);
    await saveResumeFileToUserContent(file);
    resumeStatus.textContent = `Saved ${file.name}. Parsing…`;
    await renderResumeDataView();
    await renderStorageSummary();

    const parseRecord = await parsePdfLocally(file);
    const currentProfile = await getLocal(KEYS.profile, {});
    const mergedProfile = { ...currentProfile, ...stripEmpty(parseRecord.profilePatch) };

    await setLocal(KEYS.resumeRecord, parseRecord);
    await setLocal(KEYS.profile, mergedProfile);
    setProfileInputs(mergedProfile);
    resumeStatus.textContent = `Parsed ${parseRecord.fileName}. Confidence ${(parseRecord.confidence * 100).toFixed(0)}%.`;
    await renderResumeDataView();
    await renderStorageSummary();
  } catch (error) {
    resumeStatus.textContent =
      error instanceof Error ? error.message : "Failed to save or parse resume.";
  }
});

saveProfileButton.addEventListener("click", async () => {
  const profile = readProfileInputs();
  await setLocal(KEYS.profile, profile);
  fillStatus.textContent = "Profile saved locally.";
  await renderStorageSummary();
});

refreshResumeDataButton.addEventListener("click", async () => {
  await renderResumeDataView();
});

exportStorageButton.addEventListener("click", async () => {
  const allData = await getAllLocalData();
  const json = JSON.stringify(allData, null, 2);
  downloadTextFile(json, `form-filler-storage-${new Date().toISOString().slice(0, 19)}.json`);
  storageSummary.textContent = "Downloaded storage JSON.";
});

importStorageFileInput.addEventListener("change", async () => {
  const file = importStorageFileInput.files?.[0];
  if (!file) return;

  try {
    const raw = await file.text();
    const parsed = JSON.parse(raw);
    await importUserContentSnapshot(parsed);

    const profile = await getLocal(KEYS.profile, {});
    setProfileInputs(profile);
    const userContent = await getLocal(KEYS.userContent, null);
    const resumeName = userContent?.files?.resumePdf?.name;
    resumeStatus.textContent = resumeName
      ? `Imported storage. Stored resume: ${resumeName}`
      : "Imported storage.";
    storageSummary.textContent = "Storage import complete.";
    await renderResumeDataView();
    await renderStorageSummary();
  } catch (error) {
    storageSummary.textContent =
      error instanceof Error ? `Import failed: ${error.message}` : "Import failed.";
  } finally {
    importStorageFileInput.value = "";
  }
});

clearStorageButton?.addEventListener("click", async () => {
  const ok = window.confirm(
    "Remove all extension data on this device?\n\nThis deletes your Quick Profile, resume upload, parsed resume, learned field hints, and memories.\n\nDownload storage first if you want a backup."
  );
  if (!ok) return;

  try {
    await clearAllLocalData();
    setProfileInputs({});
    resumeStatus.textContent = "";
    fillStatus.textContent = "All saved extension data was cleared.";
    await renderResumeDataView();
    await renderStorageSummary();
  } catch (error) {
    fillStatus.textContent =
      error instanceof Error ? `Clear failed: ${error.message}` : "Clear failed.";
  }
});

function readProfileInputs() {
  return {
    fullName: fullNameInput.value.trim(),
    firstName: firstNameInput.value.trim(),
    lastName: lastNameInput.value.trim(),
    email: emailInput.value.trim(),
    registerPassword: registerPasswordInput.value.trim(),
    phone: phoneInput.value.trim(),
    address: addressInput.value.trim(),
    city: cityInput.value.trim(),
    state: stateInput.value.trim(),
    zip: zipInput.value.trim(),
    country: countryInput.value.trim(),
    linkedin: linkedinInput.value.trim(),
    github: githubInput.value.trim(),
    website: websiteInput.value.trim(),
    currentTitle: currentTitleInput.value.trim(),
    currentCompany: currentCompanyInput.value.trim(),
    yearsOfExperience: yearsOfExperienceInput.value.trim(),
    highestDegree: highestDegreeInput.value.trim(),
    major: majorInput.value.trim(),
    university: universityInput.value.trim(),
    graduationYear: graduationYearInput.value.trim(),
    workAuthorization: workAuthorizationInput.value.trim(),
    requiresSponsorship: requiresSponsorshipInput.value.trim(),
    desiredSalary: desiredSalaryInput.value.trim(),
    noticePeriod: noticePeriodInput.value.trim(),
    willingToRelocate: willingToRelocateInput.value.trim(),
    gender: genderInput.value.trim(),
    ethnicity: ethnicityInput.value.trim(),
    veteranStatus: veteranStatusInput.value.trim(),
    disabilityStatus: disabilityStatusInput.value.trim()
  };
}

function setProfileInputs(profile) {
  fullNameInput.value = profile.fullName || "";
  firstNameInput.value = profile.firstName || "";
  lastNameInput.value = profile.lastName || "";
  emailInput.value = profile.email || "";
  registerPasswordInput.value = profile.registerPassword || "";
  phoneInput.value = profile.phone || "";
  addressInput.value = profile.address || "";
  cityInput.value = profile.city || "";
  stateInput.value = profile.state || "";
  zipInput.value = profile.zip || "";
  countryInput.value = profile.country || "";
  linkedinInput.value = profile.linkedin || "";
  githubInput.value = profile.github || "";
  websiteInput.value = profile.website || "";
  currentTitleInput.value = profile.currentTitle || "";
  currentCompanyInput.value = profile.currentCompany || "";
  yearsOfExperienceInput.value = profile.yearsOfExperience || "";
  highestDegreeInput.value = profile.highestDegree || "";
  majorInput.value = profile.major || "";
  universityInput.value = profile.university || "";
  graduationYearInput.value = profile.graduationYear || "";
  workAuthorizationInput.value = profile.workAuthorization || "";
  requiresSponsorshipInput.value = profile.requiresSponsorship || "";
  desiredSalaryInput.value = profile.desiredSalary || "";
  noticePeriodInput.value = profile.noticePeriod || "";
  willingToRelocateInput.value = profile.willingToRelocate || "";
  genderInput.value = profile.gender || "";
  ethnicityInput.value = profile.ethnicity || "";
  veteranStatusInput.value = profile.veteranStatus || "";
  disabilityStatusInput.value = profile.disabilityStatus || "";
}

function stripEmpty(record) {
  return Object.fromEntries(Object.entries(record).filter(([, v]) => Boolean(v)));
}

async function renderStorageSummary() {
  const allData = await getAllLocalData();
  const sizeBytes = new TextEncoder().encode(JSON.stringify(allData)).length;
  const userContent = allData[KEYS.userContent] || {};
  const hasResume = Boolean(userContent?.files?.resumePdf?.name);
  const fieldHintsCount = Array.isArray(allData[KEYS.fieldHints]) ? allData[KEYS.fieldHints].length : 0;

  storageSummary.textContent = [
    `Storage size ~ ${Math.round(sizeBytes / 1024)} KB`,
    `stored resume: ${hasResume ? "yes" : "no"}`,
    `field hints: ${fieldHintsCount}`
  ].join(" | ");
}

function downloadTextFile(content, fileName) {
  const blob = new Blob([content], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function renderResumeDataView() {
  const resumeRecord = await getLocal(KEYS.resumeRecord, null);
  if (!resumeRecord) {
    renderList(skillsList, [], "No parsed skills yet.");
    renderStructuredExperience(experienceStructured, [], "No parsed experience yet.");
    renderStructuredExperience(internshipsStructured, [], "No parsed internships yet.");
    renderStructuredEducation(educationStructured, [], "No parsed education yet.");
  } else {
    const structured = resumeRecord.resumeData || {};
    renderList(skillsList, structured.skills || [], "No parsed skills yet.");
    renderStructuredExperience(experienceStructured, structured.experience || [], "No parsed experience yet.");
    renderStructuredExperience(internshipsStructured, structured.internships || [], "No parsed internships yet.");
    renderStructuredEducation(educationStructured, structured.education || [], "No parsed education yet.");
  }

  await renderFieldHintsView();
}

async function renderFieldHintsView() {
  if (!fieldHintsContainer) return;
  fieldHintsContainer.innerHTML = "";
  const hints = await getFieldHints();
  const list = Array.isArray(hints) ? hints : [];
  if (!list.length) {
    const p = document.createElement("p");
    p.className = "empty-item";
    p.textContent =
      "No saved hints yet. Submit a form or fill from the page toolbar, then refresh.";
    fieldHintsContainer.appendChild(p);
    return;
  }

  // Group by domain, most-recent-updated first within each domain
  const sorted = [...list].sort((a, b) => {
    const dc = String(a.domain || "").localeCompare(String(b.domain || ""));
    if (dc !== 0) return dc;
    return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
  });

  const byDomain = new Map();
  for (const h of sorted) {
    const d = h.domain || "unknown";
    if (!byDomain.has(d)) byDomain.set(d, []);
    byDomain.get(d).push(h);
  }

  const MAX_PER_DOMAIN = 25;
  const MAX_TOTAL = 120;
  let totalShown = 0;

  for (const [, domainHints] of byDomain) {
    if (totalShown >= MAX_TOTAL) break;

    for (const h of domainHints.slice(0, MAX_PER_DOMAIN)) {
      if (totalShown >= MAX_TOTAL) break;
      const question = pickHintQuestion(h);
      const answer = pickBestHintAnswer(h);
      if (!question && !answer) continue;

      const row = document.createElement("div");
      row.className = "hint-qa-row";

      const q = document.createElement("span");
      q.className = "hint-question";
      q.textContent = question || "—";

      const answerLine = document.createElement("div");
      answerLine.className = "hint-answer-line";

      const badge = document.createElement("span");
      badge.className = `hint-badge hint-badge-${hintBadgeClass(h.source)}`;
      badge.textContent = hintBadgeLabel(h.source);

      const a = document.createElement("span");
      a.className = "hint-answer";
      a.textContent = answer || "—";

      const del = document.createElement("button");
      del.className = "hint-delete-btn";
      del.textContent = "×";
      del.title = "Delete this saved field";
      del.addEventListener("click", async () => {
        await deleteFieldHint(h.id || h);
        row.remove();
        await renderStorageSummary();
      });

      answerLine.appendChild(badge);
      answerLine.appendChild(a);
      answerLine.appendChild(del);
      row.appendChild(q);
      row.appendChild(answerLine);
      fieldHintsContainer.appendChild(row);
      totalShown += 1;
    }

    if (domainHints.length > MAX_PER_DOMAIN) {
      const more = document.createElement("p");
      more.className = "hints-footer";
      more.textContent = `+${domainHints.length - MAX_PER_DOMAIN} more — export JSON to see all`;
      fieldHintsContainer.appendChild(more);
    }
  }

  if (sorted.length > MAX_TOTAL) {
    const foot = document.createElement("p");
    foot.className = "hints-footer";
    foot.textContent = `Showing ${MAX_TOTAL} of ${sorted.length} total. Export Storage JSON for the full list.`;
    fieldHintsContainer.appendChild(foot);
  }
}

function pickHintQuestion(hint) {
  // Prefer the canonical key — it's a clean, stable semantic label set by the LLM.
  const ck = String(hint.canonicalKey || "").trim();
  if (ck) {
    // Convert camelCase → "Work Authorization" style
    return ck
      .replace(/([A-Z])/g, " $1")
      .replace(/^./, (s) => s.toUpperCase())
      .trim();
  }
  const raw = String(hint.labelContext || hint.questionKey || "").trim();
  if (!raw) return `field ${String(hint.fingerprint || "").slice(0, 8)}`;
  const firstSeg = cleanHintQuestionText(raw.split(/\s{3,}|\n/)[0].trim() || raw);
  // Strip leading machine-generated IDs (tokens with digits mixed with letters/underscores)
  const cleaned = firstSeg.replace(/^(\w*\d\w*\s+)+/, "").trim();
  const result = cleaned || firstSeg;
  return result.charAt(0).toUpperCase() + result.slice(1);
}

function pickBestHintAnswer(hint) {
  const corrected = normalizeHintDisplayValue(String(hint.correctedValue ?? "").trim());
  if (corrected) return corrected;
  const value = normalizeHintDisplayValue(String(hint.value ?? "").trim());
  if (value) return value;
  if (Array.isArray(hint.answerValues)) {
    for (const v of hint.answerValues) {
      const s = normalizeHintDisplayValue(String(v || "").trim());
      if (s) return s;
    }
  }
  return normalizeHintDisplayValue(String(hint.lastGuessedValue ?? "").trim());
}

function normalizeHintDisplayValue(value) {
  const s = String(value || "").trim();
  if (!s) return "";
  const parts = s.split("|").map((x) => x.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const unique = [];
    const seen = new Set();
    for (const p of parts) {
      const k = p.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      unique.push(p);
    }
    if (unique.length === 1) return unique[0];
  }
  return s.replace(/\s+/g, " ");
}

function cleanHintQuestionText(value) {
  return String(value || "")
    .replace(/\b[0-9a-f]{8}\s+[0-9a-f]{4}\s+[0-9a-f]{4}\s+[0-9a-f]{4}\s+[0-9a-f]{12}\b/gi, " ")
    .replace(/\[[0-9a-f-]{8,}\]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hintBadgeLabel(source) {
  if (source === "llm+corrected" || source === "user" || source === "corrected") return "corrected";
  if (source === "submit") return "learned";
  if (source === "llm") return "AI";
  return source || "";
}

function hintBadgeClass(source) {
  if (source === "llm+corrected" || source === "user" || source === "corrected") return "corrected";
  if (source === "submit") return "learned";
  if (source === "llm") return "ai";
  return "other";
}

function renderList(target, values, emptyMessage) {
  target.innerHTML = "";
  const cleaned = values
    .map((v) => (typeof v === "string" ? v.trim() : String(v)))
    .filter(Boolean);
  if (!cleaned.length) {
    const p = document.createElement("p");
    p.className = "empty-item";
    p.textContent = emptyMessage;
    target.appendChild(p);
    return;
  }
  for (const value of cleaned) {
    const tag = document.createElement("span");
    tag.className = "skill-tag";
    tag.textContent = value;
    target.appendChild(tag);
  }
}

function renderStructuredEducation(container, entries, emptyMessage) {
  container.innerHTML = "";
  const list = Array.isArray(entries) ? entries : [];
  const normalized = list
    .map((e) =>
      typeof e === "string"
        ? { school: e.trim(), degree: "", major: "", timeRange: "", location: "" }
        : e
    )
    .filter(
      (e) => e && typeof e === "object" && (e.school || e.degree || e.major || e.timeRange || e.location)
    );
  if (!normalized.length) {
    const p = document.createElement("p");
    p.className = "empty-item";
    p.textContent = emptyMessage;
    container.appendChild(p);
    return;
  }

  for (const edu of normalized) {
    const card = document.createElement("div");
    card.className = "resume-card";

    const header = document.createElement("div");
    header.className = "resume-card-header";
    const school = document.createElement("span");
    school.className = "resume-card-title";
    school.textContent = edu.school || "—";

    let timeText = edu.timeRange || "";
    if (edu.startDate || edu.endDate) {
      const s = [edu.startDate?.month, edu.startDate?.year].filter(Boolean).join("/");
      let e = edu.endDate?.isCurrent ? "Present" : [edu.endDate?.month, edu.endDate?.year].filter(Boolean).join("/");
      if (s || e) timeText = `${s || "?"} - ${e || "?"}`;
    }
    
    const time = document.createElement("span");
    time.className = "resume-card-time";
    time.textContent = timeText;
    header.appendChild(school);
    header.appendChild(time);

    const meta = [edu.degree, edu.major, edu.location].filter(Boolean).join(" · ");
    const metaEl = document.createElement("div");
    metaEl.className = "resume-card-meta";
    metaEl.textContent = meta || "";

    card.appendChild(header);
    if (meta) card.appendChild(metaEl);
    container.appendChild(card);
  }
}

function renderStructuredExperience(container, entries, emptyMessage) {
  container.innerHTML = "";
  const list = Array.isArray(entries) ? entries : [];
  const normalized = list
    .map((e) =>
      typeof e === "string"
        ? { company: e.trim(), jobTitle: "", role: "", location: "", timeRange: "", bullets: [] }
        : e
    )
    .filter(
      (e) =>
        e &&
        typeof e === "object" &&
        (e.company || e.jobTitle || e.role || e.timeRange || e.location || e.bullets?.length)
    );
  if (!normalized.length) {
    const p = document.createElement("p");
    p.className = "empty-item";
    p.textContent = emptyMessage;
    container.appendChild(p);
    return;
  }

  for (const job of normalized) {
    const card = document.createElement("div");
    card.className = "resume-card";

    const header = document.createElement("div");
    header.className = "resume-card-header";
    const company = document.createElement("span");
    company.className = "resume-card-title";
    company.textContent = job.company || "—";

    let timeText = job.timeRange || "";
    if (job.startDate || job.endDate) {
      const s = [job.startDate?.month, job.startDate?.year].filter(Boolean).join("/");
      let e = job.endDate?.isCurrent ? "Present" : [job.endDate?.month, job.endDate?.year].filter(Boolean).join("/");
      if (s || e) timeText = `${s || "?"} - ${e || "?"}`;
    }

    const time = document.createElement("span");
    time.className = "resume-card-time";
    time.textContent = timeText;
    header.appendChild(company);
    header.appendChild(time);

    const titleText = job.jobTitle || job.role || "";
    const meta = [titleText, job.location].filter(Boolean).join(" · ");
    const metaEl = document.createElement("div");
    metaEl.className = "resume-card-meta";
    metaEl.textContent = meta || "";

    const bullets = Array.isArray(job.bullets)
      ? job.bullets.map((b) => String(b).trim()).filter(Boolean)
      : [];

    card.appendChild(header);
    if (meta) card.appendChild(metaEl);

    if (bullets.length) {
      const ul = document.createElement("ul");
      ul.className = "resume-card-bullets";
      for (const b of bullets) {
        const li = document.createElement("li");
        li.textContent = b;
        ul.appendChild(li);
      }
      card.appendChild(ul);
    }

    container.appendChild(card);
  }
}
