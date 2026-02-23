import type { Socket } from "socket.io";
import type {
  TestPlan, TestStep, StepStatus, Bug, IncompleteReason, FailureType,
  ComputerUseAction,
  StepStartEvent, StepResultEvent, ScreenshotEvent,
  NarrationEvent, SessionCompleteEvent,
} from "@verifai/types";
import {
  launchBrowser, navigateTo, takeScreenshot, getCurrentUrl,
  getAOMSnapshot, executeComputerAction, closeBrowser,
  PlaywrightActionError,
} from "../lib/playwright.js";
import {
  decideAction, verifyStep, generateNarration,
  retryAction, fallbackDecideAction,
  type GeminiCallContext,
} from "../lib/gemini.js";
import { GeminiRateLimitError } from "../lib/models.js";

// ─── Helpers ────────────────────────────────────────────

/**
 * Polls skipSignal every 150ms and resolves as soon as the step ID appears.
 * Returns a cancel function to stop polling once the step is done.
 */
function raceSkip(
  skipSignal: Set<string>,
  stepId: string,
): { promise: Promise<{ status: "incomplete" }>, stop: () => void } {
  let stopped = false;
  const promise = new Promise<{ status: "incomplete" }>((resolve) => {
    const poll = () => {
      if (stopped) return;
      if (skipSignal.has(stepId)) {
        resolve({ status: "incomplete" });
        return;
      }
      setTimeout(poll, 150);
    };
    setTimeout(poll, 150);
  });
  return { promise, stop: () => { stopped = true; } };
}

function emitNarration(socket: Socket, text: string) {
  socket.emit("event", {
    type: "narration",
    text,
    timestamp: new Date().toISOString(),
  } as NarrationEvent);
}

function emitScreenshot(socket: Socket, stepId: string, base64: string, url: string) {
  socket.emit("event", {
    type: "screenshot",
    stepId,
    base64,
    url,
  } as ScreenshotEvent);
}

// ─── Step result shape ───────────────────────────────────
type StepResult = {
  status: StepStatus;
  bug?: Bug;
  lastScreenshot?: string;
  failureType?: FailureType;
  incompleteReason?: IncompleteReason;
};

// ─── Main Session Runner ────────────────────────────────

