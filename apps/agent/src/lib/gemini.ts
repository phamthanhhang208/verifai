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
  getNextTtsModel,
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
  confidence: z.number().min(0).max(1).optional(),
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

    const requestBody = {
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
      - Be precise with pixel coordinates — cross-reference the screenshot with the accessibility tree coordinates

      After deciding the action, also assess your CONFIDENCE (0.0 to 1.0):
      - 1.0 = Absolutely certain this is the right element and action
      - 0.7+ = Reasonably confident, standard UI interaction
      - 0.4-0.7 = Uncertain — multiple possible targets or ambiguous UI
      - Below 0.4 = Very unsure — unfamiliar page state, no clear match

      If you respond with text (not a tool call), include a JSON field "confidence" in your response.`,
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
    };
    // @ts-expect-error: Weird querk of GoogleGenAI
    const response = await getAI(ctx?.apiKey).models.generateContent(requestBody);

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
- NEVER change the input data, credentials, usernames, passwords, or any test values specified in the task — use EXACTLY what the task says
- Do NOT try to work around errors by using different values — if the task says to use "locked_out_user", you MUST use "locked_out_user" even if it causes an error
- If an error appears on screen and the EXPECTED OUTCOME describes that error, respond with text "STEP_COMPLETE" — the error IS the expected result
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

Look at the screenshot carefully. Try a DIFFERENT coordinate or element target — use the @(x,y) coordinates from the accessibility tree for precise targeting.
IMPORTANT: Do NOT change any test data, credentials, usernames, or input values — only fix the targeting (which element to click/type into). Stick to exactly what the task says.
Viewport is 1280×720. Use the computer_use tool.`,
            },
          ],
        },
      ],
      config: {
        tools: [
          {
            computerUse: {
              //environment: Environment.ENVIRONMENT_BROWSER
              // @ts-expect-error: Weird querk of GoogleGenAI
              environment: "ENVIRONMENT_BROWSER",
            }
          },
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
        confidence: args.confidence ?? 0.8,
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
          confidence: p.confidence ?? 0.8,
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
              text: `QA verification. Carefully examine this screenshot. Did the expected behavior happen?

Expected: ${expectedBehavior}

VERIFICATION CHECKLIST — check ALL of these:
1. Is the expected content visible on screen?
2. Are all images loading correctly? Look for: broken images, placeholder images, or images that don't match their labels (e.g. a dog photo for a "Backpack" product is a bug)
3. Are images UNIQUE where they should be? If multiple different items all show the SAME image, that is a bug
4. Do text labels, names, and prices look correct and match what you'd expect?
5. Are there any error messages, broken layouts, or visual glitches?

Password fields showing masked characters (dots/asterisks) is NORMAL — not a bug.

Be STRICT: if the expected behavior says "correct images" and the images are wrong, duplicated, or don't match their product names, that is a FAILURE.

Also rate your confidence in this verification (0.0 to 1.0):
- 1.0 = Crystal clear, unmistakable result
- 0.7+ = Fairly certain based on what's visible
- Below 0.7 = Hard to tell, ambiguous visual state

Return ONLY JSON, no markdown: {"passed":true/false,"finding":"what you see — be specific about what's wrong","severity":"high"|"medium"|"low","confidence":0.9}
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
      contents: `You are a senior QA engineer. You are given a REAL Jira ticket. Convert it into a complete browser test plan.

═══ JIRA TICKET ═══
${specText}
═══ END TICKET ═══

Target URL: ${targetUrl}

TICKET TEMPLATE — the ticket typically follows this structure:
- Title: feature name
- Description: user story ("As a [user] I want to [action] so that [outcome]")
- Target Application: the URL to test
- Test Account: username / password for login (USE THESE EXACT CREDENTIALS)
- Acceptance Criteria: a list of expected behaviors that MUST ALL be tested

YOUR TASK:
1. Parse the acceptance criteria list from the ticket
2. Create test steps that cover EVERY SINGLE acceptance criterion
3. Combine sequential interactions into a single logical step where possible
4. Group related steps with proper dependencies

Return ONLY a JSON array (no markdown fences). Each step object:
{"id":"s1","text":"Imperative browser action","expectedBehavior":"What should be visible after","targetElement":"Optional CSS selector","dependsOn":["s0"]}

STEP ID FORMAT: "s1", "s2", "s3", etc.

DEPENDENCY RULES (dependsOn field):
- Each step lists the step IDs it depends on
- If a dependency fails, this step is automatically SKIPPED
- First step (navigate) has no dependencies: "dependsOn": []
- Steps that require login should depend on the login step
- Independent acceptance criteria should NOT depend on each other — only on shared prerequisites (like login)
- This lets the test runner skip impossible steps but still test independent criteria

CRITICAL RULES:
- First step must navigate to: ${targetUrl}
- Maximum 10 steps per test plan
- Each step should cover a logical action + verification together, not individual keystrokes
- One user account per test plan — do not mix multiple users
- Combine sequential form inputs into a single step
- Focus only on the Acceptance Criteria of the ticket provided, not every possible edge case
- Each step should take no more than 30 seconds to execute
- If the ticket has a Test Account, use THOSE EXACT credentials — do NOT substitute different ones
- Use the EXACT field names, button labels, and values from the ticket
- Do not include any explanations outside the JSON array`,
    });

    const raw = JSON.parse(cleanJSON(r.text || "[]"));
    return (raw as any[]).map((s: any, i: number) => ({
      id: s.id || `s${i + 1}`,
      text: s.text || s.action || "",
      expectedBehavior: s.expectedBehavior || s.expected || "",
      targetElement: s.targetElement,
      dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn : undefined,
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

// ════════════════════════════════════════════════════════
// TTS MODEL — Gemini 2.5 Flash TTS (3 RPM)
// Generates voice narration for key QA moments.
// Fire-and-forget — failures are non-critical.
// ════════════════════════════════════════════════════════

/**
 * Generate voice narration using Gemini 2.5 Flash TTS.
 * Returns base64-encoded audio. Fire-and-forget — failures are non-critical.
 *
 * Rate limit: 3 RPM — only narrate key moments, not every action.
 */
export async function generateVoiceNarration(
  text: string,
  ctx?: GeminiCallContext,
): Promise<{ audio: string; mimeType: string } | null> {
  // Skip if TTS not desired or text is too short
  if (!text || text.length < 10) return null;

  try {
    const ttsModel = getNextTtsModel();
    const callFn = async () => {
      //await waitForRateLimit(MODELS.tts);

      const response = await getAI(ctx?.apiKey).models.generateContent({
        model: ttsModel,

        contents: [
          {
            role: "user",
            //parts: [{ text: 'Say cheerfully: Have a wonderful day!' }]

            parts: [
              {
                text: `You are the voice of a professional QA testing agent called Verifai. 
            Speak this narration clearly and concisely in a calm, confident, technical tone. 
            Keep it brief — one or two sentences max.

            Narrate: "${text}"`,
              },
            ],
          },
        ],
        config: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: "Kore",
              },
            },
          },
        },
      });

      // Extract audio from response
      const candidate = response.candidates?.[0];
      if (!candidate?.content?.parts) return null;

      for (const part of candidate.content.parts) {
        if (part.inlineData?.mimeType?.startsWith("audio/")) {
          console.log(`[TTS] Generated audio: ${part?.inlineData?.data?.length} bytes, type ${part.inlineData.mimeType}`);
          return {
            audio: part.inlineData.data!, // base64
            mimeType: part.inlineData.mimeType,
          };
        }
      }

      return null;
    };

    if (ctx) {
      return await callGeminiWithBackoff(callFn, {
        model: ttsModel,
        socket: ctx.socket,
        abortSignal: ctx.abortSignal,
      });
    }
    return await callFn();
  } catch (err: any) {
    // TTS is non-critical — log and return null
    console.warn(`[TTS] Voice generation failed: ${err.message}`);
    return null;
  }
}

// Legacy alias — Phase 3 code may import sendToolResponse
export const sendToolResponse = retryAction;
