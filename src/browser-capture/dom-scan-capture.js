import { runBrowserMcpTool } from "./browser-mcp-background.js";

export async function captureDomOutline(tabId) {
  try {
    const started = Date.now();
    const rows = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const A = globalThis.__formFillerAriaSnapshot || {};
        const normalize = typeof A.normalizeWhiteSpace === "function"
          ? A.normalizeWhiteSpace
          : (text) => String(text || "").replace(/\s+/g, " ").trim();
        const getChildren = typeof A.getMergedChildNodes === "function"
          ? (el) => A.getMergedChildNodes(el)
          : (el) => Array.from(el.childNodes || []);
        const roleOf = typeof A.getAriaRole === "function"
          ? (el) => A.getAriaRole(el) || ""
          : (el) => el.getAttribute?.("role") || "";
        const nameOf = typeof A.accessibleName === "function"
          ? (el) => normalize(A.accessibleName(el) || "")
          : (el) => normalize(el.getAttribute?.("aria-label") || "");
        const blocked = typeof A.subtreeBlocked === "function"
          ? (el) => A.subtreeBlocked(el)
          : (el) => ["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "META", "LINK"].includes(el.tagName);
        const visible = typeof A.isProbablyVisible === "function"
          ? (el) => A.isProbablyVisible(el)
          : (el) => {
              const style = window.getComputedStyle(el);
              const rect = el.getBoundingClientRect?.();
              return style.display !== "none" && style.visibility !== "hidden" && !!rect && rect.width > 0 && rect.height > 0;
            };
        const directText = typeof A.directTextsJoined === "function"
          ? (el) => A.directTextsJoined(el)
          : (el) => Array.from(el.childNodes || [])
              .filter((node) => node.nodeType === Node.TEXT_NODE)
              .map((node) => normalize(node.nodeValue || ""))
              .filter(Boolean)
              .join(" ");

        function attrs(el) {
          return [
            "id",
            "name",
            "type",
            "role",
            "aria-label",
            "aria-labelledby",
            "aria-controls",
            "aria-owns",
            "aria-expanded",
            "placeholder",
            "value"
          ]
            .map((name) => {
              const value = el.getAttribute?.(name);
              return value ? `${name}=${JSON.stringify(value.slice(0, 80))}` : "";
            })
            .filter(Boolean)
            .join(" ");
        }

        function lineFor(el, depth) {
          const tag = el.tagName.toLowerCase();
          const role = roleOf(el);
          const name = nameOf(el);
          const text = directText(el);
          const bits = [
            `<${tag}${attrs(el) ? " " + attrs(el) : ""}>`,
            role ? `role=${JSON.stringify(role)}` : "",
            name ? `name=${JSON.stringify(name.slice(0, 120))}` : "",
            visible(el) ? "visible" : "not-visible",
            text ? `text=${JSON.stringify(text.slice(0, 160))}` : ""
          ].filter(Boolean);
          return `${"  ".repeat(depth)}${bits.join(" ")}`;
        }

        const lines = [];
        lines.push("# Live DOM material used by browser_snapshot traversal");
        lines.push("# Includes merged shadow DOM children when aria-snapshot helpers expose them.");
        function walk(el, depth = 0) {
          if (!(el instanceof Element) || lines.length >= 3000) return;
          if (blocked(el)) return;
          lines.push(lineFor(el, depth));
          for (const child of getChildren(el)) {
            if (child.nodeType === Node.ELEMENT_NODE) {
              walk(/** @type {Element} */ (child), depth + 1);
            } else if (child.nodeType === Node.TEXT_NODE) {
              const text = normalize(child.nodeValue || "");
              if (text) lines.push(`${"  ".repeat(depth + 1)}#text ${JSON.stringify(text.slice(0, 160))}`);
            }
          }
        }
        walk(document.body || document.documentElement);
        return {
          url: location.href,
          title: document.title || "",
          domOutline: lines.join("\n").slice(0, 200000)
        };
      }
    });
    const result = rows?.[0]?.result;
    if (!result) return { ok: false, error: "Could not capture DOM from page." };
    return {
      ok: true,
      ...result,
      timings: { dom_capture_ms: Date.now() - started }
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "DOM capture failed." };
  }
}

export async function captureDomThenSnapshot(tabId) {
  const started = Date.now();
  const dom = await captureDomOutline(tabId);
  if (!dom.ok) return dom;
  const snapshotStarted = Date.now();
  const snapshotResult = await runBrowserMcpTool(
    {
      tool: "browser_snapshot",
      payload: { boxes: false, highlightRefs: false },
      tabId
    },
    {}
  ).catch((error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  return {
    ok: true,
    url: dom.url || "",
    title: dom.title || "",
    domOutline: dom.domOutline || "",
    snapshot_text: snapshotResult?.ok ? String(snapshotResult.snapshot || "").slice(0, 200000) : "",
    snapshot_source: snapshotResult?.ok ? "extension_browser_snapshot" : "dom_excerpt_fallback",
    snapshot_error: snapshotResult?.ok ? "" : String(snapshotResult?.error || ""),
    timings: {
      dom_capture_ms: Number(dom?.timings?.dom_capture_ms || 0),
      snapshot_capture_ms: Date.now() - snapshotStarted,
      total_ms: Date.now() - started
    }
  };
}