export async function runSession(
  socket: Socket,
  _sessionId: string,
  testPlan: TestPlan,
  targetUrl: string,
  skipSignal?: Set<string>
) {
  const bugs: Bug[] = [];
  const bugScreenshots = new Map<string, string>();
  const actionLog: string[] = [];
  let incompleteCount = 0;

  // Session-level abort token — set to true in the outer finally so any Gemini
  // retry loops still sleeping in the background bail out cleanly instead of
  // making wasted API calls and emitting stale narration after session ends.
  const sessionAbort = { aborted: false };

  const geminiCtx: GeminiCallContext = { socket, abortSignal: sessionAbort };

  try {
    emitNarration(socket, "[INFO] Launching headless browser...");
    await launchBrowser();

    emitNarration(socket, `[INFO] Navigating to ${targetUrl}`);
    await navigateTo(targetUrl);

    const initShot = await takeScreenshot();
    emitScreenshot(socket, "init", initShot, targetUrl);
    emitNarration(socket, "[OK] Target application loaded");

    for (let i = 0; i < testPlan.steps.length; i++) {
      const step = testPlan.steps[i];

      // User-requested skip (before starting the step)
      if (skipSignal?.has(step.id)) {
        skipSignal.delete(step.id);
        socket.emit("event", { type: "step_start", stepId: step.id, stepIndex: i } as StepStartEvent);
        emitNarration(socket, `[INFO] Step ${i + 1}/${testPlan.steps.length}: ${step.text}`);
        emitNarration(socket, `[WARN] Step skipped by user`);
        socket.emit("event", { type: "step_result", stepId: step.id, status: "incomplete" } as StepResultEvent);
        actionLog.push(`Step "${step.text}" → incomplete (user)`);
        incompleteCount++;
        continue;
      }

      socket.emit("event", { type: "step_start", stepId: step.id, stepIndex: i } as StepStartEvent);
      emitNarration(socket, `[INFO] Step ${i + 1}/${testPlan.steps.length}: ${step.text}`);

      // Per-step abort token — set in finally so background vision loop stops ASAP
      const abortToken = { aborted: false };

      const skipRacer = skipSignal ? raceSkip(skipSignal, step.id) : null;
      // Keep a reference to the vision promise so we can attach .catch() to it.
      // This prevents an unhandled rejection warning if the background goroutine
      // eventually throws (e.g. GeminiRateLimitError from the sessionAbort check)
      // after the race has already resolved via skip or timeout.
      const visionPromise = executeStepWithVisionLoop(socket, step, actionLog, geminiCtx, skipSignal, abortToken);
      visionPromise.catch(() => {});
      const raceCandidates: Promise<StepResult | never>[] = [
        visionPromise,
        new Promise<never>((_, rej) =>
          setTimeout(() => rej(new Error("Step timeout (60s)")), 60_000)
        ),
        ...(skipRacer ? [skipRacer.promise] : []),
      ];

      let result: StepResult;

      try {
        result = await Promise.race(raceCandidates);
        if (result.status === "incomplete") {
          emitNarration(socket, `[WARN] Step skipped by user`);
          skipSignal?.delete(step.id);
        }
      } catch (err: any) {
        if (err instanceof GeminiRateLimitError || err.name === "GeminiRateLimitError") {
          result = { status: "incomplete", incompleteReason: "rate_limit" };
          emitNarration(socket, `[WARN] Step incomplete — rate limit exhausted. Retry after the session.`);
        } else {
          // 60s step timeout or unexpected throw — infrastructure failure
          result = {
            status: "incomplete",
            incompleteReason: "crash",
            lastScreenshot: await takeScreenshot().catch(() => ""),
          };
          emitNarration(socket, `[WARN] Step incomplete — agent error: ${err.message}`);
        }
      } finally {
        abortToken.aborted = true;
        skipRacer?.stop();
      }

      if (result.status === "incomplete") incompleteCount++;
      if (result.status === "failed" && result.lastScreenshot) {
        bugScreenshots.set(step.id, result.lastScreenshot);
      }
      if (result.bug) bugs.push(result.bug);

      socket.emit("event", {
        type: "step_result",
        stepId: step.id,
        status: result.status,
        finding: result.bug?.actualBehavior,
        severity: result.bug?.severity,
        failureType: result.failureType,
        incompleteReason: result.incompleteReason,
      } as StepResultEvent);

      actionLog.push(`Step "${step.text}" → ${result.status}`);
    }

  } catch (fatalErr: any) {
    emitNarration(socket, `[ERROR] Fatal session error: ${fatalErr.message}`);
    socket.emit("event", { type: "error", message: fatalErr.message });
  } finally {
    // Signal all background Gemini retry loops that the session is over.
    // Any sleeping retry will bail out after its current sleep completes,
    // without making further API calls or emitting stale narration.
    sessionAbort.aborted = true;
    await closeBrowser().catch(() => {});
  }

  const reportId = `rpt-${Date.now()}`;
  socket.emit("event", { type: "session_complete", reportId } as SessionCompleteEvent);

  let finalNarration: string;
  if (bugs.length > 0 && incompleteCount > 0) {
    finalNarration = `[ERROR] Session complete — ${bugs.length} bug(s) found. ${incompleteCount} step(s) incomplete.`;
  } else if (bugs.length > 0) {
    finalNarration = `[ERROR] Session complete — ${bugs.length} bug(s) found.`;
  } else if (incompleteCount > 0) {
    finalNarration = `[WARN] Session incomplete — ${incompleteCount} step(s) could not run. No bugs in completed steps.`;
  } else {
    finalNarration = `[OK] Session complete — all steps passed, 0 bugs found.`;
  }
  emitNarration(socket, finalNarration);
}

// ─── THE VISION LOOP ────────────────────────────────────
//
// For each test step:
//   1. Screenshot current state
//   2. Send to Gemini vision → get action
//   3. Execute action in browser
//   4. Screenshot again → verify with Gemini
//
// If Gemini throws GeminiRateLimitError, it bubbles up to runSession
// which marks the step as "incomplete" — the session never stalls.
//
// ─────────────────────────────────────────────────────────

