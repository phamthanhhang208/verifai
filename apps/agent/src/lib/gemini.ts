import { GoogleGenAI, Environment } from "@google/genai";
import { z } from "zod";
import type { ComputerUseAction, GeminiVerification, TestStep } from "@verifai/types";
import { MODELS, callGeminiWithBackoff, waitForRateLimit, withRetry } from "./models.js";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

const VerificationSchema = z.object({
  passed: z.boolean(),
  finding: z.string(),
  severity: z.enum(["high", "medium", "low"]).optional(),
});

function cleanJSON(text: string): string {
  return text.replace(/^```json?\n?/g, "").replace(/\n?```$/g, "").trim();
}

// ─── Call context passed from the session layer ──────────
// Carries the socket so callGeminiWithBackoff can emit [WARN] narrations.

export interface GeminiCallContext {
  socket: any;
  abortSignal?: { aborted: boolean };
}

// ════════════════════════════════════════════════════════
// VISION MODEL — Gemini 3 Flash + Computer Use (5 RPM)
// This is the CORE of the agent — it SEES the browser and
// decides WHAT ACTION to take next.
// ════════════════════════════════════════════════════════

export async function decideAction(
  screenshotBase64: string,
  aomSnapshot: string,
  step: TestStep,
  previousActions: string[] = [],
  ctx?: GeminiCallContext
): Promise<ComputerUseAction> {
  const callFn = async () => {
    const prevContext = previousActions.length > 0
      ? `\nPrevious actions this session:\n${previousActions.slice(-5).join("\n")}`
      : "";

    const response = await ai.models.generateContent({
      model: MODELS.vision,
      contents: [
        {
          role: "user",
          parts: [
            {
              inlineData: {
                mimeType: "image/jpeg",
                data: screenshotBase64,
              },
            },
            {
              text: `You are an autonomous QA browser agent. You are looking at a LIVE screenshot of a web application.

YOUR CURRENT TASK: ${step.text}
EXPECTED OUTCOME: ${step.expectedBehavior}
${step.targetElement ? `HINT — look for element matching: ${step.targetElement}` : ""}
${prevContext}

Accessibility tree (partial):
${aomSnapshot}

INSTRUCTIONS:
- The browser viewport is exactly 1280×720 pixels
- Decide the SINGLE NEXT action to accomplish the task
- Use the computer_use tool to perform the action
- Click coordinates must target the CENTER of the element you want to interact with
- For text input fields: click the field coordinate first, then use type with the text
- If the expected outcome is ALREADY visible on screen, respond with text "STEP_COMPLETE"
- Be precise with pixel coordinates — look carefully at the screenshot`,
            },
          ],
        },
      ],
      config: {
        tools: [{
          computerUse: {
            environment: Environment.ENVIRONMENT_BROWSER,
          },
        }],
      },
    });

    return parseComputerUseResponse(response);
  };

  if (ctx) {
    return callGeminiWithBackoff(callFn, { model: MODELS.vision, socket: ctx.socket, abortSignal: ctx.abortSignal });
  }
  return withRetry(async () => {
    await waitForRateLimit(MODELS.vision);
    return callFn();
  }, "decideAction");
}

export async function retryAction(
  errorString: string,
  screenshotBase64: string,
  aomSnapshot: string,
  step: TestStep,
  ctx?: GeminiCallContext
): Promise<ComputerUseAction> {
  const callFn = async () => {
    const response = await ai.models.generateContent({
      model: MODELS.vision,
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType: "image/jpeg", data: screenshotBase64 } },
            {
              text: `Your previous browser action FAILED with this error:
ERROR: ${errorString}

TASK: ${step.text}
EXPECTED: ${step.expectedBehavior}

Accessibility tree:
${aomSnapshot}

Look at the screenshot carefully. Try a DIFFERENT approach — different coordinates, different element, or a different action type entirely. Viewport is 1280×720. Use the computer_use tool.`,
            },
          ],
        },
      ],
      config: {
        tools: [{ computerUse: { environment: Environment.ENVIRONMENT_BROWSER } }],
      },
    });

    const action = parseComputerUseResponse(response);
    action.reasoning = `Self-heal: ${action.reasoning || "retrying differently"}`;
    return action;
  };

  if (ctx) {
    return callGeminiWithBackoff(callFn, { model: MODELS.vision, socket: ctx.socket, abortSignal: ctx.abortSignal });
  }
  return withRetry(async () => {
    await waitForRateLimit(MODELS.vision);
    return callFn();
  }, "retryAction");
}

// Fallback when vision model (3 Flash) is rate-limited — use lite model
export async function fallbackDecideAction(
  screenshotBase64: string,
  aomSnapshot: string,
  step: TestStep,
  ctx?: GeminiCallContext
): Promise<ComputerUseAction> {
  const callFn = async () => {
    const response = await ai.models.generateContent({
      model: MODELS.lite,
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType: "image/jpeg", data: screenshotBase64 } },
            {
              text: `Browser QA agent. Viewport 1280×720. Task: "${step.text}". Expected: "${step.expectedBehavior}".
${step.targetElement ? `Element hint: ${step.targetElement}` : ""}

Accessibility tree:
${aomSnapshot}

Return ONLY a JSON object, no markdown fences:
{"type":"click","coordinate":[x,y],"reasoning":"why"}
Valid types: click, type, scroll, key_press, navigate, wait
For type: include "text" field. For key_press: include "key" field. For scroll: include "direction" field.`,
            },
          ],
        },
      ],
    });

    const parsed = JSON.parse(cleanJSON(response.text || ""));
    return {
      type: parsed.type || "click",
      coordinate: parsed.coordinate,
      text: parsed.text,
      key: parsed.key,
      direction: parsed.direction,
      url: parsed.url,
      reasoning: `[Fallback] ${parsed.reasoning || "lite model decision"}`,
    } as ComputerUseAction;
  };

  if (ctx) {
    return callGeminiWithBackoff(callFn, { model: MODELS.lite, socket: ctx.socket, abortSignal: ctx.abortSignal });
  }
  return withRetry(async () => {
    await waitForRateLimit(MODELS.lite);
    return callFn();
  }, "fallbackDecideAction");
}

