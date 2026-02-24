import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import type { Bug, BugReport, FailureType, ReportStatus, TestPlan } from "@verifai/types";
import { uploadScreenshot } from "./gcs.js";
import { createBugTicket } from "./jira.js";
import { generateBugDescription } from "./gemini.js";

// Initialize Firebase Admin (safe to call multiple times)
if (getApps().length === 0) {
  initializeApp({ projectId: process.env.GCP_PROJECT_ID });
}

const db = getFirestore();
const COLLECTION = process.env.FIRESTORE_COLLECTION || "reports";

// ─── Report Compilation ──────────────────────────────────

export function compileReport(
  sessionId: string,
  testPlan: TestPlan,
  bugs: Bug[],
  startedAt: string
): BugReport {
  const totalSteps = testPlan.steps.length;
  const passedSteps = testPlan.steps.filter((s) => s.status === "passed").length;
  const failedSteps = testPlan.steps.filter((s) => s.status === "failed").length;
  const incompleteSteps = testPlan.steps.filter((s) => s.status === "incomplete").length;
  const completedSteps = passedSteps + failedSteps;

  // Only assertion and timeout failures appear in the bug report
  const reportableBugs = bugs.filter(
    (b) => !b.failureType || b.failureType === "assertion" || b.failureType === "timeout"
  );

  const passRate = completedSteps > 0 ? (passedSteps / completedSteps) * 100 : 100;

  const reportStatus = deriveReportStatus(failedSteps, incompleteSteps);
  const summary = buildSummary(reportStatus, passedSteps, failedSteps, incompleteSteps, totalSteps);

  return {
    id: sessionId,
    testPlanId: testPlan.id,
    sourceTicket: testPlan.sourceTicket,
    targetUrl: testPlan.targetUrl,
    steps: testPlan.steps,
    bugs: reportableBugs,
    reportStatus,
    totalSteps,
    passedSteps,
    failedSteps,
    completedSteps,
    incompleteSteps,
    passRate,
    summary,
    createdAt: startedAt,
    completedAt: new Date().toISOString(),
  };
}

function deriveReportStatus(failedSteps: number, incompleteSteps: number): ReportStatus {
  if (failedSteps > 0) return "failed";       // bugs found (may also have incomplete)
  if (incompleteSteps > 0) return "incomplete"; // no bugs but some steps couldn't run
  return "passed";
}

function buildSummary(
  status: ReportStatus,
  passed: number,
  failed: number,
  incomplete: number,
  total: number
): string {
  switch (status) {
    case "passed":
      return `[OK] All ${total} steps passed. 0 bugs found.`;

    case "failed":
      if (incomplete > 0) {
        return `[ERROR] Found ${failed} bug(s). ${incomplete} step(s) skipped due to infrastructure errors.`;
      }
      return `[ERROR] Found ${failed} bug(s) across ${total} steps.`;

    case "incomplete":
      return `[WARN] Session incomplete — ${incomplete} step(s) skipped. No bugs detected in completed steps.`;
  }
}

// ─── Full report pipeline ────────────────────────────────

/**
 * Full report pipeline:
 * 1. Upload bug screenshots to GCS
 * 2. Enrich bug descriptions with Gemini
 * 3. Create Jira tickets for each bug
 * 4. Compile the BugReport (using existing compileReport)
 * 5. Save to Firestore
 *
 * Every step is wrapped in try/catch — partial failures don't block the report.
 */
export async function compileAndSaveReport(
  sessionId: string,
  testPlan: TestPlan,
  bugs: Bug[],
  bugScreenshots: Map<string, string>,
  startedAt: string
): Promise<string> {
  // 1. Upload screenshots + enrich bug descriptions + create Jira tickets
  for (const bug of bugs) {
    const screenshotBase64 = bugScreenshots.get(bug.stepId);

    if (screenshotBase64) {
      // Upload screenshot to GCS
      try {
        bug.screenshotUrl = await uploadScreenshot(screenshotBase64, sessionId, bug.stepId);
        console.log(`[Report] Screenshot uploaded for ${bug.stepId}`);
      } catch (err) {
        console.error(`[Report] GCS upload failed for ${bug.stepId}:`, err);
      }

      // Enrich bug description with Gemini vision
      try {
        const step = testPlan.steps.find((s) => s.id === bug.stepId);
        if (step) {
          const generated = await generateBugDescription(step, bug.description, screenshotBase64);
          bug.title = generated.title;
          bug.description = generated.description;
        }
      } catch (err) {
        console.error(`[Report] Bug description enrichment failed:`, err);
      }
    }

    // Create Jira ticket
    try {
      const jiraResult = await createBugTicket(bug, testPlan.sourceTicket);
      bug.jiraTicketKey = jiraResult.key;
      bug.jiraTicketUrl = jiraResult.url;
      console.log(`[Report] Jira ticket created: ${jiraResult.key}`);
    } catch (err) {
      console.error(`[Report] Jira ticket failed for ${bug.id}:`, err);
    }
  }

  // 2. Compile the report
  const report = compileReport(sessionId, testPlan, bugs, startedAt);

  // 3. Save to Firestore
  try {
    await db.collection(COLLECTION).doc(report.id).set(report);
    console.log(`[Report] Saved to Firestore: ${report.id}`);
  } catch (err) {
    console.error(`[Report] Firestore save failed:`, err);
  }

  return report.id;
}

/**
 * Fetch a report from Firestore by ID
 */
export async function fetchReport(reportId: string): Promise<BugReport | null> {
  try {
    const doc = await db.collection(COLLECTION).doc(reportId).get();
    if (!doc.exists) return null;
    return doc.data() as BugReport;
  } catch (err) {
    console.error(`[Report] Fetch failed:`, err);
    return null;
  }
}

// ─── Group bugs by failure type ──────────────────────────

export function groupBugsByFailureType(bugs: Bug[]): Record<FailureType, Bug[]> {
  const groups: Record<FailureType, Bug[]> = { assertion: [], timeout: [] };
  for (const bug of bugs) {
    const type = bug.failureType ?? "assertion";
    groups[type].push(bug);
  }
  return groups;
}
