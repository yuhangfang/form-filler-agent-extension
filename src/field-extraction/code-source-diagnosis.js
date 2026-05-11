import { OPENAI_API_KEY } from "../env.secret.js";

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

async function readExtensionFile(relPath) {
  try {
    const url = chrome.runtime.getURL(relPath);
    const res = await fetch(url);
    if (!res.ok) return `(could not read ${relPath}: HTTP ${res.status})`;
    return await res.text();
  } catch (err) {
    return `(could not read ${relPath}: ${err?.message || String(err)})`;
  }
}

/**
 * Step 2: given source-search results, read the relevant extractor source code
 * and ask the LLM to identify the code gap that causes each field to be missed.
 *
 * Source priority: Browser Snapshot (ARIA) > DOM Outline > neither (needs interaction/reload).
 * Corresponding extractor code:
 *   snapshot → src/field-extraction/snapshot-field-parser.js
 *   DOM outline → src/browser-capture/dom-scan-capture.js
 *   neither → no static source; diagnose as interaction / reload needed
 */
export async function diagnoseCodeForMissingFields({ sourceSearchResults }) {
  const apiKey = (OPENAI_API_KEY || "").trim();
  if (!apiKey) return { ok: false, error: "No OPENAI_API_KEY configured." };
  if (!Array.isArray(sourceSearchResults) || sourceSearchResults.length === 0) {
    return { ok: false, error: "No source-search results to analyze." };
  }

  const fieldSummaries = sourceSearchResults
    .map((r) => {
      const lines = [`Field: "${r.field}"`];
      if (r.snapshot?.found) {
        lines.push(`  Browser Snapshot: FOUND (${r.snapshot.matchType} match)`);
        if (r.snapshot.snippet) {
          lines.push(`  --- Browser Snapshot snippet ---`);
          lines.push(r.snapshot.snippet.split("\n").map(l => "    " + l).join("\n"));
        }
      } else {
        lines.push(`  Browser Snapshot: NOT FOUND`);
      }
      if (r.domOutline?.found) {
        lines.push(`  DOM Outline: FOUND (${r.domOutline.matchType} match)`);
        if (r.domOutline.snippet) {
          lines.push(`  --- DOM Outline snippet ---`);
          lines.push(r.domOutline.snippet.split("\n").map(l => "    " + l).join("\n"));
        }
      } else {
        lines.push(`  DOM Outline: NOT FOUND`);
      }
      return lines.join("\n");
    })
    .join("\n\n");

  const sourceContext = `Missing fields with source locations:\n\n${fieldSummaries}`;

  const instructions = `You are diagnosing why specific form fields are missing from an automated field-extraction pipeline for a Chrome extension.

How field detection works:
  STEP 1 — Role detection: the ARIA role is detected using this regex:
    /^(\\s*)-\\s+(textbox|searchbox|combobox|listbox|spinbutton|checkbox|radio|switch|slider|group|radiogroup)\\b/i
    Only elements whose ARIA role appears in this list are ever considered as fields.
    Any other role (e.g. "option", "menuitem", "treeitem", "listitem", "button") is silently skipped.

  STEP 2 — Label extraction: after a role is detected, its label comes from:
    a) the element's own accessible name (the quoted string after the role keyword, e.g. textbox "Email")
    b) parent group label context accumulated while walking the snapshot lines
    c) nearby text: preceding generic/legend/text lines within indent range

  Fallback: DOM Outline is searched when the Browser Snapshot misses a field.

For each missing field, produce a brief using EXACTLY this format and nothing else:

{ label: "<field_name>", type: "...", options: [...] }

Produce one brief per field. Do not add any other sections or commentary outside this format.`;

  const response = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o",
      temperature: 0,
      messages: [
        { role: "system", content: instructions },
        { role: "user", content: sourceContext }
      ]
    })
  });

  const responsePayload = await response.json().catch(() => null);
  if (!response.ok) {
    return { ok: false, error: responsePayload?.error?.message || `OpenAI HTTP ${response.status}` };
  }
  const content = responsePayload?.choices?.[0]?.message?.content;
  if (!content) return { ok: false, error: "Empty Step 2 response from LLM." };
  return { ok: true, reportText: String(content), sourceContext };
}
