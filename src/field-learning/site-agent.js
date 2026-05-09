/**
 * Site agent — learns how to fill forms on any website.
 *
 * Flow (first visit to a domain):
 *   1. Inject page-tools.js into the page
 *   2. Run always-on observation tools to get a baseline picture
 *   3. Ask LLM (via background) which extra probes to run
 *   4. Run those probes
 *   5. Ask LLM to build a "site skill" from all observations
 *   6. Save the skill to storage
 *
 * Flow (returning visit):
 *   - Load the saved skill (if fresh and confident) and return immediately.
 *   - On successful fill, increment skill's successCount.
 */
import { deleteSiteSkill, getAllSiteSkills, getSiteSkill, saveSiteSkill, updateSiteSkillSuccess } from "../applicant-data/storage.js";

const SKILL_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days before re-learning

const ALWAYS_RUN_TOOLS = [
  "scanStandardControls",
  "scanAriaWidgets",
  "scanDataAttributes",
  "scanFramework",
  "scanIframes",
  "extractLabelSample",
  "scanShadowDOM",
  "probeAllInteractableFields"
];

async function runPageTool(tabId, toolName, args = []) {
  try {
    const rows = await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      func: (name, a) => {
        const fn = globalThis.__runPageTool;
        return typeof fn === "function" ? fn(name, ...a) : { error: "page-tools not loaded" };
      },
      args: [toolName, args]
    });
    return rows?.[0]?.result ?? { error: "no result" };
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

async function gatherObservations(tabId, toolNames) {
  const obs = {};
  for (const tool of toolNames) {
    obs[tool] = await runPageTool(tabId, tool);
  }
  return obs;
}

async function callBackground(type, payload) {
  return chrome.runtime.sendMessage({ type, payload });
}

function buildFallbackSkill(domain) {
  return {
    platform: "standard",
    platformLabel: "Standard HTML form",
    labelMethod: "mixed",
    dropdownType: "standard",
    needsAriaCombobox: false,
    needsAsyncInteraction: false,
    fieldIdentifier: "name",
    primaryFieldSelector: "",
    iframeForm: false,
    shadowDomForm: false,
    confidence: 0.4,
    notes: "Fallback — site agent could not analyze the page.",
    domain,
    learnedAt: new Date().toISOString(),
    successCount: 0,
    fromFallback: true
  };
}

/**
 * Run the full site detection agent for a tab.
 * Returns a SiteSkill object (from cache or freshly learned).
 *
 * @param {number} tabId
 * @param {string} domain
 * @returns {Promise<SiteSkill>}
 */
export async function runSiteAgent(tabId, domain) {
  // 1. Return cached skill if it's still fresh and confident
  const cached = await getSiteSkill(domain);
  if (cached && !cached.fromFallback) {
    const ageMs = Date.now() - new Date(cached.learnedAt || 0).getTime();
    if (ageMs < SKILL_TTL_MS && (cached.confidence || 0) >= 0.6) {
      return { ...cached, fromCache: true };
    }
  }

  // 2. Inject page tools
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      files: ["src/browser-capture/page-tools.js"]
    });
  } catch {
    return buildFallbackSkill(domain);
  }

  // 3. Run always-on tools
  const observations = await gatherObservations(tabId, ALWAYS_RUN_TOOLS);

  // 4. Ask LLM which extra probes to run (agentic tool-selection step)
  const probeSelectResp = await callBackground("SITE_AGENT_ANALYZE", {
    phase: "probe_select",
    domain,
    observations
  });

  if (probeSelectResp?.ok && Array.isArray(probeSelectResp.result?.probes)) {
    for (const probe of probeSelectResp.result.probes.slice(0, 4)) {
      const toolName = probe.tool;
      const args = Array.isArray(probe.args) ? probe.args : [];
      const key = args.length ? `${toolName}(${JSON.stringify(args)})` : toolName;
      observations[key] = await runPageTool(tabId, toolName, args);
    }
  }

  // 5. Ask LLM to build the full site skill from all observations
  const skillResp = await callBackground("SITE_AGENT_ANALYZE", {
    phase: "build_skill",
    domain,
    observations
  });

  if (!skillResp?.ok || !skillResp.result?.platform) {
    const fallback = buildFallbackSkill(domain);
    await saveSiteSkill(domain, fallback);
    return fallback;
  }

  // 6. Persist the learned skill
  const skill = {
    ...skillResp.result,
    domain,
    learnedAt: new Date().toISOString(),
    successCount: cached?.successCount || 0,
    lastUsedAt: new Date().toISOString(),
    observations // keep for debugging / re-analysis
  };
  await saveSiteSkill(domain, skill);

  return skill;
}

/**
 * Call after a successful fill run to reinforce the skill's confidence score.
 * @param {string} domain
 */
export async function recordSkillSuccess(domain) {
  await updateSiteSkillSuccess(domain);
}

/**
 * Force re-learn a domain (clears cached skill so next visit re-runs the agent).
 * @param {string} domain
 */
export async function forgetSiteSkill(domain) {
  await deleteSiteSkill(domain);
}

export { getAllSiteSkills };
