import type { Bug, BugReport, FailureType, ReportStatus, TestPlan } from "@verifai/types";

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

// ─── Group bugs by failure type ──────────────────────────

export function groupBugsByFailureType(bugs: Bug[]): Record<FailureType, Bug[]> {
  const groups: Record<FailureType, Bug[]> = { assertion: [], timeout: [] };
  for (const bug of bugs) {
    const type = bug.failureType ?? "assertion";
    groups[type].push(bug);
  }
  return groups;
}
