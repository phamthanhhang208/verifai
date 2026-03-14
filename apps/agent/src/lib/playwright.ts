/// <reference lib="dom" />
import { chromium } from "playwright";
import type { Browser, Page } from "playwright";
import type { GeminiAction, ComputerUseAction } from "@verifai/types";

// ─── Timeouts (configurable via env) ────────────────────
const PLAYWRIGHT_NAV_TIMEOUT_MS = parseInt(process.env.PLAYWRIGHT_NAVIGATION_TIMEOUT_MS || "15000");

// ─── Typed error for Playwright failures ─────────────────
// Carries incompleteReason so session.ts can mark steps without coupling
// Playwright internals to the session layer.
export class PlaywrightActionError extends Error {
  readonly incompleteReason: "timeout" | "crash";
  readonly isNavigation: boolean;

  constructor(
    message: string,
    opts: { incompleteReason: "timeout" | "crash"; isNavigation?: boolean }
  ) {
    super(message);
    this.name = "PlaywrightActionError";
    this.incompleteReason = opts.incompleteReason;
    this.isNavigation = opts.isNavigation ?? false;
  }
}

function classifyPlaywrightError(err: any, isNavigation = false): PlaywrightActionError {
  const msg: string = err?.message || String(err);

  // Network / connectivity errors → crash (environment issue, not a product bug)
  if (
    msg.includes("ERR_CONNECTION_REFUSED") ||
    msg.includes("net::ERR_") ||
    msg.includes("ECONNREFUSED") ||
    msg.includes("ERR_NAME_NOT_RESOLVED") ||
    msg.includes("ERR_INTERNET_DISCONNECTED")
  ) {
    return new PlaywrightActionError(msg, { incompleteReason: "crash", isNavigation });
  }

  // Playwright TimeoutError → timeout
  if (err?.name === "TimeoutError" || msg.toLowerCase().includes("timeout")) {
    return new PlaywrightActionError(msg, { incompleteReason: "timeout", isNavigation });
  }

  // Default for other unexpected Playwright errors
  return new PlaywrightActionError(msg, { incompleteReason: "crash", isNavigation });
}

let browser: Browser | null = null;
let page: Page | null = null;

export async function launchBrowser(): Promise<void> {
  browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
  });
  page = await context.newPage();
}

export async function navigateTo(url: string): Promise<void> {
  if (!page) throw new Error("Browser not launched");
  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: PLAYWRIGHT_NAV_TIMEOUT_MS });
  } catch (err: any) {
    throw classifyPlaywrightError(err, true);
  }
}

export async function takeScreenshot(): Promise<string> {
  if (!page) throw new Error("Browser not launched");
  // Send at full 1280×720 — do NOT resize. Gemini Computer Use returns coordinates
  // in the coordinate space of the image it receives. If we downscale to 1024px but
  // tell Gemini the viewport is 1280×720, clicks land ~25% off-target.
  const buffer = await page.screenshot({ type: "jpeg", quality: 80 });
  console.log(`[Screenshot] ${buffer.length} bytes (viewport 1280×720)`);
  return buffer.toString("base64");
}

const MAX_AOM_CHARS = 6000;

