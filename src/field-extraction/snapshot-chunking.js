const SNAPSHOT_CHUNK_MAX_CHARS = 28000;
const SNAPSHOT_CHUNK_MIN_CHARS = 14000;

function lineIndent(line) {
  const match = String(line || "").match(/^\s*/);
  return match ? match[0].length : 0;
}

// Returns true if the chunk text contains at least one visibly unfilled form field.
// Used to skip already-filled-only chunks when unfilledOnly=true to avoid wasting LLM calls.
export function chunkContainsUnfilledField(chunkText) {
  const lines = String(chunkText || "").split(/\r?\n/);
  // Fast paths: Workday-style "Select One" button or needs-expansion flag
  if (/\bbutton\b[^"]*"Select One"/i.test(chunkText)) return true;
  if (/\/needs-expansion:\s*true/i.test(chunkText)) return true;

  const controlRe = /^\s*-\s+(textbox|searchbox|spinbutton)\b/i;
  const valuePropRe = /^\s*-\s+\/value:\s*"([^"]*)"/i;
  const nextControlRe = /^\s*-\s+(textbox|searchbox|combobox|listbox|spinbutton|checkbox|radio|switch|slider|group|radiogroup|button|generic|legend)\b/i;

  for (let i = 0; i < lines.length; i++) {
    if (!controlRe.test(lines[i])) continue;
    // Scan ahead for a /value: property before the next control
    let foundNonEmpty = false;
    for (let j = i + 1; j < lines.length && j < i + 10; j++) {
      if (nextControlRe.test(lines[j])) break;
      const vm = valuePropRe.exec(lines[j]);
      if (vm) {
        if (vm[1].trim()) foundNonEmpty = true;
        break;
      }
    }
    if (!foundNonEmpty) return true;
  }
  return false;
}

export function splitSnapshotIntoStructuralChunks(snapshotText) {
  const lines = String(snapshotText || "").split(/\r?\n/);
  const chunks = [];
  let current = [];
  let currentChars = 0;

  function flush() {
    const text = current.join("\n").trim();
    if (text) {
      chunks.push({
        index: chunks.length,
        lineStart: chunks.reduce((sum, chunk) => sum + chunk.lineCount, 0) + 1,
        lineCount: current.length,
        chars: text.length,
        text
      });
    }
    current = [];
    currentChars = 0;
  }

  for (const line of lines) {
    const text = String(line || "");
    const isStructuralBreak = /^\s*- /.test(text) && lineIndent(text) <= 4;
    const nextChars = currentChars + text.length + 1;
    if (current.length && isStructuralBreak && currentChars >= SNAPSHOT_CHUNK_MIN_CHARS) flush();
    else if (current.length && nextChars > SNAPSHOT_CHUNK_MAX_CHARS) flush();
    current.push(text);
    currentChars += text.length + 1;
  }
  flush();

  return chunks.map((chunk, index) => ({ ...chunk, index, total: chunks.length }));
}
