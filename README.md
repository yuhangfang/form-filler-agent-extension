# Adaptive Form Filler Agent

Chrome extension that acts as an AI agent to parse your resume, fill job application forms automatically, make educated guesses for ambiguous fields, and learn from your corrections over time.

## Load in Chrome

1. Copy `.env.example` to `.env.local` and add your API keys (never commit `.env.local`).
2. Run `npm run sync-env` to write keys from `.env.local` into `src/env.secret.js`.
3. Open `chrome://extensions`.
4. Enable **Developer mode**.
5. Click **Load unpacked** and select `dist/extension`.

If you change `.env.local`, run `npm run sync-env` again and reload the extension.

## How it works

### 1. Parse resume → rich profile

Upload a PDF in the popup and click **Parse Resume**. The extension:
- Extracts plain text with `pdf.js`
- Sends it to **OpenAI** (`gpt-4o-mini`) for structured extraction (falls back to rule-based parsing if the API key is missing or the request fails)
- Auto-populates **25 profile fields** from the parsed data:
  - Contact: first name, last name, email, phone
  - Location: address, city, state, zip, country
  - Online: LinkedIn, GitHub, website
  - Professional: current title, current company, years of experience
  - Education: highest degree, major, university, graduation year
  - Work auth & preferences: work authorization, sponsorship required, desired salary, notice period, willing to relocate

All fields are editable in the **Quick Profile** panel and saved to `chrome.storage.local`.

### 2. Fill forms — three passes

**Fill Current Page** — fast deterministic fill:
1. **Stored hints**: replay field values saved from previous submissions or AI fills on this domain
2. **Rule aliases**: match 100+ field label aliases across all 25 profile keys (longest-match wins so "First Name" maps to `firstName`, not `fullName`)
3. **Resume attach**: detects resume file inputs and injects the stored PDF automatically

**Evaluate & fill gaps** — adds deeper passes after the deterministic step:
- Relaxed resolver: fills fields by HTML input type (`type=email`, `type=tel`, `type=url`)
- Overlap scoring: matches remaining empty text fields to unused profile values by word overlap
- Singleton fallback: if exactly one empty field and one unused profile value remain, fills it

- **LLM gap fill** (part of Evaluate): any fields still empty after heuristics are sent to OpenAI with the full profile + condensed resume context (experience, education, skills). The LLM can answer questions like "highest degree", "current employer", "years of Python experience", "visa status", etc.

### 3. Learn from corrections and submissions

- When you correct an AI-filled field, the correction is stored per domain + field fingerprint.
- When you submit a form, all filled field values are snapshotted and replayed on future visits to the same domain.
- Stored hints take priority over all fill passes so each form gets better over time.

## Profile fields

| Category | Fields |
|---|---|
| Contact | fullName, firstName, lastName, email, phone |
| Location | address, city, state, zip, country |
| Online | linkedin, github, website |
| Professional | currentTitle, currentCompany, yearsOfExperience |
| Education | highestDegree, major, university, graduationYear |
| Work Auth | workAuthorization, requiresSponsorship |
| Preferences | desiredSalary, noticePeriod, willingToRelocate |

## Local storage keys

| Key | Contents |
|---|---|
| `profile.v1` | Flat object with all 25+ profile fields |
| `resumeRecord.v1` | Full parsed resume: experience, education, skills, publications, etc. |
| `fieldHints.v1` | Per-domain field answers (from submit, LLM, or user correction) |
| `applicationMemories.v1` | Per-domain fill run history |
| `lessons.v1` | Fill outcome lessons (up to 500) |
| `lastFillRun.v1` | Most recent fill result |
| `userContent.v1` | Mirror of all keys + stored resume PDF (base64) |

## File structure

```
dist/extension/
├── manifest.json       Chrome extension manifest
├── icons/              extension icons
└── src/
    ├── background.js                     service worker: message router, storage persistence
    ├── applicant-data/
    │   ├── ai-resume-parse.js            OpenAI structured resume extraction from resume text
    │   ├── resume-parser.js              PDF text extraction, rule-based parser, profile patch extraction
    │   ├── storage.js                    chrome.storage.local helpers + field hint upsert/lookup
    │   └── profile-defaults.js           quick-profile defaults and merge helpers
    ├── browser-capture/
    │   ├── browser-tools.js              browser tool runtime + snapshot tool entrypoints
    │   ├── browser-tools-inject-chain.js canonical browser capture script injection order
    │   ├── ax-snapshot.js                accessibility-name field map helpers
    │   ├── page-tools.js                 page probing/scanning helpers
    │   └── aria-snapshot/                snapshot builder helpers (roles, accname, DOM walkers)
    ├── field-extraction/
    │   ├── snapshot-field-parser.js      deterministic browser_snapshot parser
    │   ├── llm-snapshot-field-extractor.js LLM snapshot-to-fields extraction
    │   ├── snapshot-chunking.js          structure-aware snapshot chunking
    │   ├── field-normalization.js        shared field shaping/dedup helpers
    │   └── scan-result-adapters.js       scan payload normalization helpers
    ├── field-guessing/
    │   ├── field-value-guesser.js        LLM field-value guessing
    │   └── field-hint-normalizer.js      LLM cleanup for learned field hints
    ├── field-filling/
    │   ├── page-fill-engine.js           injected in-page fill engine and value resolution rules
    │   ├── demographic-field-tools.js    demographic field handling helpers
    │   ├── field-descriptor-tools.js     field descriptor helpers
    │   ├── control-fill-tools.js         control discovery and write helpers
    │   ├── choice-control-tools.js       radio and checkbox helpers
    │   ├── page-form-detection.js        page-level form detection helpers
    │   ├── fill-orchestrator.js          adaptive fill/evaluate/register orchestration
    │   ├── site-agent.js                 per-site strategy learning/cache
    │   └── site-observation-ai.js        LLM site observation analysis
    ├── field-learning/
    │   ├── learned-field-memory.js       learned field memory resolver
    │   └── field-learning-listeners.js   page listeners for learned field memory
    ├── floating-bar/
    │   ├── floating-bar-controller.js    page listener + floating bar UI: corrections and submit capture
    │   ├── floating-bar-ui.js            floating bar layout and placement helpers
    │   ├── large-textbox-assist-ui.js    long textbox assist UI
    │   └── large-textbox-assist.js       long textbox generation/polishing
    ├── experiment-runner/
    │   ├── experiment-runner.html        runner shell page
    │   ├── experiment-runner.css         runner styles
    │   ├── experiment-runner.js          runner logic + render orchestration
    │   └── extracted-field-cards-view.js reusable extracted-fields card renderer
    ├── popup/
    │   ├── popup.html                    profile/upload UI
    │   ├── popup.css                     popup styles
    │   └── popup.js                      popup event handlers
```

## Security notes

- `src/env.secret.js` and `.env.local` are in `.gitignore` — never commit them.
- Only `OPENAI_API_KEY` is actively used. Rotate any key you believe was exposed.
