import { GoogleGenAI, Environment } from "@google/genai";
import { z } from "zod";
import type {
  ComputerUseAction,
  GeminiVerification,
  TestStep,
} from "@verifai/types";
import {
  MODELS,
  callGeminiWithBackoff,
  waitForRateLimit,
  withRetry,
} from "./models.js";

const SERVER_KEY = process.env.GEMINI_API_KEY;
const ai = new GoogleGenAI({ apiKey: SERVER_KEY!, apiVersion: "v1beta" });

/** Returns a GoogleGenAI instance — uses caller-supplied key if provided, else the server env key. */
function getAI(apiKey?: string): GoogleGenAI {
  return apiKey ? new GoogleGenAI({ apiKey }) : ai;
}

const VerificationSchema = z.object({
  passed: z.boolean(),
  finding: z.string().default(""),
  severity: z.enum(["high", "medium", "low"]).optional(),
});

function cleanJSON(text: string): string {
  return text
    .replace(/^```json?\n?/g, "")
    .replace(/\n?```$/g, "")
    .trim();
}

// ─── Call context passed from the session layer ──────────
// Carries the socket so callGeminiWithBackoff can emit [WARN] narrations.

export interface GeminiCallContext {
  socket: any;
  abortSignal?: { aborted: boolean };
  apiKey?: string; // Optional user-supplied Gemini API key — overrides server env key
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
  ctx?: GeminiCallContext,
): Promise<ComputerUseAction> {
  const callFn = async () => {
    const prevContext =
      previousActions.length > 0
        ? `\nPrevious actions this session:\n${previousActions.slice(-5).join("\n")}`
        : "";

    console.log(`[Gemini] decideAction → model: ${MODELS.vision}`);

    //console.log(Environment.ENVIRONMENT_BROWSER.toString());
    const response = await getAI(ctx?.apiKey).models.generateContent({
      model: MODELS.vision,
      contents: [
        {
          role: "user",
          parts: [
            {
              text: `You are an autonomous QA browser agent. You are looking at a LIVE screenshot of a web application.

      YOUR CURRENT TASK: ${step.text}
      EXPECTED OUTCOME: ${step.expectedBehavior}
      ${step.targetElement ? `HINT — look for element matching: ${step.targetElement}` : ""}
      ${prevContext}

      Accessibility tree (with element center coordinates @(x,y)):
      ${aomSnapshot}

      INSTRUCTIONS:
      - The browser viewport is exactly 1280×720 pixels
      - Decide the SINGLE NEXT action to accomplish the task
      - Use the computer_use tool to perform the action
      - IMPORTANT: Use the @(x,y) coordinates from the accessibility tree above for precise targeting
      - Click coordinates must target the CENTER of the element you want to interact with
      - For text input fields: click the field coordinate first, then use type with the text
      - If the expected outcome is ALREADY visible on screen, respond with text "STEP_COMPLETE"
      - Be precise with pixel coordinates — cross-reference the screenshot with the accessibility tree coordinates`,
            },
            {
              inlineData: {
                mimeType: "image/jpeg",
                data: screenshotBase64,
              },
            },
          ],
        },
      ],
      config: {
        tools: [
          {
            computerUse: {
              //environment: Environment.ENVIRONMENT_BROWSER,
              environment: "ENVIRONMENT_BROWSER",
            },
          },
        ],
      },
    });

    return parseComputerUseResponse(response);
  };

  if (ctx) {
    return callGeminiWithBackoff(callFn, {
      model: MODELS.vision,
      socket: ctx.socket,
      abortSignal: ctx.abortSignal,
    });
  }
  return withRetry(async () => {
    await waitForRateLimit(MODELS.vision);
    return callFn();
  }, "decideAction");
}

// ════════════════════════════════════════════════════════
// ESCALATED ACTION — Gemini 2.5 Flash (text/JSON mode)
// Used when the vision model prematurely declares a step complete
// or repeatedly misidentifies targets. Returns JSON action (no Computer Use
// tool dependency) so it works on any API key without preview enrollment.
// ════════════════════════════════════════════════════════

