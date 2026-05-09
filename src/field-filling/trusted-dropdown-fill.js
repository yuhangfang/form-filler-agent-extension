export function filterRelatedOptions(options, desiredValue) {
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  const words = norm(desiredValue).split(" ").filter((w) => w.length >= 3);
  if (!words.length) return options;
  return options.filter((opt) => words.some((w) => norm(opt).includes(w)));
}

export async function collectVisibleAriaDropdownOptions(tabId, autoId) {
  try {
    const rows = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: (id) => {
        const shared = globalThis.__formFillerBrowserActions;
        if (shared && typeof shared.collectVisibleDropdownOptions === "function") {
          return shared.collectVisibleDropdownOptions(id);
        }
        const normalize = (s) => String(s || "").replace(/\s+/g, " ").trim();
        const normalized = (s) => normalize(s).toLowerCase();
        const findByLabel = () => {
          const token = normalized(id).replace(/[-_]+/g, " ").trim();
          let best = null;
          let bestScore = 0;
          for (const el of Array.from(document.querySelectorAll('[role="combobox"], [aria-haspopup="listbox"], button, input'))) {
            const r = el.getBoundingClientRect?.();
            if (!r || !r.width || !r.height) continue;
            const bag = normalized([
              el.getAttribute("aria-label"),
              el.getAttribute("id"),
              el.getAttribute("name"),
              el.textContent,
              el.closest?.("[data-automation-id], [data-qa], [data-testid], [id], [class]")?.textContent
            ].filter(Boolean).join(" "));
            let score = 0;
            if (token && bag.includes(token)) score += 4;
            if (token && token.split(" ").every((part) => part && bag.includes(part))) score += 2;
            if (score > bestScore) {
              bestScore = score;
              best = el;
            }
          }
          return bestScore > 0 ? best : null;
        };
        const esc = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(String(id || "")) : String(id || "");
        const wrapper = document.querySelector(
          `[data-automation-id="${esc}"], [data-qa="${esc}"], [data-testid="${esc}"], [data-field-name="${esc}"], #${esc}, [name="${esc}"]`
        ) || findByLabel();
        const trigger = wrapper?.querySelector?.('[role="combobox"], button[aria-haspopup], [role="button"][aria-haspopup], input, button') || wrapper;
        if (!(trigger instanceof HTMLElement)) return [];
        try { trigger.click(); } catch {}
        const controlled = trigger.getAttribute("aria-controls") || trigger.getAttribute("aria-owns") || "";
        const list =
          (controlled ? document.getElementById(controlled) : null) ||
          document.querySelector('[role="listbox"]') ||
          document.querySelector('[data-automation-id="dropdownPanel"]');
        if (!list) return [];
        const out = [];
        for (const el of Array.from(list.querySelectorAll('[role="option"], [data-automation-id="promptOption"], li, button, div, span'))) {
          const txt = normalize(el.textContent || "");
          if (!txt) continue;
          if (/no results|loading|type to search|select\.\.\./i.test(txt)) continue;
          out.push(txt);
          if (out.length >= 30) break;
        }
        return out;
      },
      args: [autoId]
    });
    const result = (rows || []).find((r) => !r.error && Array.isArray(r.result))?.result || [];
    return result;
  } catch {
    return [];
  }
}

