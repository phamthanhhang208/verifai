import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import type { GeminiAction, GeminiVerification, TestStep } from "@verifai/types";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
const MODEL = "gemini-2.5-flash";

const ActionSchema = z.object({
  action: z.enum(["click", "type", "navigate", "scroll", "wait", "assert"]),
  selector: z.string().optional(),
  value: z.string().optional(),
  reasoning: z.string(),
});

const VerificationSchema = z.object({
  passed: z.boolean(),
  finding: z.string(),
  severity: z.enum(["high", "medium", "low"]).optional(),
});

function parseJSON<T>(text: string, schema: z.ZodSchema<T>): T {
  const cleaned = text.replace(/^```json?\n?/, "").replace(/\n?```$/, "").trim();
  return schema.parse(JSON.parse(cleaned));
}

export async function decideAction(
  screenshotBase64: string,
  aomSnapshot: string,
  step: TestStep
): Promise<GeminiAction> {
  const response = await ai.models.generateContent({
    model: MODEL,
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
            text: `You are a browser automation agent. Given the current screenshot and accessibility tree, decide the next action to accomplish this step.

Step: ${step.text}
Expected behavior: ${step.expectedBehavior}
${step.targetElement ? `Suggested selector: ${step.targetElement}` : ""}

Accessibility tree (AOM snapshot):
${aomSnapshot.slice(0, 4000)}

Return a JSON object with:
{
  "action": "click" | "type" | "navigate" | "scroll" | "wait" | "assert",
  "selector": "CSS selector for the target element (required for click/type)",
  "value": "text to type, URL to navigate to, or scroll direction",
  "reasoning": "Brief explanation of why this action"
}

Return ONLY valid JSON, no markdown fences.`,
          },
        ],
      },
    ],
  });

  return parseJSON(response.text ?? "", ActionSchema);
}

export async function sendToolResponse(
  errorString: string,
  screenshotBase64: string,
  aomSnapshot: string,
  step: TestStep
): Promise<GeminiAction> {
  const response = await ai.models.generateContent({
    model: MODEL,
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
            text: `You are a browser automation agent. Your previous action FAILED with this error:

Error: ${errorString}

Step to accomplish: ${step.text}
Expected behavior: ${step.expectedBehavior}

Current accessibility tree:
${aomSnapshot.slice(0, 4000)}

The previous selector may have been wrong. Look at the current screenshot and accessibility tree carefully. Try a different approach — use a different selector, or try a different action type.

Return a JSON object:
{
  "action": "click" | "type" | "navigate" | "scroll" | "wait" | "assert",
  "selector": "CSS selector (try a different one from before)",
  "value": "text/URL/direction if needed",
  "reasoning": "What went wrong and what you are trying differently"
}

Return ONLY valid JSON, no markdown fences.`,
          },
        ],
      },
    ],
  });

  return parseJSON(response.text ?? "", ActionSchema);
}

export async function verifyStep(
  screenshotBase64: string,
  expectedBehavior: string
): Promise<GeminiVerification> {
  const response = await ai.models.generateContent({
    model: MODEL,
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
            text: `You are a QA verification agent. Look at this screenshot and determine if the expected behavior was achieved.

Expected behavior: ${expectedBehavior}

Return a JSON object:
{
  "passed": true or false,
  "finding": "Brief description of what you observe",
  "severity": "high" | "medium" | "low" (only required when passed is false)
}

Return ONLY valid JSON, no markdown fences.`,
          },
        ],
      },
    ],
  });

  return parseJSON(response.text ?? "", VerificationSchema);
}

export async function generateNarration(action: GeminiAction): Promise<string> {
  const response = await ai.models.generateContent({
    model: MODEL,
    contents: `Generate a very brief, single-sentence narration of this browser action for a live QA session log. Be concise and technical.
Action: ${action.action}
Target: ${action.selector || "page"}
Value: ${action.value || "none"}
Reasoning: ${action.reasoning}

Return only the narration sentence, no quotes, no punctuation at start.`,
  });

  return (
    response.text?.trim() ||
    `Performing ${action.action} on ${action.selector || "page"}`
  );
}

export async function generateBugDescription(
  step: TestStep,
  finding: string,
  screenshotBase64: string
): Promise<{ title: string; description: string }> {
  const response = await ai.models.generateContent({
    model: MODEL,
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
            text: `You are a QA engineer writing a bug ticket. Given this failed test step and screenshot, write a clear bug title and description.

Step: ${step.text}
Expected: ${step.expectedBehavior}
Finding: ${finding}

Return a JSON object:
{
  "title": "Clear, concise bug title (max 80 chars)",
  "description": "Detailed bug description covering: what was tested, expected vs actual behavior, steps to reproduce"
}

Return ONLY valid JSON, no markdown fences.`,
          },
        ],
      },
    ],
  });

  const text = (response.text ?? "").replace(/^```json?\n?/, "").replace(/\n?```$/, "").trim();
  const parsed = JSON.parse(text);
  return { title: parsed.title, description: parsed.description };
}
