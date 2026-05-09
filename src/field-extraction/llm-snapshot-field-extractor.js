import { OPENAI_API_KEY } from "../env.secret.js";
import { mergeFieldArrays, normalizeReaderDomFields, toDisplayFields } from "./field-normalization.js";
import { chunkContainsUnfilledField, splitSnapshotIntoStructuralChunks } from "./snapshot-chunking.js";

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const LLM_DOM_SCAN_TIMEOUT_MS = 120000;

function safeParseJson(content) {
  try {
    return JSON.parse(content);
  } catch (_e) {
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) return null;
    try {
      return JSON.parse(content.slice(start, end + 1));
    } catch (_e2) {
      return null;
    }
  }
}

async function requestOpenAiJson({ apiKey, body, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("llm_dom_scan_timeout"), timeoutMs);
  const started = Date.now();
  let response;
  try {
    response = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (error) {
    const name = String(error?.name || "");
    const msg = String(error?.message || error || "");
    const looksAborted =
      name === "AbortError" ||
      /abort/i.test(msg) ||
      /timeout/i.test(msg) ||
      msg.includes("llm_dom_scan_timeout");
    if (looksAborted) {
      return {
        ok: false,
        error: `LLM DOM scan timed out after ${timeoutMs / 1000}s`,
        timedOut: true
      };
    }
    const reason = error instanceof Error ? error.message : String(error || "");
    return { ok: false, error: reason ? `LLM DOM scan request failed: ${reason}` : "LLM DOM scan request failed" };
  } finally {
    clearTimeout(timer);
  }

  const payload = await response.json().catch(() => null);
  const elapsedMs = Date.now() - started;
  if (!response.ok) {
    return { ok: false, error: payload?.error?.message || `OpenAI HTTP ${response.status}`, elapsed_ms: elapsedMs };
  }
  const content = payload?.choices?.[0]?.message?.content;
  if (!content || typeof content !== "string") {
    return { ok: false, error: "Empty OpenAI response", elapsed_ms: elapsedMs, usage: payload?.usage || null };
  }
  const parsed = safeParseJson(content);
  if (!parsed || typeof parsed !== "object") {
    return { ok: false, error: "Could not parse fields JSON", raw: content, elapsed_ms: elapsedMs, usage: payload?.usage || null };
  }
  return { ok: true, parsed, content, elapsed_ms: elapsedMs, usage: payload?.usage || null };
}

function aggregateLlmStats(results) {
  const stats = {
    llm_call_count: results.length,
    total_prompt_tokens: 0,
    total_completion_tokens: 0,
    total_tokens: 0,
    total_est_prompt_tokens: 0,
    total_est_response_tokens: 0,
    total_est_tokens: 0,
    total_llm_call_ms: 0
  };
  for (const result of results) {
    const s = result?.stats || {};
    stats.total_prompt_tokens += Number(s.prompt_tokens || s.total_prompt_tokens || 0);
    stats.total_completion_tokens += Number(s.completion_tokens || s.total_completion_tokens || 0);
    stats.total_tokens += Number(s.total_tokens || 0);
    stats.total_est_prompt_tokens += Number(s.est_prompt_tokens || s.total_est_prompt_tokens || 0);
    stats.total_est_response_tokens += Number(s.est_response_tokens || s.total_est_response_tokens || 0);
    stats.total_llm_call_ms += Number(s.elapsed_ms || s.total_llm_call_ms || 0);
  }
  stats.total_est_tokens = stats.total_est_prompt_tokens + stats.total_est_response_tokens;
  return stats;
}

async function extractReaderDomFieldsFromSnapshot({
  apiKey,
  url,
  title,
  snapshotText,
  purpose = "browser_snapshot_field_extraction",
  chunkIndex = 0,
  chunkCount = 1,
  unfilledOnly = false
}) {
  const snapshotClip = String(snapshotText || "").slice(0, 180000);
  if (!snapshotClip.trim()) {
    return {
      ok: false,
      error: "No browser_snapshot text available for Website Reader-style field extraction.",
      fields: []
    };
  }

  const chunkNote = chunkCount > 1
    ? `\nSnapshot chunk: ${chunkIndex + 1} of ${chunkCount}. Extract only fields visible in this chunk. If a grouped field spans this chunk, preserve the group hierarchy visible in this chunk.\n`
    : "";
  const unfilledNote = unfilledOnly
    ? "\nUnfilled-only mode: include ONLY fields that appear empty, unanswered, unselected, or still showing a placeholder. Exclude textboxes/textareas with existing values, selects/comboboxes with a chosen non-placeholder value, checked checkbox/radio groups, and completed uploads.\n"
    : "";
  const prompt = `You are given a Playwright MCP browser_snapshot for this page: ${url}

Page title: ${title || ""}
${chunkNote}
${unfilledNote}

Requirements:
1) Extract form-like fields from the snapshot: label, type, name/id hints, required (best effort), and ALL visible options.
2) Include ONLY fields visibly present to a human in the rendered page.
3) Exclude hidden/internal/autofill-only/system fields and anything not visibly rendered.
4) Preserve strict visual order from top to bottom exactly as displayed on the page.
5) Preserve option grouping for grouped radio/checkbox/select sections. For example, Race/Ethnicity often has group headings plus child options; keep those headings in optionGroups.
${unfilledOnly ? "6) Exclude already-filled/already-selected fields; this scan is for remaining fields to fill only.\n7) Final answer MUST be strict JSON only:" : "6) Final answer MUST be strict JSON only:"}
{
  "url": "...",
  "title": "...",
  "fields": [
    {
      "label": "...",
      "type": "...",
      "name": "...",
      "id": "...",
      "required": false,
      "options": ["flat option text when not grouped"],
      "optionGroups": [{"label":"group heading","options":["child option text"]}],
      "needsExpansion": false,
      "expansionReason": ""
    }
  ]
}
Rules for options:
- Include every visible option for a field, not just examples.
- Use optionGroups when the snapshot shows grouped/nested options.
- If optionGroups is present, options may be a flattened copy of all child options.
- If the snapshot contains /needs-expansion: true, set needsExpansion true and copy /expansion-reason.
Max 120 fields. No markdown.

Accessibility snapshot:
${snapshotClip}`;

  const body = {
    model: "gpt-4o-mini",
    temperature: 0,
    max_tokens: 8192,
    response_format: { type: "json_object" },
    messages: [{ role: "user", content: prompt }]
  };
  const llmInput = {
    purpose,
    chunkIndex,
    chunkCount,
    model: body.model,
    temperature: body.temperature,
    max_tokens: body.max_tokens,
    response_format: body.response_format,
    messages: body.messages
  };
  const res = await requestOpenAiJson({ apiKey, body, timeoutMs: LLM_DOM_SCAN_TIMEOUT_MS });
  if (!res.ok) return { ...res, fields: [], llmInput, stats: { prompt_chars: prompt.length, response_chars: 0 } };
  const fields = normalizeReaderDomFields(res.parsed?.fields);
  return {
    ok: true,
    url: String(res.parsed?.url || url),
    title: String(res.parsed?.title || title || ""),
    fields,
    llmInput,
    stats: {
      prompt_chars: prompt.length,
      response_chars: res.content.length,
      elapsed_ms: Number(res.elapsed_ms || 0),
      prompt_tokens: Number(res.usage?.prompt_tokens || 0),
      completion_tokens: Number(res.usage?.completion_tokens || 0),
      total_tokens: Number(res.usage?.total_tokens || 0),
      est_prompt_tokens: Math.max(1, Math.floor(prompt.length / 4)),
      est_response_tokens: Math.max(1, Math.floor(res.content.length / 4))
    }
  };
}

/**
 * Analyze rendered DOM controls and infer user-visible fields to fill.
 * @param {{ url: string, title?: string, snapshotText?: string }} input
 * @returns {Promise<{ ok: boolean, fields?: Array<object>, stats?: object, error?: string }>}
 */
export async function analyzeDomFieldScan({ url, title = "", snapshotText = "" }) {
  const apiKey = (OPENAI_API_KEY || "").trim();
  if (!apiKey) {
    return { ok: false, error: "No OPENAI_API_KEY (run npm run sync-env after filling .env.local)" };
  }
  if (!url || typeof url !== "string") {
    return { ok: false, error: "url is required" };
  }

  // Send the captured page content to the LLM exactly once. The extraction
  // response is used directly for both debug DOM fields and visible LLM fields.
  const fieldExtraction = await extractReaderDomFieldsFromSnapshot({
    apiKey,
    url,
    title,
    snapshotText
  });

  if (!fieldExtraction.ok) {
    return {
      ok: false,
      error: fieldExtraction.error || "LLM field extraction failed.",
      llmInputs: [fieldExtraction.llmInput].filter(Boolean),
      stats: fieldExtraction.stats || {}
    };
  }

  const domFields = Array.isArray(fieldExtraction.fields) ? fieldExtraction.fields : [];
  const fields = toDisplayFields(domFields);

  return {
    ok: true,
    fields,
    domFields,
    llmInputs: [fieldExtraction.llmInput].filter(Boolean),
    stats: {
      ...(fieldExtraction.stats || {}),
      controlsCount: domFields.length,
      llm_call_count: 1,
      total_prompt_tokens: Number(fieldExtraction.stats?.prompt_tokens || 0),
      total_completion_tokens: Number(fieldExtraction.stats?.completion_tokens || 0),
      total_tokens: Number(fieldExtraction.stats?.total_tokens || 0),
      total_est_prompt_tokens: Number(fieldExtraction.stats?.est_prompt_tokens || 0),
      total_est_response_tokens: Number(fieldExtraction.stats?.est_response_tokens || 0),
      total_est_tokens:
        Number(fieldExtraction.stats?.est_prompt_tokens || 0) +
        Number(fieldExtraction.stats?.est_response_tokens || 0),
      total_llm_call_ms: Number(fieldExtraction.stats?.elapsed_ms || 0)
    }
  };
}

/**
 * Extract fields by splitting the browser_snapshot into structure-aware chunks and
 * asking the LLM to extract each chunk independently. Used for Experiment Runner comparison.
 * @param {{ url: string, title?: string, snapshotText?: string, unfilledOnly?: boolean }} input
 * @returns {Promise<{ ok: boolean, fields?: Array<object>, domFields?: Array<object>, llmInputs?: Array<object>, chunks?: Array<object>, stats?: object, error?: string }>}
 */
export async function analyzeDomFieldScanChunked({ url, title = "", snapshotText = "", unfilledOnly = false }) {
  const apiKey = (OPENAI_API_KEY || "").trim();
  if (!apiKey) {
    return { ok: false, error: "No OPENAI_API_KEY (run npm run sync-env after filling .env.local)" };
  }
  if (!url || typeof url !== "string") {
    return { ok: false, error: "url is required" };
  }

  const chunks = splitSnapshotIntoStructuralChunks(snapshotText);
  if (!chunks.length) return { ok: false, error: "No browser_snapshot text available for chunked extraction." };

  const results = [];
  let skippedChunks = 0;
  for (const chunk of chunks) {
    if (unfilledOnly && !chunkContainsUnfilledField(chunk.text)) {
      skippedChunks++;
      results.push({ ok: true, fields: [], skipped: true, chunk });
      continue;
    }
    const result = await extractReaderDomFieldsFromSnapshot({
      apiKey,
      url,
      title,
      snapshotText: chunk.text,
      purpose: "browser_snapshot_chunk_field_extraction",
      chunkIndex: chunk.index,
      chunkCount: chunks.length,
      unfilledOnly
    });
    results.push({ ...result, chunk });
  }

  const okResults = results.filter((result) => result.ok && !result.skipped);
  const domFields = mergeFieldArrays(okResults.map((result) => result.fields));
  return {
    ok: okResults.length > 0 || skippedChunks === chunks.length,
    error: okResults.length || skippedChunks ? "" : (results.find((result) => result.error)?.error || "Chunked field extraction failed."),
    fields: toDisplayFields(domFields),
    domFields,
    llmInputs: results.map((result) => result.llmInput).filter(Boolean),
    chunks: chunks.map((chunk) => ({
      index: chunk.index,
      lineStart: chunk.lineStart,
      lineCount: chunk.lineCount,
      chars: chunk.chars,
      skipped: !!results[chunk.index]?.skipped,
      ok: !!results[chunk.index]?.ok,
      fieldCount: Array.isArray(results[chunk.index]?.fields) ? results[chunk.index].fields.length : 0,
      error: results[chunk.index]?.error || ""
    })),
    stats: {
      ...aggregateLlmStats(okResults),
      chunk_count: chunks.length,
      successful_chunk_count: okResults.length,
      skipped_chunk_count: skippedChunks,
      unfilled_only: !!unfilledOnly,
      controlsCount: domFields.length
    }
  };
}
