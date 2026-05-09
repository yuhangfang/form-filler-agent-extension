/**
 * Learned field memory resolver.
 *
 * Stored field hints become a small, explainable matching model. Exact
 * fingerprint/question matches can replay remembered values; learned aliases and
 * canonical keys map new-but-similar fields back to profile values.
 */
(function attachLearnedFieldMemory(global) {
  function normalize(text) {
    return String(text || "")
      .toLowerCase()
      .replace(/https?:\/\/\S+/g, " ")
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function tokens(text) {
    return normalize(text).split(/\s+/).filter((t) => t.length >= 3);
  }

  function tokenOverlapScore(left, right) {
    const a = tokens(left);
    const b = tokens(right);
    if (!a.length || !b.length) return 0;
    const aSet = new Set(a);
    const hits = b.filter((t) => aSet.has(t)).length;
    const ratio = hits / Math.max(1, Math.min(a.length, b.length));
    return Math.round(ratio * 70);
  }

  function pickHintValue(hint) {
    const corrected = String(hint?.correctedValue ?? "").trim();
    if (corrected) return corrected;
    const guessed = String(hint?.lastGuessedValue ?? "").trim();
    if (guessed) return guessed;
    if (Array.isArray(hint?.answerValues)) {
      for (const value of hint.answerValues) {
        const s = String(value || "").trim();
        if (s) return s;
      }
    }
    return String(hint?.value || "").trim();
  }

  function isInternalId(value) {
    const v = String(value || "").trim();
    return /^[0-9a-f]{32}$/i.test(v) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
  }

  function profileValueForCanonicalKey(profile, canonicalKey) {
    const key = String(canonicalKey || "").trim();
    if (!key) return "";
    if (key === "firstName") return profile.firstName?.trim() || (profile.fullName || "").trim().split(/\s+/)[0] || "";
    if (key === "lastName") {
      if (profile.lastName?.trim()) return profile.lastName.trim();
      const parts = (profile.fullName || "").trim().split(/\s+/);
      return parts.length > 1 ? parts.slice(1).join(" ") : "";
    }
    return profile[key] && String(profile[key]).trim() ? String(profile[key]).trim() : "";
  }

  function hintAliases(hint) {
    return [
      hint?.questionKey,
      hint?.labelContext,
      ...(Array.isArray(hint?.learnedAliases) ? hint.learnedAliases : [])
    ].map(normalize).filter(Boolean);
  }

  function scoreHint(hint, descriptor) {
    const fingerprint = String(descriptor?.fingerprint || "");
    const qk = normalize(descriptor?.questionKey || "");
    const context = normalize([
      descriptor?.label,
      descriptor?.name,
      descriptor?.section,
      descriptor?.context,
      descriptor?.helpText
    ].filter(Boolean).join(" "));

    let score = 0;
    let reason = "";
    if (fingerprint && (hint?.fingerprint === fingerprint || (Array.isArray(hint?.fingerprints) && hint.fingerprints.includes(fingerprint)))) {
      score = 100;
      reason = "learned:fingerprint";
    }
    const hintQk = normalize(hint?.questionKey || "");
    if (qk && hintQk && qk === hintQk && score < 94) {
      score = 94;
      reason = "learned:question_key";
    }
    for (const alias of hintAliases(hint)) {
      if (!alias) continue;
      if (context === alias && score < 88) {
        score = 88;
        reason = "learned:alias_exact";
      } else if ((context.includes(alias) || alias.includes(context)) && Math.min(context.length, alias.length) >= 12 && score < 78) {
        score = 78;
        reason = "learned:alias_contains";
      } else {
        const overlap = tokenOverlapScore(context, alias);
        if (overlap >= 45 && overlap > score) {
          score = overlap;
          reason = "learned:alias_overlap";
        }
      }
    }

    const confidence = Number(hint?.confidence || 0);
    if (confidence > 0 && score > 0) score += Math.min(8, Math.round(confidence * 8));
    if (String(hint?.source || "").includes("correct")) score += 6;
    if (hint?.correctedValue) score += 6;
    return { score: Math.min(100, score), reason };
  }

  function resolveFieldValue({ descriptor, profile, hints, minScore = 58 }) {
    let best = null;
    for (const hint of Array.isArray(hints) ? hints : []) {
      if (!hint) continue;
      const scored = scoreHint(hint, descriptor);
      if (!scored.score || scored.score < minScore) continue;
      const canonicalKey = String(hint.canonicalKey || "").trim();
      const profileValue = profileValueForCanonicalKey(profile || {}, canonicalKey);
      const rememberedValue = pickHintValue(hint);
      const value = profileValue || rememberedValue;
      if (!value || isInternalId(value)) continue;
      const candidate = {
        profileKey: canonicalKey || "learnedField",
        value,
        reason: scored.reason,
        candidate: descriptor?.context || descriptor?.label || hint.labelContext || "",
        confidence: scored.score / 100,
        sourceHintId: hint.id || ""
      };
      if (!best || scored.score > best.score) best = { score: scored.score, candidate };
    }
    return best?.candidate || null;
  }

  global.__formFillerLearnedFieldMemory = {
    normalize,
    resolveFieldValue
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
