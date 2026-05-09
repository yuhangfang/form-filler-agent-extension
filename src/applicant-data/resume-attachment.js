import { getLocal, KEYS } from "./storage.js";

async function probeResumeInputs(tabId) {
  try {
    const rows = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
        const isAts = /workday|greenhouse|lever|ashby|taleo|brassring|icims|smartrecruiters|myworkday|myworkdayjobs/.test(location.hostname);
        const pageCtx = (document.title + " " + location.pathname + " " + location.search).toLowerCase();
        const isJobApplicationPage = /resume|cv|autofill|apply|application/.test(pageCtx);
        return inputs.some((i) => {
          const attrs = [
            i.name, i.id, i.accept,
            i.getAttribute("aria-label"),
            i.getAttribute("data-automation-id"),
            i.placeholder, i.labels?.[0]?.textContent,
            i.closest("[data-automation-id]")?.getAttribute("data-automation-id")
          ].filter(Boolean).join(" ").toLowerCase();
          if (/resume|cv|curriculum|upload resume|attach resume|application document/.test(attrs)) return true;
          if (isAts && /file.?upload|upload.?input|attach.?file/.test(attrs)) return true;
          if (isJobApplicationPage && /\.(pdf|doc|docx|txt|rtf)/.test(i.accept || "")) return true;
          // Single file input on an apply-like page (matches page-form-detection heuristics)
          return inputs.length === 1 && isJobApplicationPage;
        });
      }
    });
    return (rows || []).some((r) => !r.error && r.result === true);
  } catch {
    return false;
  }
}

async function loadStoredResumeAsset() {
  const userContent = await getLocal(KEYS.userContent, null);
  const resume = userContent?.files?.resumePdf;
  if (!resume?.dataBase64 || !resume?.name) return null;
  return {
    name: resume.name,
    type: resume.type || "application/pdf",
    dataBase64: resume.dataBase64
  };
}

export async function tryAttachStoredResume(tabId) {
  const hasResumeField = await probeResumeInputs(tabId);
  if (!hasResumeField) return false;
  const asset = await loadStoredResumeAsset();
  if (!asset) return false;
  try {
    const rows = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: (resumeAsset) => {
        const b64 = String(resumeAsset?.dataBase64 || "");
        if (!b64) return { attached: 0 };
        const binary = atob(b64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
        const file = new File([bytes], resumeAsset.name || "resume.pdf", {
          type: resumeAsset.type || "application/pdf"
        });
        let attached = 0;
        const controls = Array.from(document.querySelectorAll('input[type="file"]'));
        for (const input of controls) {
          if (!isLikelyResumeInput(input)) continue;
          if (input.files?.length) continue;
          // Determine what kind of document this upload expects
          const uploadKind = detectUploadKind(input);
          // For now we only store a resume — skip if it's clearly something else
          if (uploadKind === "other") continue;
          const dt = new DataTransfer();
          dt.items.add(file);
          input.files = dt.files;
          // Dispatch on the input itself
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
          // Also dispatch a drop event on the nearest dropzone — some frameworks
          // (e.g. Workday) listen to drop on a wrapper div, not the input's change.
          const dropzone = input.closest(
            '[class*="drop" i], [class*="Drop"], [data-automation-id*="drop" i], [data-automation-id*="upload" i]'
          ) || input.parentElement;
          if (dropzone && dropzone !== input) {
            try {
              const dropEvt = new DragEvent("drop", { bubbles: true, cancelable: true });
              Object.defineProperty(dropEvt, "dataTransfer", { value: dt });
              dropzone.dispatchEvent(dropEvt);
            } catch { /* ignore if DragEvent fails */ }
          }
          attached += 1;
        }
        return { attached };

        function detectUploadKind(el) {
          // Collect text from the element itself and its nearest section heading
          const section = el.closest(
            "section, fieldset, [class*='upload' i], [class*='drop' i], [data-automation-id]"
          );
          const headingEl = section?.querySelector("h1, h2, h3, h4, legend, label, p");
          const context = [
            el.getAttribute("aria-label"),
            el.getAttribute("data-automation-id"),
            el.name, el.id,
            el.labels?.[0]?.textContent,
            section?.getAttribute("data-automation-id"),
            headingEl?.textContent,
            document.title
          ].filter(Boolean).join(" ").toLowerCase();
          if (/cover.?letter/.test(context)) return "coverLetter";
          if (/portfolio|work.?sample|writing.?sample/.test(context)) return "portfolio";
          if (/transcript/.test(context)) return "transcript";
          // Resume / CV / generic ATS upload → treat as resume
          return "resume";
        }

        function isLikelyResumeInput(el) {
          const attrs = [
            el.name, el.id, el.accept,
            el.getAttribute("aria-label"),
            el.getAttribute("data-automation-id"),
            el.placeholder, el.labels?.[0]?.textContent,
            el.closest("[data-automation-id]")?.getAttribute("data-automation-id")
          ].filter(Boolean).join(" ").toLowerCase();
          if (/resume|cv|curriculum|upload resume|attach resume|application document/.test(attrs)) return true;
          // ATS platforms: "file-upload-input-ref" and similar patterns on known job sites
          const isAts = /workday|greenhouse|lever|ashby|taleo|brassring|icims|smartrecruiters|myworkday|myworkdayjobs/.test(location.hostname);
          if (isAts && /file.?upload|upload.?input|attach.?file/.test(attrs)) return true;
          const pageCtx = (document.title + " " + location.pathname + " " + location.search).toLowerCase();
          const isJobApplicationPage = /resume|cv|autofill|apply|application/.test(pageCtx);
          if (isJobApplicationPage && /\.(pdf|doc|docx|txt|rtf)/.test(el.accept || "")) return true;
          const allFileInputs = Array.from(document.querySelectorAll('input[type="file"]'));
          if (allFileInputs.length === 1 && allFileInputs[0] === el) {
            if (isAts) return true;
            if (isJobApplicationPage) return true;
          }
          return false;
        }
      },
      args: [asset]
    });
    return (rows || []).some((r) => !r.error && (r.result?.attached || 0) > 0);
  } catch {
    return false;
  }
}
