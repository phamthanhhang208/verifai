/// <reference lib="dom" />
import { chromium } from "playwright";
import type { Browser, Page } from "playwright";
import sharp from "sharp";
import type { GeminiAction } from "@verifai/types";

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
  await page.goto(url, { waitUntil: "networkidle", timeout: 15000 });
}

export async function takeScreenshot(): Promise<string> {
  if (!page) throw new Error("Browser not launched");
  const buffer = await page.screenshot({ type: "jpeg", quality: 80 });

  // Compress to max 1024px width, JPEG 60%
  const compressed = await sharp(buffer)
    .resize({ width: 1024, withoutEnlargement: true })
    .jpeg({ quality: 60 })
    .toBuffer();

  return compressed.toString("base64");
}

export async function getAOMSnapshot(): Promise<string> {
  if (!page) throw new Error("Browser not launched");
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const snapshot = await (page as any).accessibility.snapshot();
    return JSON.stringify(snapshot, null, 2);
  } catch {
    // Fallback: return visible text content if accessibility API unavailable
    const text = await page.evaluate(() =>
      Array.from(document.querySelectorAll("button, a, input, select, [role]"))
        .map((el) => `${el.tagName} [${el.getAttribute("id") || el.getAttribute("name") || ""}]: ${el.textContent?.trim().slice(0, 60)}`)
        .join("\n")
    );
    return text;
  }
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