async function executeStepWithVisionLoop(
  socket: Socket,
  step: TestStep,
  actionLog: string[],
  ctx: GeminiCallContext,
  skipSignal?: Set<string>,
  abortToken?: { aborted: boolean },
): Promise<StepResult> {

  // Returns true if the outer race already resolved (skip/timeout won) or user manually skipped.
  // When abortToken is set, we return silently — runSession already emitted the narration.
  const checkAbort = (): boolean => {
    if (abortToken?.aborted) return true;
    if (skipSignal?.has(step.id)) {
      skipSignal.delete(step.id);
      emitNarration(socket, `[WARN] Step skipped by user`);
      return true;
    }
    return false;
  };

  const MAX_ACTIONS_PER_STEP = 3;
  let lastScreenshot = "";

  for (let actionNum = 0; actionNum < MAX_ACTIONS_PER_STEP; actionNum++) {

    // Mid-step abort/skip check (top of each action iteration)
    if (checkAbort()) return { status: "incomplete" };

    // ┌──────────────────────────────────────────────┐
    // │ 1. OBSERVE — Screenshot + Accessibility Tree │
    // └──────────────────────────────────────────────┘
    const screenshot = await takeScreenshot();
    lastScreenshot = screenshot;
    const currentUrl = await getCurrentUrl();
    emitScreenshot(socket, step.id, screenshot, currentUrl);

    const aom = await getAOMSnapshot();

    // ┌──────────────────────────────────────────────┐
    // │ 2. THINK — Send to Gemini vision model       │
    // └──────────────────────────────────────────────┘
    let action: ComputerUseAction | undefined;
    try {
      action = await decideAction(screenshot, aom, step, actionLog, ctx);
    } catch (visionErr: any) {
      if (visionErr instanceof GeminiRateLimitError || visionErr.name === "GeminiRateLimitError") {
        emitNarration(socket, `[INFO] Vision model rate limited, trying lite fallback...`);
        action = await fallbackDecideAction(screenshot, aom, step, ctx);
      } else {
        emitNarration(socket, `[INFO] Vision model error, trying fallback...`);
        try {
          action = await fallbackDecideAction(screenshot, aom, step, ctx);
        } catch (fallbackErr: any) {
          // Rate limit on fallback must bubble up so runSession marks step as "incomplete"
          if (fallbackErr instanceof GeminiRateLimitError || fallbackErr.name === "GeminiRateLimitError") {
            throw fallbackErr;
          }
          emitNarration(socket, `[ERROR] All models failed: ${fallbackErr.message}`);
          if (actionNum < MAX_ACTIONS_PER_STEP - 1) continue;
          break;
        }
      }
    }

    if (!action) break;

    // Abort/skip check after decideAction resolves (before touching the browser)
    if (checkAbort()) return { status: "incomplete" };

    // ┌──────────────────────────────────────────────┐
    // │ 2b. Check if step is already done            │
    // └──────────────────────────────────────────────┘
    if (action.type === "screenshot" && action.reasoning?.toLowerCase().includes("complete")) {
      emitNarration(socket, "[INFO] AI sees the expected outcome is already on screen");
      break;
    }

    // ┌──────────────────────────────────────────────┐
    // │ 3. LOG — Tell the frontend what we're doing  │
    // └──────────────────────────────────────────────┘
    const actionDesc = formatAction(action);
    emitNarration(socket, `[INFO] Action: ${actionDesc}`);

    // Fire-and-forget narration (non-critical)
    generateNarration(action, ctx)
      .then((n) => emitNarration(socket, `[INFO] ${n}`))
      .catch(() => {});

    // ┌──────────────────────────────────────────────┐
    // │ 4. ACT — Playwright executes the action      │
    // └──────────────────────────────────────────────┘
    let caughtActionErr: Error | null = null;
    try {
      await executeComputerAction(action);
    } catch (err: any) {
      caughtActionErr = err;
    }

    // ┌──────────────────────────────────────────────┐
    // │ 5. SELF-HEAL — If action failed, retry once  │
    // └──────────────────────────────────────────────┘
    if (caughtActionErr) {
      // Playwright infrastructure failure → skip self-heal, mark incomplete
      if (caughtActionErr instanceof PlaywrightActionError) {
        const isNav = caughtActionErr.isNavigation;
        emitNarration(socket, `[WARN] Step incomplete — ${isNav ? "navigation" : "action"} ${caughtActionErr.incompleteReason}: ${caughtActionErr.message}`);
        return { status: "incomplete", incompleteReason: caughtActionErr.incompleteReason, lastScreenshot };
      }

      // Regular action error (bad coordinates, element issue) → try self-heal
      emitNarration(socket, `[ERROR] Action failed: ${caughtActionErr.message}`);

      if (actionNum < MAX_ACTIONS_PER_STEP - 1) {
        emitNarration(socket, "[INFO] Attempting self-heal...");

        const healShot = await takeScreenshot();
        emitScreenshot(socket, step.id, healShot, await getCurrentUrl());
        const healAom = await getAOMSnapshot();

        try {
          const healAction = await retryAction(caughtActionErr.message, healShot, healAom, step, ctx);
          await executeComputerAction(healAction);
          emitNarration(socket, "[OK] Recovered with new approach");
          actionLog.push(`Self-healed: ${formatAction(healAction)}`);
          await new Promise((r) => setTimeout(r, 500));
          break;
        } catch (healErr: any) {
          if (healErr instanceof GeminiRateLimitError || healErr.name === "GeminiRateLimitError") {
            throw healErr;
          }
          if (healErr instanceof PlaywrightActionError) {
            emitNarration(socket, `[WARN] Self-heal hit infrastructure error: ${healErr.message}`);
            return { status: "incomplete", incompleteReason: healErr.incompleteReason, lastScreenshot };
          }
          emitNarration(socket, `[ERROR] Self-heal failed: ${healErr.message}`);
        }
      }
    } else {
      actionLog.push(actionDesc);
      await new Promise((r) => setTimeout(r, 500));
      break;
    }
  }

  // Abort/skip check after action loop (before slow verifyStep call)
  if (checkAbort()) return { status: "incomplete" };

  // ┌──────────────────────────────────────────────────┐
  // │ 6. VERIFY — Take final screenshot, ask Gemini   │
  // └──────────────────────────────────────────────────┘
  await new Promise((r) => setTimeout(r, 500));
  const verifyShot = await takeScreenshot();
  lastScreenshot = verifyShot;
  emitScreenshot(socket, step.id, verifyShot, await getCurrentUrl());

  try {
    const v = await verifyStep(verifyShot, step.expectedBehavior, ctx);

    // Abort/skip check after verifyStep resolves
    if (checkAbort()) return { status: "incomplete" };

    if (v.passed) {
      emitNarration(socket, `[OK] Step passed: ${v.finding}`);
      return { status: "passed", lastScreenshot };
    } else {
      emitNarration(socket, `[ERROR] Verification failed: ${v.finding}`);
      return {
        status: "failed",
        failureType: "assertion",
        lastScreenshot,
        bug: {
          id: `bug-${Date.now()}`,
          stepId: step.id,
          title: `Failed: ${step.text}`,
          description: v.finding,
          severity: v.severity || "medium",
          screenshotUrl: "",
          expectedBehavior: step.expectedBehavior,
          actualBehavior: v.finding,
          failureType: "assertion",
        },
      };
    }
  } catch (verifyErr: any) {
    if (verifyErr instanceof GeminiRateLimitError || verifyErr.name === "GeminiRateLimitError") {
      throw verifyErr;
    }
    emitNarration(socket, `[ERROR] Verification error: ${verifyErr.message}`);
    return {
      status: "failed",
      failureType: "assertion",
      lastScreenshot,
      bug: {
        id: `bug-${Date.now()}`,
        stepId: step.id,
        title: `Unverified: ${step.text}`,
        description: `Verification model error: ${verifyErr.message}`,
        severity: "medium",
        screenshotUrl: "",
        expectedBehavior: step.expectedBehavior,
        actualBehavior: "Verification failed — model error",
        failureType: "assertion",
      },
    };
  }
}

// ─── Format action for logging ──────────────────────────

function formatAction(action: ComputerUseAction): string {
  const parts: string[] = [action.type];
  if (action.coordinate) parts.push(`at (${action.coordinate[0]},${action.coordinate[1]})`);
  if (action.text) parts.push(`"${action.text.slice(0, 30)}"`);
  if (action.key) parts.push(action.key);
  if (action.direction) parts.push(action.direction);
  if (action.url) parts.push(action.url);
  return parts.join(" ");
}