export async function escalatedDecideAction(
  screenshotBase64: string,
  aomSnapshot: string,
  step: TestStep,
  previousActions: string[] = [],
  ctx?: GeminiCallContext,
): Promise<ComputerUseAction> {
  const callFn = async () => {
    const prevContext =
      previousActions.length > 0
        ? `\nActions already taken this step:\n${previousActions.slice(-8).join("\n")}`
        : "";

    console.log(`[Gemini] escalatedDecideAction → model: ${MODELS.pro}`);
    const response = await getAI(ctx?.apiKey).models.generateContent({
      model: MODELS.pro,
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType: "image/jpeg", data: screenshotBase64 } },
            {
              text: `You are a senior QA browser agent. The standard model already attempted this step but did NOT fully complete it — the expected outcome is NOT yet visible.

TASK (must be completed in full): ${step.text}
EXPECTED OUTCOME (not yet achieved): ${step.expectedBehavior}
${step.targetElement ? `TARGET HINT: ${step.targetElement}` : ""}
${prevContext}

Accessibility tree (with element center coordinates @(x,y)):
${aomSnapshot}

CRITICAL INSTRUCTIONS:
- Viewport is exactly 1280×720 pixels
- IMPORTANT: Use the @(x,y) coordinates from the accessibility tree above for precise targeting
- Look carefully at what is MISSING from the current state — what action has NOT been done yet?
- The task may require filling multiple fields AND clicking a submit/confirm button — make sure ALL parts are done
- Choose the SINGLE NEXT action that makes the most progress toward the expected outcome
- If the expected outcome IS already fully visible, respond with text "STEP_COMPLETE"
- Be precise with pixel coordinates

Return ONLY a JSON object — no markdown, no extra text.
Action formats:
- Click:    {"type":"click","coordinate":[x,y],"reasoning":"..."}
- Type:     {"type":"type","coordinate":[x,y],"text":"text to type","reasoning":"..."}
- Key:      {"type":"key_press","key":"Enter","reasoning":"..."}
- Scroll:   {"type":"scroll","direction":"down","reasoning":"..."}
- Navigate: {"type":"navigate","url":"https://...","reasoning":"..."}`,
            },
          ],
        },
      ],
    });

    const text = response.text?.trim() || "";
    if (text.includes("STEP_COMPLETE")) {
      return {
        type: "screenshot",
        reasoning: "Step already complete (escalated)",
      } as ComputerUseAction;
    }
    try {
      const p = JSON.parse(cleanJSON(text));
      return {
        type: p.type || "click",
        coordinate: p.coordinate,
        text: p.text,
        key: p.key,
        url: p.url,
        direction: p.direction,
        reasoning: `[Escalated] ${p.reasoning || "flash escalation decision"}`,
      } as ComputerUseAction;
    } catch {
      console.warn(
        "[Gemini] escalated: non-parseable response:",
        text.slice(0, 150),
      );
      throw new Error(
        `Escalated model returned unparseable response: ${text.slice(0, 100)}`,
      );
    }
  };

  if (ctx) {
    return callGeminiWithBackoff(callFn, {
      model: MODELS.pro,
      socket: ctx.socket,
      abortSignal: ctx.abortSignal,
    });
  }
  return withRetry(async () => {
    await waitForRateLimit(MODELS.pro);
    return callFn();
  }, "escalatedDecideAction");
}

