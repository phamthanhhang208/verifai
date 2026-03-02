import type { Request, Response } from "express";
import type { TestPlan } from "@verifai/types";
import { fetchTicket } from "../lib/jira.js";
import { generateTestPlan } from "../lib/gemini.js";

const JIRA_TICKET_RE = /^[A-Z]+-\d+$/;
const JIRA_CONFIGURED = !!(
  process.env.JIRA_BASE_URL &&
  process.env.JIRA_EMAIL &&
  process.env.JIRA_API_TOKEN
);

export async function handleGeneratePlan(req: Request, res: Response): Promise<void> {
  const { source, targetUrl, geminiApiKey, sourceType } = req.body as {
    source?: string;
    targetUrl?: string;
    geminiApiKey?: string;
    sourceType?: "jira" | "confluence" | "manual";
  };

  if (!source?.trim() || !targetUrl?.trim()) {
    res.status(400).json({ error: "source and targetUrl are required" });
    return;
  }

  const sourceTrimmed = source.trim();
  const urlTrimmed = targetUrl.trim();

  try {
    let specText = sourceTrimmed;
    let ticketKey = sourceTrimmed;

    // Fetch from Jira if source looks like a ticket ID and credentials are set
    if (JIRA_TICKET_RE.test(sourceTrimmed) && JIRA_CONFIGURED) {
      try {
        const ticket = await fetchTicket(sourceTrimmed);
        specText = [
          `Summary: ${ticket.summary}`,
          ticket.description ? `Description: ${ticket.description}` : "",
          ticket.acceptanceCriteria ? `Acceptance Criteria: ${ticket.acceptanceCriteria}` : "",
        ]
          .filter(Boolean)
          .join("\n\n");
        ticketKey = ticket.key;
        console.log(`[Plan] Fetched Jira ticket: ${ticketKey}`);
      } catch (err) {
        console.warn(`[Plan] Jira fetch failed, using raw source as spec:`, err);
        // Fall through — treat source as raw spec text
      }
    }

    // Prepend source-aware context hint for Gemini
    if (sourceType === "confluence") {
      specText = `[This is Confluence documentation describing the application's user flows, features, and acceptance criteria. Identify the PRIMARY user flow and generate test steps that follow it end-to-end. Look for: acceptance criteria, user stories, step-by-step instructions, feature descriptions, and expected behaviors.]\n\n${specText}`;
    } else if (sourceType === "manual") {
      specText = `[This is a manual test specification provided by a QA engineer. Generate test steps based on the described scenario.]\n\n${specText}`;
    }

    console.log(`[Plan] Generating test plan for: ${urlTrimmed} (source: ${sourceType || "auto"})`);
    console.log(`[Plan] Spec text (${specText.length} chars):\n${specText.slice(0, 500)}`);
    const steps = await generateTestPlan(specText, urlTrimmed, geminiApiKey || undefined);

    const plan: TestPlan = {
      id: `plan-${Date.now()}`,
      sourceTicket: ticketKey,
      targetUrl: urlTrimmed,
      steps,
      createdAt: new Date().toISOString(),
    };

    console.log(`[Plan] Generated ${steps.length} steps for ${ticketKey}`);
    res.json(plan);
  } catch (err: any) {
    console.error("[Plan] Generation failed:", err);
    res.status(500).json({ error: err.message || "Failed to generate test plan" });
  }
}