export async function applyTrustedAriaComboboxGuesses(tabId, guesses, emitProgress) {
  const target = { tabId };
  let attached = false;
  let applied = 0;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const sendMouse = async (type, x, y) =>
    chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      type,
      x,
      y,
      button: "left",
      clickCount: type === "mousePressed" ? 1 : undefined
    });
  const sendKey = async (type, key, text = "") =>
    chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
      type,
      key,
      text,
      unmodifiedText: text
    });
  const trustedClick = async (point) => {
    await sendMouse("mouseMoved", point.x, point.y);
    await sendMouse("mousePressed", point.x, point.y);
    await sleep(40);
    await sendMouse("mouseReleased", point.x, point.y);
  };
  const trustedType = async (text) => {
    // Clear any stale filter text, then type the desired value like a user.
    await sendKey("keyDown", "Meta");
    await sendKey("keyDown", "a", "a");
    await sendKey("keyUp", "a");
    await sendKey("keyUp", "Meta");
    await sendKey("keyDown", "Backspace");
    await sendKey("keyUp", "Backspace");
    for (const ch of String(text || "")) {
      await sendKey("char", ch, ch);
      await sleep(8);
    }
  };

  try {
    await chrome.debugger.attach(target, "1.3");
    attached = true;
    for (const guess of guesses) {
      const autoId = String(guess.autoId || "");
      const value = String(guess.value || "").trim();
      if (!autoId || !value) continue;
      await emitProgress(`Dropdown ${autoId.slice(0, 24)}: opening...`);
      const trigger = await locateAriaDropdownTrigger(tabId, autoId);
      if (!trigger) {
        await emitProgress(`Dropdown ${autoId.slice(0, 24)}: trigger not found`);
        continue;
      }
      await trustedClick(trigger);
      await sleep(350);
      await emitProgress(`Dropdown ${autoId.slice(0, 24)}: selecting best option...`);
      let option = await locateOpenDropdownOption(tabId, value);
      if (!option) {
        await emitProgress(`Dropdown ${autoId.slice(0, 24)}: typing search text...`);
        await trustedType(value);
        await sleep(500);
        option = await locateOpenDropdownOption(tabId, value, { allowFirstVisible: true });
      }
      if (!option) {
        await emitProgress(`Dropdown ${autoId.slice(0, 24)}: option not found for "${value}"`);
        continue;
      }
      await trustedClick(option);
      await sleep(120);
      // Some comboboxes highlight the option on mouse click but commit on Enter.
      await sendKey("keyDown", "Enter");
      await sendKey("keyUp", "Enter");
      await sleep(500);
      const committed = await verifyAriaDropdownCommitted(tabId, autoId, value);
      await emitProgress(`Dropdown ${autoId.slice(0, 24)}: ${committed ? "confirm ok" : "confirm failed"}`);
      if (committed) applied += 1;
    }
  } catch (error) {
    await emitProgress(`Trusted dropdown fill unavailable: ${error instanceof Error ? error.message : "debugger error"}`);
  } finally {
    if (attached) {
      try {
        await chrome.debugger.detach(target);
      } catch {
        // ignore
      }
    }
  }
  return { applied };
}

export async function applyTrustedDropdownGuesses(tabId, guesses, emitProgress = async () => {}) {
  return applyTrustedAriaComboboxGuesses(tabId, guesses, emitProgress);
}

export async function locateAriaDropdownTrigger(tabId, autoId) {
  let rows = [];
  try {
    rows = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: (id) => {
        const normalize = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
        const normPoint = (el) => {
          const r = el.getBoundingClientRect();
          if (!r.width || !r.height) return null;
          return { x: Math.max(1, r.left + r.width / 2), y: Math.max(1, r.top + r.height / 2) };
        };
        const esc = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(id) : id;
        const wrapper = document.querySelector(`[data-automation-id="${esc}"], [data-qa="${esc}"], [data-testid="${esc}"], [data-field-name="${esc}"], #${esc}, [name="${esc}"]`);
        let trigger = wrapper?.matches?.('[role="combobox"], button[aria-haspopup], [role="button"][aria-haspopup], button, input')
          ? wrapper
          : wrapper?.querySelector('[role="combobox"], button[aria-haspopup], [role="button"][aria-haspopup], button, input');
        if (!trigger) {
          const token = normalize(id).replace(/[-_]+/g, " ").trim();
          let best = null;
          let bestScore = 0;
          for (const el of Array.from(document.querySelectorAll('[role="combobox"], [aria-haspopup="listbox"], button, input'))) {
            const p = normPoint(el);
            if (!p) continue;
            const bag = normalize([
              el.getAttribute("aria-label"),
              el.getAttribute("id"),
              el.getAttribute("name"),
              el.textContent,
              el.closest?.("[data-automation-id], [data-qa], [data-testid], [id], [class]")?.textContent
            ].filter(Boolean).join(" "));
            let score = 0;
            if (token && bag.includes(token)) score += 4;
            if (token && token.split(" ").every((part) => part && bag.includes(part))) score += 2;
            if (score > bestScore) {
              bestScore = score;
              best = el;
            }
          }
          trigger = bestScore > 0 ? best : null;
        }
        return trigger ? normPoint(trigger) : null;
      },
      args: [autoId]
    });
  } catch {
    return null;
  }
  return (rows || []).find((r) => !r.error && r.result)?.result || null;
}