export async function retryAction(
  errorString: string,
  screenshotBase64: string,
  aomSnapshot: string,
  step: TestStep,
  ctx?: GeminiCallContext,
): Promise<ComputerUseAction> {
  const callFn = async () => {
    console.log(`[Gemini] retryAction → model: ${MODELS.vision}`);
    const response = await getAI(ctx?.apiKey).models.generateContent({
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

Accessibility tree (with element center coordinates @(x,y)):
${aomSnapshot}

Look at the screenshot carefully. Try a DIFFERENT approach — use the @(x,y) coordinates from the accessibility tree for precise targeting. Viewport is 1280×720. Use the computer_use tool.`,
            },
          ],
        },
      ],
      config: {
        tools: [
          { computerUse: { environment: Environment.ENVIRONMENT_BROWSER } },
        ],
      },
    });

    const action = parseComputerUseResponse(response);
    action.reasoning = `Self-heal: ${action.reasoning || "retrying differently"}`;
    return action;
  };

  if (ctx) {
    return callGeminiWithBackoff(callFn, {
      model: MODELS.vision,
      socket: ctx.socket,
      abortSignal: ctx.abortSignal,
    });
  }
  return withRetry(async () => {
    await waitForRateLimit(MODELS.vision);
    return callFn();
  }, "retryAction");
}

// Fallback when vision model is rate-limited/unavailable — use flash (deeper reasoning)
export async function fallbackDecideAction(
  screenshotBase64: string,
  aomSnapshot: string,
  step: TestStep,
  ctx?: GeminiCallContext,
): Promise<ComputerUseAction> {
  const callFn = async () => {
    console.log(`[Gemini] fallbackDecideAction → model: ${MODELS.flash}`);
    const response = await getAI(ctx?.apiKey).models.generateContent({
      model: MODELS.flash,
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType: "image/jpeg", data: screenshotBase64 } },
            {
              text: `Browser QA agent. Viewport 1280×720. Task: "${step.text}". Expected: "${step.expectedBehavior}".
    ${step.targetElement ? `Element hint: ${step.targetElement}` : ""}

    Accessibility tree (with element center coordinates @(x,y)):
    ${aomSnapshot}

    Decide the SINGLE NEXT action to make progress on the task.
    IMPORTANT: Use the @(x,y) coordinates from the accessibility tree for precise targeting.
    Return ONLY a JSON object — no markdown, no extra text.

    Action formats:
    - Click an element:  {"type":"click","coordinate":[x,y],"reasoning":"..."}
    - Type into a field: {"type":"type","coordinate":[x,y],"text":"text to type","reasoning":"..."} (coordinate clicks the field first)
    - Press a key:       {"type":"key_press","key":"Enter","reasoning":"..."}
    - Scroll the page:   {"type":"scroll","direction":"down","reasoning":"..."}
    - Navigate to URL:   {"type":"navigate","url":"https://...","reasoning":"..."}
    - Wait briefly:      {"type":"wait","reasoning":"..."}`,
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
      reasoning: `[Fallback] ${parsed.reasoning || "flash model decision"}`,
    } as ComputerUseAction;
  };

  if (ctx) {
    return callGeminiWithBackoff(callFn, {
      model: MODELS.flash,
      socket: ctx.socket,
      abortSignal: ctx.abortSignal,
    });
  }
  return withRetry(async () => {
    await waitForRateLimit(MODELS.flash);
    return callFn();
  }, "fallbackDecideAction");
}

// ════════════════════════════════════════════════════════
// Parse Gemini Computer Use response
// Normalizes all known Gemini function call names → our action types
// ════════════════════════════════════════════════════════

/**
 * Maps Gemini's native function call names to our ComputerUseAction types.
 * gemini-2.0-flash emits action-specific function names (e.g. open_web_browser,
 * left_click) rather than a single "computer_use" function with an action arg.
 */
function normalizeFunctionCall(
  name: string,
  args: Record<string, any>,
): {
  type: ComputerUseAction["type"];
  text?: string;
  key?: string;
  url?: string;
  direction?: string;
} {
  switch (name) {
    case "open_web_browser":
    case "navigate":
    case "go_to_url":
      return {
        type: "navigate",
        url: args.url ?? args.uri ?? args.address ?? args.value,
      };
    case "click":
    case "left_click":
    case "click_at":
    case "mouse_click":
    case "mouse_move_and_click":
      return { type: "click" };
    case "type":
    case "type_text":
    case "type_text_at":
    case "keyboard_type":
    case "input_text":
      return { type: "type", text: args.text ?? args.value ?? args.input };
    case "key":
    case "key_press":
    case "keyboard_key":
    case "press_key":
      return { type: "key_press", key: args.key ?? args.value };
    case "scroll":
    case "mouse_scroll":
    case "scroll_page":
      return { type: "scroll", direction: args.direction ?? "down" };
    case "screenshot":
    case "take_screenshot":
      return { type: "screenshot" };
    case "wait":
    case "sleep":
      return { type: "wait" };
    case "drag":
    case "mouse_drag":
      return { type: "drag" };
    default: {
      // computer_use style: args.action holds the sub-type
      const subAction = args.action as string | undefined;
      if (subAction && subAction !== name)
        return normalizeFunctionCall(subAction, args);
      console.warn(
        `[Gemini] Unknown functionCall name: "${name}" — defaulting to click`,
      );
      return { type: "click" };
    }
  }
}

function parseComputerUseResponse(response: any): ComputerUseAction {
  const candidate = response.candidates?.[0];
  if (!candidate?.content?.parts) {
    throw new Error("Empty response from Gemini Computer Use model");
  }

  for (const part of candidate.content.parts) {
    // Native Computer Use function_call
    if (part.functionCall) {
      const args = (part.functionCall.args || {}) as Record<string, any>;
      const normalized = normalizeFunctionCall(part.functionCall.name, args);

      // Gemini may return coordinate as [x,y] array or {x,y} object or separate x/y args
      let coordinate: [number, number] | undefined;
      let coordSource = "none";
      const raw = args.coordinate ?? args.position ?? args.location;
      if (Array.isArray(raw) && raw.length >= 2) {
        coordinate = [Math.round(raw[0]), Math.round(raw[1])];
        coordSource = "coordinate[]";
      } else if (raw?.x !== undefined && raw?.y !== undefined) {
        coordinate = [Math.round(raw.x), Math.round(raw.y)];
        coordSource = "coordinate{x,y}";
      } else if (args.x !== undefined && args.y !== undefined) {
        coordinate = [Math.round(args.x), Math.round(args.y)];
        coordSource = "args.x/y";
      }

      console.log(
        `[Gemini] functionCall: ${part.functionCall.name} → type: ${normalized.type}, coord: [${coordinate}] (source: ${coordSource})`,
      );

      return {
        type: normalized.type,
        coordinate,
        text: normalized.text ?? args.text,
        key: normalized.key ?? args.key,
        url: normalized.url ?? args.url,
        direction: normalized.direction ?? args.direction,
        reasoning: args.reasoning || `Computer Use: ${part.functionCall.name}`,
      } as ComputerUseAction;
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
  ctx?: GeminiCallContext,
): Promise<GeminiVerification> {
  const callFn = async () => {
    console.log(`[Gemini] verifyStep → model: ${MODELS.flash}`);
    const response = await getAI(ctx?.apiKey).models.generateContent({
      model: MODELS.flash,
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
    return callGeminiWithBackoff(callFn, {
      model: MODELS.flash,
      socket: ctx.socket,
      abortSignal: ctx.abortSignal,
    });
  }
  return withRetry(async () => {
    await waitForRateLimit(MODELS.flash);
    return callFn();
  }, "verifyStep");
}

export async function generateNarration(
  action: ComputerUseAction,
  ctx?: GeminiCallContext,
): Promise<string> {
  const desc =
    action.type === "click"
      ? `Clicking at (${action.coordinate?.[0]},${action.coordinate?.[1]})`
      : action.type === "type"
        ? `Typing "${(action.text || "").slice(0, 30)}"`
        : action.type === "scroll"
          ? `Scrolling ${action.direction || "down"}`
          : action.type === "key_press"
            ? `Pressing ${action.key}`
            : action.type === "navigate"
              ? `Navigating to ${action.url}`
              : action.type;

  const callFn = async () => {
    console.log(`[Gemini] generateNarration → model: ${MODELS.lite}`);
    const r = await getAI(ctx?.apiKey).models.generateContent({
      model: MODELS.lite,
      contents: `Write one brief sentence for a QA log. Action: ${desc}. Context: ${action.reasoning || "test step"}. Return ONLY the sentence.`,
    });
    return r.text?.trim() || desc;
  };

  if (ctx) {
    return callGeminiWithBackoff(callFn, {
      model: MODELS.lite,
      socket: ctx.socket,
      abortSignal: ctx.abortSignal,
    });
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
  ctx?: GeminiCallContext,
): Promise<{ title: string; description: string }> {
  const callFn = async () => {
    console.log(`[Gemini] generateBugDescription → model: ${MODELS.flash}`);
    const r = await getAI(ctx?.apiKey).models.generateContent({
      model: MODELS.flash,
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType: "image/jpeg", data: screenshotBase64 } },
            {
              text: `Bug ticket. Step: "${step.text}". Expected: "${step.expectedBehavior}". Finding: "${finding}". Return JSON only: {"title":"...","description":"..."}`,
            },
          ],
        },
      ],
    });
    return JSON.parse(cleanJSON(r.text || ""));
  };

  if (ctx) {
    return callGeminiWithBackoff(callFn, {
      model: MODELS.flash,
      socket: ctx.socket,
      abortSignal: ctx.abortSignal,
    });
  }
  return withRetry(async () => {
    await waitForRateLimit(MODELS.flash);
    return callFn();
  }, "generateBugDescription");
}

// ════════════════════════════════════════════════════════
// SPEC PARSING — Gemini 2.5 Flash Lite (10 RPM)
// Parses a Jira ticket or raw spec text into TestPlan steps
// ════════════════════════════════════════════════════════

export async function generateTestPlan(
  specText: string,
  targetUrl: string,
  apiKey?: string,
): Promise<import("@verifai/types").TestStep[]> {
  const callFn = async () => {
    console.log(`[Gemini] generateTestPlan → model: ${MODELS.pro}`);
    const r = await getAI(apiKey).models.generateContent({
      model: MODELS.pro,
      contents: `You are a QA engineer. Parse this feature specification into a sequential browser test plan.

Spec:
${specText}

Target URL: ${targetUrl}

Return ONLY a JSON array of 5-7 test steps (no markdown fences). Each step object:
{"text":"Imperative action (e.g. Click the Login button)","expectedBehavior":"What should be visible/true after this action","targetElement":"Optional CSS selector or element description"}

Rules:
- First step must navigate to: ${targetUrl}
- Steps must be sequential and each build on the previous
- Focus on the acceptance criteria happy path
- Each step must be atomic and independently verifiable
- Do not include any explanations outside the JSON array`,
    });

    const raw = JSON.parse(cleanJSON(r.text || "[]"));
    return (raw as any[]).map((s: any, i: number) => ({
      id: `s${i + 1}`,
      text: s.text || s.action || "",
      expectedBehavior: s.expectedBehavior || s.expected || "",
      targetElement: s.targetElement,
      status: "pending" as const,
    }));
  };

  return withRetry(async () => {
    await waitForRateLimit(MODELS.pro);
    return callFn();
  }, "generateTestPlan");
}

// async function listModels() {
//   const models = await ai.models.list({ config: { pageSize: 100 } });
//   console.log(models);
// }

// listModels();

// Legacy alias — Phase 3 code may import sendToolResponse
export const sendToolResponse = retryAction;