// ════════════════════════════════════════════════════════
// Parse Gemini 3 Flash Computer Use response
// ════════════════════════════════════════════════════════

function parseComputerUseResponse(response: any): ComputerUseAction {
  const candidate = response.candidates?.[0];
  if (!candidate?.content?.parts) {
    throw new Error("Empty response from Gemini Computer Use model");
  }

  for (const part of candidate.content.parts) {
    // Native Computer Use function_call
    if (part.functionCall) {
      const args = (part.functionCall.args || {}) as Record<string, any>;
      return {
        type: args.action || part.functionCall.name || "click",
        coordinate: args.coordinate ? [args.coordinate[0], args.coordinate[1]] : undefined,
        text: args.text,
        key: args.key,
        url: args.url,
        direction: args.direction,
        reasoning: args.reasoning || `Computer Use: ${part.functionCall.name}`,
      };
    }

    // Text response — STEP_COMPLETE or fallback JSON
    if (part.text) {
      const text = part.text.trim();
      if (text.includes("STEP_COMPLETE")) {
        return { type: "screenshot", reasoning: "Step already complete" };
      }
      try {
        const p = JSON.parse(cleanJSON(text));
        return {
          type: p.action || p.type || "click",
          coordinate: p.coordinate,
          text: p.text || p.value,
          key: p.key,
          url: p.url,
          direction: p.direction,
          reasoning: p.reasoning || "Parsed from text",
        };
      } catch {
        console.warn("[Gemini] Non-parseable text:", text.slice(0, 150));
      }
    }
  }

  throw new Error("No actionable response from Computer Use model");
}

// ════════════════════════════════════════════════════════
// LITE MODEL — Gemini 2.5 Flash Lite (10 RPM)
// Used for: verification, narration, bug descriptions
// These do NOT consume the precious 5 RPM vision quota
// ════════════════════════════════════════════════════════

export async function verifyStep(
  screenshotBase64: string,
  expectedBehavior: string,
  ctx?: GeminiCallContext
): Promise<GeminiVerification> {
  const callFn = async () => {
    const response = await ai.models.generateContent({
      model: MODELS.lite,
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType: "image/jpeg", data: screenshotBase64 } },
            {
              text: `QA verification. Look at this screenshot. Did the expected behavior happen?

Expected: ${expectedBehavior}

Return ONLY JSON, no markdown: {"passed":true/false,"finding":"what you see","severity":"high"|"medium"|"low"}
(severity only needed when passed=false)`,
            },
          ],
        },
      ],
    });

    return VerificationSchema.parse(JSON.parse(cleanJSON(response.text || "")));
  };

  if (ctx) {
    return callGeminiWithBackoff(callFn, { model: MODELS.lite, socket: ctx.socket, abortSignal: ctx.abortSignal });
  }
  return withRetry(async () => {
    await waitForRateLimit(MODELS.lite);
    return callFn();
  }, "verifyStep");
}

export async function generateNarration(
  action: ComputerUseAction,
  ctx?: GeminiCallContext
): Promise<string> {
  const desc = action.type === "click" ? `Clicking at (${action.coordinate?.[0]},${action.coordinate?.[1]})`
    : action.type === "type" ? `Typing "${(action.text || "").slice(0, 30)}"`
    : action.type === "scroll" ? `Scrolling ${action.direction || "down"}`
    : action.type === "key_press" ? `Pressing ${action.key}`
    : action.type === "navigate" ? `Navigating to ${action.url}`
    : action.type;

  const callFn = async () => {
    const r = await ai.models.generateContent({
      model: MODELS.lite,
      contents: `Write one brief sentence for a QA log. Action: ${desc}. Context: ${action.reasoning || "test step"}. Return ONLY the sentence.`,
    });
    return r.text?.trim() || desc;
  };

  if (ctx) {
    return callGeminiWithBackoff(callFn, { model: MODELS.lite, socket: ctx.socket, abortSignal: ctx.abortSignal });
  }
  return withRetry(async () => {
    await waitForRateLimit(MODELS.lite);
    return callFn();
  }, "generateNarration");
}

export async function generateBugDescription(
  step: TestStep,
  finding: string,
  screenshotBase64: string,
  ctx?: GeminiCallContext
): Promise<{ title: string; description: string }> {
  const callFn = async () => {
    const r = await ai.models.generateContent({
      model: MODELS.lite,
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType: "image/jpeg", data: screenshotBase64 } },
            { text: `Bug ticket. Step: "${step.text}". Expected: "${step.expectedBehavior}". Finding: "${finding}". Return JSON only: {"title":"...","description":"..."}` },
          ],
        },
      ],
    });
    return JSON.parse(cleanJSON(r.text || ""));
  };

  if (ctx) {
    return callGeminiWithBackoff(callFn, { model: MODELS.lite, socket: ctx.socket, abortSignal: ctx.abortSignal });
  }
  return withRetry(async () => {
    await waitForRateLimit(MODELS.lite);
    return callFn();
  }, "generateBugDescription");
}

// Legacy alias — Phase 3 code may import sendToolResponse
export const sendToolResponse = retryAction;