export async function locateOpenDropdownOption(tabId, desired, options = {}) {
  let rows = [];
  try {
    rows = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: (value, allowFirstVisible) => {
        const normalize = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
        const comparable = (s) => normalize(s).replace(/[^a-z0-9]+/g, " ").trim();
        const isPreferNotAnswer = (s) => /\b(prefer not|rather not|choose not|do not wish|don t wish|decline|not disclose|not answer|no answer|self identify|self identification)\b/.test(comparable(s));
        const want = normalize(value);
        const point = (el) => {
          const r = el.getBoundingClientRect();
          if (!r.width || !r.height) return null;
          return { x: Math.max(1, r.left + r.width / 2), y: Math.max(1, r.top + r.height / 2), text: el.textContent?.trim() || "" };
        };
        const opts = Array.from(document.querySelectorAll('[role="option"], [data-automation-id="promptOption"], li, [data-value], button'));
        let best = null;
        let bestScore = 0;
        let firstVisible = null;
        for (const opt of opts) {
          const p = point(opt);
          if (!p) continue;
          if (!firstVisible && normalize(opt.textContent || "") && !/select|loading|no results/.test(normalize(opt.textContent || ""))) {
            firstVisible = p;
          }
          const txt = normalize(opt.textContent || "");
          const val = normalize(opt.getAttribute("data-value") || opt.getAttribute("value") || opt.getAttribute("aria-label") || "");
          const hay = [txt, val].filter(Boolean);
          let score = 0;
          for (const h of hay) {
            if (h === want) score = Math.max(score, 100);
            else if (isPreferNotAnswer(want) && isPreferNotAnswer(h)) score = Math.max(score, 92);
            else if (h.includes(want) || want.includes(h)) score = Math.max(score, Math.min(h.length, want.length));
          }
          if (score > bestScore) {
            best = p;
            bestScore = score;
          }
        }
        if (!best && allowFirstVisible) return firstVisible;
        return bestScore > 0 ? best : null;
      },
      args: [desired, !!options.allowFirstVisible]
    });
  } catch {
    return null;
  }
  return (rows || []).find((r) => !r.error && r.result)?.result || null;
}

export async function verifyAriaDropdownCommitted(tabId, autoId, desired) {
  let rows = [];
  try {
    rows = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: (id, value) => {
        const normalize = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
        const want = normalize(value);
        const findByLabel = () => {
          const token = normalize(id).replace(/[-_]+/g, " ").trim();
          let best = null;
          let bestScore = 0;
          for (const el of Array.from(document.querySelectorAll('[role="combobox"], [aria-haspopup="listbox"], button, input'))) {
            const r = el.getBoundingClientRect?.();
            if (!r || !r.width || !r.height) continue;
            const bag = normalize([
              el.getAttribute("aria-label"),
              el.getAttribute("id"),
              el.getAttribute("name"),
              el.textContent,
              el.closest?.("[data-automation-id], [data-qa], [data-testid], [id], [class]")?.textContent
            ].filter(Boolean).join(" "));
            let score = 0;
            if (token && bag.includes(token)) score += 4;
            if (token && token.split(" ").every((part) => part && bag.includes(part))) score += 2;
            if (score > bestScore) {
              bestScore = score;
              best = el;
            }
          }
          return bestScore > 0 ? best : null;
        };
        const esc = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(id) : id;
        const wrapper = document.querySelector(`[data-automation-id="${esc}"], [data-qa="${esc}"], [data-testid="${esc}"], [data-field-name="${esc}"], #${esc}, [name="${esc}"]`) || findByLabel();
        if (!wrapper) return false;
        const text = normalize(wrapper.textContent || "");
        const backing = Array.from(wrapper.querySelectorAll("input, select"))
          .map((el) => normalize(el.value || el.selectedOptions?.[0]?.textContent || ""))
          .filter(Boolean)
          .join(" ");
        return text.includes(want) || backing.includes(want) || want.includes(backing);
      },
      args: [autoId, desired]
    });
  } catch {
    return false;
  }
  return (rows || []).some((r) => !r.error && r.result === true);
}