export async function getAOMSnapshot(): Promise<string> {
  if (!page) throw new Error("Browser not launched");
  let raw: string;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const snapshot = await (page as any).accessibility.snapshot();
    if (snapshot) {
      raw = JSON.stringify(snapshot, null, 2);
    } else {
      throw new Error("accessibility.snapshot() returned null");
    }
  } catch {
    // Fallback: enumerate visible interactive elements WITH bounding box coordinates
    // so Gemini can map elements to pixel positions in the screenshot.
    raw = await page.evaluate(() => {
      const SELECTORS = "button, a, input, select, textarea, [role], label, img, h1, h2, h3, h4, h5, h6, [data-test], [id]";
      const seen = new Set<Element>();
      return Array.from(document.querySelectorAll(SELECTORS))
        .filter((el) => {
          if (seen.has(el)) return false;
          seen.add(el);
          const r = el.getBoundingClientRect();
          // Only include visible elements within the viewport
          return r.width > 0 && r.height > 0 && r.top < 720 && r.bottom > 0 && r.left < 1280 && r.right > 0;
        })
        .map((el) => {
          const r = el.getBoundingClientRect();
          const cx = Math.round(r.left + r.width / 2);
          const cy = Math.round(r.top + r.height / 2);
          const tag = el.tagName.toLowerCase();
          const id = el.getAttribute("id") || "";
          const name = (el as HTMLInputElement).name || "";
          const type = (el as HTMLInputElement).type || "";
          const placeholder = (el as HTMLInputElement).placeholder || "";
          const text = el.textContent?.trim().slice(0, 60) || "";
          const role = el.getAttribute("role") || "";
          const dataTest = el.getAttribute("data-test") || "";

          let desc = `<${tag}`;
          if (id) desc += ` id="${id}"`;
          if (name) desc += ` name="${name}"`;
          if (type && tag === "input") desc += ` type="${type}"`;
          if (role) desc += ` role="${role}"`;
          if (dataTest) desc += ` data-test="${dataTest}"`;
          if (placeholder) desc += ` placeholder="${placeholder}"`;
          // Expose current value for input/textarea so the model knows which fields are filled
          if (tag === "input" || tag === "textarea") {
            const val = (el as HTMLInputElement).value || "";
            desc += ` value="${val.length > 30 ? val.slice(0, 30) + '…' : val}"`;
          }
          // Expose broken image metadata for <img> elements
          if (tag === "img") {
            const imgEl = el as HTMLImageElement;
            const alt = imgEl.alt || "";
            if (alt) desc += ` alt="${alt.slice(0, 40)}"`;
            if (imgEl.naturalWidth === 0 && imgEl.src) desc += ` [BROKEN IMAGE]`;
          }
          desc += `>`;
          if (text && tag !== "input") desc += ` "${text}"`;
          desc += ` @(${cx},${cy})`;
          return desc;
        })
        .join("\n");
    });
  }

  if (raw.length > MAX_AOM_CHARS) {
    raw = raw.slice(0, MAX_AOM_CHARS) + "\n... (truncated)";
  }
  console.log(`[AOM] snapshot length: ${raw.length} chars`);
  return raw;
}

export async function injectHighlight(selector: string): Promise<void> {
  if (!page) throw new Error("Browser not launched");
  await page.evaluate((sel: string) => {
    const el = document.querySelector(sel);
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const existing = document.getElementById("verifai-highlight");
    if (existing) existing.remove();
    const highlight = document.createElement("div");
    highlight.id = "verifai-highlight";
    highlight.style.cssText = `
      position: fixed;
      top: ${rect.top - 4}px;
      left: ${rect.left - 4}px;
      width: ${rect.width + 8}px;
      height: ${rect.height + 8}px;
      border: 3px solid #ef4444;
      border-radius: 6px;
      box-shadow: 0 0 12px rgba(239, 68, 68, 0.6), 0 0 24px rgba(239, 68, 68, 0.3);
      pointer-events: none;
      z-index: 99999;
    `;
    document.body.appendChild(highlight);
    setTimeout(() => highlight.remove(), 600);
  }, selector);
  // Wait for highlight to be visible before screenshot
  await new Promise((r) => setTimeout(r, 200));
}

export async function executeAction(action: GeminiAction): Promise<void> {
  if (!page) throw new Error("Browser not launched");

  switch (action.action) {
    case "click":
      if (!action.selector) throw new Error("Click action requires selector");
      await page.click(action.selector, { timeout: 5000 });
      break;

    case "type":
      if (!action.selector || action.value === undefined)
        throw new Error("Type action requires selector and value");
      await page.fill(action.selector, action.value, { timeout: 5000 });
      break;

    case "navigate":
      if (!action.value) throw new Error("Navigate action requires value (URL)");
      await page.goto(action.value, { waitUntil: "networkidle", timeout: 15000 });
      break;

    case "scroll":
      await page.evaluate((direction: string) => {
        window.scrollBy(0, direction === "up" ? -300 : 300);
      }, action.value || "down");
      break;

    case "wait":
      await new Promise((r) => setTimeout(r, parseInt(action.value || "1000")));
      break;

    case "assert":
      // Assert is handled by verification — no browser action needed
      break;

    default:
      throw new Error(`Unknown action: ${action.action}`);
  }
}

