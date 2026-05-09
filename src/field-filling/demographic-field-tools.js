/**
 * Demographic and self-identification field policy.
 *
 * Keep sensitive, topic-specific answer policy out of the page fill engine.
 * This module is DOM-light: page-fill-engine supplies field context and uses
 * browser-tools for the actual writes.
 */
(function attachDemographicFieldTools(global) {
  function normalize(input) {
    return String(input || "").toLowerCase().replace(/\s+/g, " ").trim();
  }

  function choiceCandidatesForProfileValue(value, profileKey = "") {
    const raw = String(value || "").trim();
    const norm = normalize(raw);
    const out = [];
    const push = (v) => {
      const text = String(v || "").trim();
      if (text && !out.some((x) => normalize(x) === normalize(text))) out.push(text);
    };
    push(raw);
    if (/disabilityStatus/i.test(profileKey) || /\b(disabilit|disabled)\b/i.test(norm)) {
      if (/\b(prefer not|decline|do not want|do not wish|dont want|don't want|not answer|no answer)\b/i.test(norm)) {
        push("I do not want to answer");
        push("prefer not to answer");
      } else if (/\b(no disability|not disabled|do not have|don't have|dont have|without disability)\b/i.test(norm)) {
        push("No, I do not have a disability and have not had one in the past");
        push("No");
      } else if (/^(yes|true)$/i.test(raw) || /\bi have a disability\b|\bhave had one in the past\b/i.test(raw)) {
        push("Yes, I have a disability, or have had one in the past");
        push("Yes");
      } else {
        push("I do not want to answer");
        push("prefer not to answer");
      }
    }
    return out;
  }

  function resolveDisabilityProfileValue(profile, options = {}) {
    const debug = typeof options.debug === "function" ? options.debug : null;
    const direct = String(profile?.disabilityStatus || "").trim();
    if (direct) {
      debug?.("checkbox:disability_profile_value", { source: "disabilityStatus", value: direct });
      return direct;
    }
    const text = normalize(JSON.stringify(profile || {}));
    if (!/\b(disabilit|disabled|disable)\b/i.test(text)) {
      debug?.("checkbox:disability_profile_value", { source: "default_no_signal", value: "I do not want to answer" });
      return "I do not want to answer";
    }
    if (/\b(prefer not|decline|do not want|do not wish|dont want|don't want|not answer|no answer)\b/i.test(text)) {
      debug?.("checkbox:disability_profile_value", { source: "profile_text_prefer_not", value: "I do not want to answer" });
      return "I do not want to answer";
    }
    if (/\b(no disability|not disabled|do not have a disability|don't have a disability|dont have a disability)\b/i.test(text)) {
      debug?.("checkbox:disability_profile_value", { source: "profile_text_no", value: "No" });
      return "No";
    }
    // Disability disclosure is sensitive; do not infer "Yes" from loose text.
    debug?.("checkbox:disability_profile_value", { source: "profile_text_ambiguous", value: "I do not want to answer" });
    return "I do not want to answer";
  }

  function selfIdentifyDatePartValue({ role, type, label, context, now = new Date() } = {}) {
    if (role !== "spinbutton" && type !== "number") return "";
    const ctx = normalize(context);
    if (!/\bdate\b/i.test(ctx) || /\b(work experience|education|from|to|start|end)\b/i.test(ctx)) return "";
    const name = normalize(label);
    if (/\bmonth\b|datesectionmonth/i.test(name)) return String(now.getMonth() + 1);
    if (/\bday\b|datesectionday/i.test(name)) return String(now.getDate());
    if (/\byear\b|datesectionyear/i.test(name)) return String(now.getFullYear());
    return "";
  }

  function isDemographicCanonicalKey(key) {
    return /^(gender|ethnicity|veteranStatus|disabilityStatus)$/i.test(String(key || "").trim());
  }

  function looksLikeDemographicChoiceAnswer(value) {
    const text = normalize(String(value || ""));
    if (!text) return false;
    return /\b(disabilit|disabled|veteran|race|ethnicity|hispanic|latino|male|female|nonbinary|non binary|decline|prefer not|do not want to answer|do not wish to answer)\b/i.test(text);
  }

  function shouldRejectChoiceAnswerForText({ canonicalKey, value, localName, targetText } = {}) {
    const choiceAnswer = isDemographicCanonicalKey(canonicalKey) || looksLikeDemographicChoiceAnswer(value);
    if (!choiceAnswer) return false;
    const local = normalize(localName);
    if (/\b(name|employee id|applicant id|worker id|personnel id|id if applicable|date)\b/i.test(local)) return true;
    const target = normalize(targetText);
    if (/\b(disabilit|disabled|veteran|race|ethnicity|gender|sex)\b/i.test(target)) return false;
    return /\b(name|employee id|applicant id|worker id|personnel id|id if applicable|date)\b/i.test(target);
  }

  function isDisabilityContext(text) {
    return /\b(disabilit|disabled)\b/i.test(normalize(text));
  }

  function isDisabilitySelfIdentifyPage(text) {
    return /\bvoluntary self.identification of disability\b|\bplease check one of the boxes below\b/i.test(normalize(text));
  }

  global.__formFillerDemographicFieldTools = {
    choiceCandidatesForProfileValue,
    resolveDisabilityProfileValue,
    selfIdentifyDatePartValue,
    shouldRejectChoiceAnswerForText,
    isDisabilityContext,
    isDisabilitySelfIdentifyPage
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
