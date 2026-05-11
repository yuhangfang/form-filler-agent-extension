/**
 * Internal diagnose source lookup: for each missing field found by vision (Step 1),
 * search the raw source texts to identify where (if anywhere) each field exists.
 */

function normalizeLabel(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[*​ \r]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function lineIndent(line) {
  return (line.match(/^(\s*)/) || ["", ""])[1].length;
}

/**
 * Search for needle in lines[] by normalizing each line individually.
 * Returns the exact line index of the match, or -1.
 * For partial matches, finds the first line containing the first significant word
 * where all words appear within a small window.
 */
function findMatchLine(needle, lines) {
  // Exact: normalized line contains the full normalized needle
  for (let i = 0; i < lines.length; i++) {
    if (normalizeLabel(lines[i]).includes(needle)) return { lineIndex: i, matchType: "exact" };
  }

  // Partial: all significant words (>2 chars) present within a small line window
  const words = needle.split(/\s+/).filter((w) => w.length > 2);
  if (words.length >= 2) {
    for (let i = 0; i < lines.length; i++) {
      if (!normalizeLabel(lines[i]).includes(words[0])) continue;
      const window = lines.slice(Math.max(0, i - 1), i + 4).map(normalizeLabel).join(" ");
      if (words.every((w) => window.includes(w))) return { lineIndex: i, matchType: "partial" };
    }
  }

  return null;
}

/**
 * Given the matched line index, extract it plus structural context:
 * up to 2 ancestor/sibling lines above and all children (deeper indent)
 * plus one next sibling below.
 */
function extractSnippetLines(lines, matchLine) {
  const matchIndent = lineIndent(lines[matchLine] || "");

  let startLine = matchLine;
  let ancestorsSeen = 0;
  for (let i = matchLine - 1; i >= 0 && matchLine - i <= 20; i--) {
    if (!lines[i].trim()) { startLine = i; continue; }
    const ind = lineIndent(lines[i]);
    if (ind <= matchIndent) {
      ancestorsSeen++;
      startLine = i;
      if (ancestorsSeen >= 2) break;
    } else {
      startLine = i;
    }
  }

  let endLine = matchLine + 1;
  let nextSiblingDone = false;
  while (endLine < lines.length && endLine - matchLine <= 25) {
    if (!lines[endLine].trim()) { endLine++; continue; }
    const ind = lineIndent(lines[endLine]);
    if (ind > matchIndent) {
      endLine++;
    } else if (ind === matchIndent && !nextSiblingDone) {
      nextSiblingDone = true;
      endLine++;
    } else {
      break;
    }
  }

  return lines.slice(startLine, endLine).join("\n");
}

function searchLabel(fieldLabel, sourceText) {
  if (!fieldLabel || !sourceText) return { found: false, matchType: "none", snippet: "" };
  const needle = normalizeLabel(fieldLabel);
  if (!needle) return { found: false, matchType: "none", snippet: "" };
  const lines = sourceText.split("\n");
  const match = findMatchLine(needle, lines);
  if (!match) return { found: false, matchType: "none", snippet: "" };
  return { found: true, matchType: match.matchType, snippet: extractSnippetLines(lines, match.lineIndex) };
}

/**
 * For each missing field label, search it in snapshotText and domOutline.
 * Returns an array of per-field results.
 */
export function searchMissingFieldsInSources({ missingFields, snapshotText, domOutline }) {
  if (!Array.isArray(missingFields) || missingFields.length === 0) return [];
  return missingFields
    .map((field) => {
      const label = String(field || "").trim();
      if (!label) return null;
      const inSnapshot = searchLabel(label, snapshotText);
      const inDomOutline = searchLabel(label, domOutline);
      return {
        field: label,
        snapshot: inSnapshot,
        domOutline: inDomOutline,
        foundAnywhere: inSnapshot.found || inDomOutline.found
      };
    })
    .filter(Boolean);
}

export function formatSourceSearchReport(results) {
  if (!Array.isArray(results) || results.length === 0) return "No missing fields to search in sources.";
  const lines = ["Source Search (snapshot + DOM outline):", ""];
  for (const r of results) {
    const snapStatus = r.snapshot.found ? `found (${r.snapshot.matchType} match)` : "not found";
    const domStatus = r.domOutline.found ? `found (${r.domOutline.matchType} match)` : "not found";
    lines.push(`"${r.field}"`);
    lines.push(`  Browser Snapshot : ${snapStatus}`);
    if (r.snapshot.found && r.snapshot.snippet) lines.push(`    ${r.snapshot.snippet}`);
    lines.push(`  DOM Outline      : ${domStatus}`);
    if (r.domOutline.found && r.domOutline.snippet) lines.push(`    ${r.domOutline.snippet}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