export async function closeBrowser(): Promise<void> {
  if (browser) {
    await browser.close();
    browser = null;
    page = null;
  }
}

export async function getCurrentUrl(): Promise<string> {
  if (!page) throw new Error("Browser not launched");
  return page.url();
}

export async function injectHighlightAtCoord(x: number, y: number): Promise<void> {
  if (!page) throw new Error("Browser not launched");
  await page.evaluate(({ x, y }: { x: number; y: number }) => {
    document.getElementById("verifai-highlight")?.remove();
    const d = document.createElement("div");
    d.id = "verifai-highlight";
    const s = 36;
    d.style.cssText = `position:fixed;top:${y - s / 2}px;left:${x - s / 2}px;width:${s}px;height:${s}px;border:3px solid #ef4444;border-radius:50%;box-shadow:0 0 12px rgba(239,68,68,0.6),0 0 24px rgba(239,68,68,0.3);pointer-events:none;z-index:99999;`;
    document.body.appendChild(d);
    setTimeout(() => d.remove(), 600);
  }, { x, y });
  await new Promise((r) => setTimeout(r, 200));
}

export async function executeComputerAction(action: ComputerUseAction): Promise<void> {
  if (!page) throw new Error("Browser not launched");

  switch (action.type) {
    case "click": {
      if (!action.coordinate) throw new Error("Click requires [x,y] coordinates");
      const [x, y] = action.coordinate;
      console.log(`[Action] click at (${x}, ${y})`);
      await injectHighlightAtCoord(x, y);
      await page.mouse.click(x, y);
      break;
    }
    case "type": {
      if (!action.text) throw new Error("Type requires text");
      let targetId: string | null = null; // track target element ID across scopes

      // Input types that can actually receive keyboard text
      const TYPEABLE_INPUT_TYPES = new Set([
        "text", "password", "email", "number", "search",
        "tel", "url", "date", "time", "datetime-local",
        "month", "week", "color", "",
      ]);

      if (action.coordinate) {
        const [x, y] = action.coordinate;

        // Check what element is actually at the target coordinate.
        const atCoord = await page.evaluate(
          ({ px, py, typeableTypes }: { px: number; py: number; typeableTypes: string[] }) => {
            const typeableSet = new Set(typeableTypes);
            const el = document.elementFromPoint(px, py);
            if (!el) return null;
            const tag = el.tagName.toLowerCase();
            const inputType = (el as HTMLInputElement).type ?? "";
            return {
              tag,
              inputType,
              id: el.id,
              name: (el as HTMLInputElement).name ?? "",
              placeholder: (el as HTMLInputElement).placeholder ?? "",
              isTypeable: tag === "textarea" || (tag === "input" && typeableSet.has(inputType)),
            };
          },
          { px: x, py: y, typeableTypes: [...TYPEABLE_INPUT_TYPES] }
        );

        console.log(`[Action] type at (${x}, ${y}) — <${atCoord?.tag}> type="${atCoord?.inputType}" id="${atCoord?.id}" name="${atCoord?.name}" placeholder="${atCoord?.placeholder}" typeable=${atCoord?.isTypeable}`);
        targetId = atCoord?.id || null;

        // If element at coordinate is NOT typeable, try semantic matching by reasoning text
        if (atCoord && !atCoord.isTypeable) {
          const reasoningWords = (action.reasoning ?? "")
            .toLowerCase()
            .split(/[\s_\-/.,"'()]+/)
            .filter((w) => w.length >= 3);

          const semantic = await page.evaluate(
            ({ words, typeableTypes }: { words: string[]; typeableTypes: string[] }) => {
              const typeableSet = new Set(typeableTypes);
              const inputs = Array.from(
                document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea")
              ).filter((c) => {
                const r = c.getBoundingClientRect();
                if (r.width === 0 || r.height === 0) return false;
                return c.tagName === "TEXTAREA" || typeableSet.has((c as HTMLInputElement).type ?? "");
              });
              let bestScore = 0;
              let bestEl: { id: string; name: string } | null = null;
              for (const el of inputs) {
                const attrs = [
                  el.id, el.getAttribute("name") ?? "",
                  el.getAttribute("placeholder") ?? "",
                  el.getAttribute("aria-label") ?? "",
                ].map((a) => a.toLowerCase());
                const score = words.filter((w) => attrs.some((a) => a.includes(w))).length;
                if (score > bestScore) { bestScore = score; bestEl = { id: el.id, name: el.getAttribute("name") ?? "" }; }
              }
              return bestScore > 0 ? bestEl : null;
            },
            { words: reasoningWords, typeableTypes: [...TYPEABLE_INPUT_TYPES] }
          );

          if (semantic?.id) {
            console.warn(`[Action] type — coords hit non-typeable <${atCoord.tag}>, semantic match: #${semantic.id}`);
            targetId = semantic.id;
          } else {
            console.warn(`[Action] type — coords hit non-typeable <${atCoord.tag}> and no semantic match — skipping`);
            break;
          }
        }
      }

      // ── Fill the field ──────────────────────────────────────
      if (targetId) {
        // Direct locator approach — no pre-focus, no evaluate, just fill
        const loc = page.locator(`#${targetId}`);
        await loc.scrollIntoViewIfNeeded();

        // Attempt 1: Playwright fill()
        await loc.fill(action.text);
        await new Promise((r) => setTimeout(r, 50)); // let React process
        let val = await loc.inputValue();
        console.log(`[Action] type — fill() #${targetId} = "${val.slice(0, 40)}"`);

        // Attempt 2: React native value setter hack
        if (!val) {
          console.warn(`[Action] type — fill() empty, trying React native setter`);
          await page.evaluate(({ id, text }) => {
            const el = document.getElementById(id) as HTMLInputElement | null;
            if (!el) return;
            el.focus();
            const nativeSetter = Object.getOwnPropertyDescriptor(
              HTMLInputElement.prototype, "value"
            )?.set;
            if (nativeSetter) nativeSetter.call(el, text);
            else el.value = text;
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
          }, { id: targetId, text: action.text });
          await new Promise((r) => setTimeout(r, 50));
          val = await loc.inputValue();
          console.log(`[Action] type — native setter #${targetId} = "${val.slice(0, 40)}"`);
        }

        // Attempt 3: click element then keyboard type
        if (!val) {
          console.warn(`[Action] type — native setter empty, trying click + keyboard`);
          await loc.click();
          await new Promise((r) => setTimeout(r, 100));
          await page.keyboard.type(action.text, { delay: 50 });
          await new Promise((r) => setTimeout(r, 50));
          val = await loc.inputValue();
          console.log(`[Action] type — click+keyboard #${targetId} = "${val.slice(0, 40)}"`);
        }
      } else {
        // No ID available — click coordinates then keyboard type
        await injectHighlightAtCoord(action.coordinate![0], action.coordinate![1]);
        await page.mouse.click(action.coordinate![0], action.coordinate![1]);
        await new Promise((r) => setTimeout(r, 100));
        await page.keyboard.type(action.text, { delay: 30 });
        console.log(`[Action] type — typed "${action.text.slice(0, 40)}" via keyboard (no ID)`);
      }
      break;
    }
    case "key_press": {
      if (!action.key) throw new Error("key_press requires key name");
      await page.keyboard.press(action.key);
      break;
    }
    case "scroll": {
      const d = action.direction || "down";
      const delta = (d === "up" || d === "left") ? -300 : 300;
      (d === "up" || d === "down") ? await page.mouse.wheel(0, delta) : await page.mouse.wheel(delta, 0);
      break;
    }
    case "navigate": {
      if (!action.url) {
        console.warn("[Action] navigate called without URL — skipping");
        break;
      }
      try {
        await page.goto(action.url, { waitUntil: "networkidle", timeout: PLAYWRIGHT_NAV_TIMEOUT_MS });
      } catch (err: any) {
        throw classifyPlaywrightError(err, true);
      }
      break;
    }
    case "wait": {
      await new Promise((r) => setTimeout(r, 1500));
      break;
    }
    case "screenshot": break; // No-op — caller handles
    case "drag": {
      if (!action.coordinate) throw new Error("Drag requires coordinates");
      await page.mouse.move(action.coordinate[0], action.coordinate[1]);
      break;
    }
    default:
      throw new Error(`Unknown action: ${(action as any).type}`);
  }

  await new Promise((r) => setTimeout(r, 300)); // Let page settle
}
