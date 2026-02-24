import type { Socket } from "socket.io";
import type {
  TestPlan,
  TestStep,
  StepStatus,
  Bug,
  IncompleteReason,
  FailureType,
  ComputerUseAction,
  StepStartEvent,
  StepResultEvent,
  ScreenshotEvent,
  NarrationEvent,
  SessionCompleteEvent,
  SessionAbortedEvent,
} from "@verifai/types";
import {
  launchBrowser,
  navigateTo,
  takeScreenshot,
  getCurrentUrl,
  getAOMSnapshot,
  executeComputerAction,
  closeBrowser,
  PlaywrightActionError,
} from "../lib/playwright.js";
import {
  decideAction,
  escalatedDecideAction,
  verifyStep,
  generateNarration,
  retryAction,
  fallbackDecideAction,
  type GeminiCallContext,
} from "../lib/gemini.js";
import { GeminiRateLimitError, MODELS } from "../lib/models.js";
import { compileAndSaveReport } from "../lib/report.js";
import {
  DEMO_FALLBACK_ENABLED,
  demoStepResults,
} from "../lib/demo-fallback.js";

// ─── Helpers ────────────────────────────────────────────

/**
 * Polls skipSignal every 150ms and resolves as soon as the step ID appears.
 * Returns a cancel function to stop polling once the step is done.
 */
function raceSkip(
  skipSignal: Set<string>,
  stepId: string,
): { promise: Promise<{ status: "incomplete" }>; stop: () => void } {
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
  return {
    promise,
    stop: () => {
      stopped = true;
    },
  };
}

function emitNarration(socket: Socket, text: string) {
  socket.emit("event", {
    type: "narration",
    text,
    timestamp: new Date().toISOString(),
  } as NarrationEvent);
}

function emitScreenshot(
  socket: Socket,
  stepId: string,
  base64: string,
  url: string,
) {
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
  skipSignal?: Set<string>,
  geminiApiKey?: string,
  pauseSignal?: { paused: boolean },
  externalAbort?: { aborted: boolean },
) {
  const bugs: Bug[] = [];
  const bugScreenshots = new Map<string, string>();
  const actionLog: string[] = [];
  let incompleteCount = 0;

  // Use the caller-supplied abort token if provided, otherwise create one locally.
  // This lets index.ts trigger an abort (for reset) from outside the session.
  const sessionAbort = externalAbort ?? { aborted: false };

  const geminiCtx: GeminiCallContext = {
    socket,
    abortSignal: sessionAbort,
    apiKey: geminiApiKey,
  };
  const startedAt = new Date().toISOString();

  // ── Demo mode — skip real browser/Gemini calls ──────────

  // Tracks whether the fallback model should be tried first.
  // Flipped to true when vision fails and fallback succeeds; reset to false
  // if vision later recovers so we don't permanently downgrade.
  const modelState = { useFallback: false, escalated: false };

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
        socket.emit("event", {
          type: "step_start",
          stepId: step.id,
          stepIndex: i,
        } as StepStartEvent);
        emitNarration(
          socket,
          `[INFO] Step ${i + 1}/${testPlan.steps.length}: ${step.text}`,
        );
        emitNarration(socket, `[WARN] Step skipped by user`);
        socket.emit("event", {
          type: "step_result",
          stepId: step.id,
          status: "incomplete",
        } as StepResultEvent);
        actionLog.push(`Step "${step.text}" → incomplete (user)`);
        incompleteCount++;
        continue;
      }

      socket.emit("event", {
        type: "step_start",
        stepId: step.id,
        stepIndex: i,
      } as StepStartEvent);
      emitNarration(
        socket,
        `[INFO] Step ${i + 1}/${testPlan.steps.length}: ${step.text}`,
      );

      // Per-step abort token — set in finally so background vision loop stops ASAP
      const abortToken = { aborted: false };

      const skipRacer = skipSignal ? raceSkip(skipSignal, step.id) : null;
      // Keep a reference to the vision promise so we can attach .catch() to it.
      // This prevents an unhandled rejection warning if the background goroutine
      // eventually throws (e.g. GeminiRateLimitError from the sessionAbort check)
      // after the race has already resolved via skip or timeout.
      const visionPromise = executeStepWithVisionLoop(
        socket,
        step,
        actionLog,
        geminiCtx,
        modelState,
        skipSignal,
        abortToken,
      );
      visionPromise.catch(() => { });
      const raceCandidates: Promise<StepResult | never>[] = [
        visionPromise,
        new Promise<never>((_, rej) =>
          setTimeout(() => rej(new Error("Step timeout (120s)")), 120_000),
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
        if (
          err instanceof GeminiRateLimitError ||
          err.name === "GeminiRateLimitError"
        ) {
          result = { status: "incomplete", incompleteReason: "rate_limit" };
          emitNarration(
            socket,
            `[WARN] Step incomplete — rate limit exhausted. Retry after the session.`,
          );
        } else {
          // 60s step timeout or unexpected throw — infrastructure failure
          result = {
            status: "incomplete",
            incompleteReason: "crash",
            lastScreenshot: await takeScreenshot().catch(() => ""),
          };
          emitNarration(
            socket,
            `[WARN] Step incomplete — agent error: ${err.message}`,
          );
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

      // Pause between steps — waits here until resumed or aborted
      await waitWhilePaused(pauseSignal, sessionAbort);
      if (sessionAbort.aborted) break;
    }
  } catch (fatalErr: any) {
    emitNarration(socket, `[ERROR] Fatal session error: ${fatalErr.message}`);
    socket.emit("event", { type: "error", message: fatalErr.message });
  } finally {
    // Signal all background Gemini retry loops that the session is over.
    // Any sleeping retry will bail out after its current sleep completes,
    // without making further API calls or emitting stale narration.
    const wasAbortedByUser = sessionAbort.aborted;
    sessionAbort.aborted = true;
    await closeBrowser().catch(() => { });

    // Only treat as "aborted" if the user explicitly requested abort.
    // Normal loop completion also sets sessionAbort.aborted = true (above)
    // but should NOT skip report generation.
    if (wasAbortedByUser) {
      emitNarration(socket, "[INFO] Session aborted — test plan reset");
      socket.emit("event", { type: "session_aborted" } as SessionAbortedEvent);
      return;
    }
  }

  // ── Phase 6: Compile report, upload screenshots, create Jira tickets ──
  let reportId = `rpt-${Date.now()}`;

  emitNarration(socket, "[INFO] Compiling report...");

  try {
    reportId = await compileAndSaveReport(
      _sessionId,
      testPlan,
      bugs,
      bugScreenshots,
      startedAt,
    );

    const jiraCount = bugs.filter((b) => b.jiraTicketKey).length;
    const gcsCount = bugs.filter((b) => b.screenshotUrl).length;

    if (bugs.length > 0) {
      emitNarration(
        socket,
        `[OK] Report saved. ${jiraCount}/${bugs.length} Jira ticket(s) created. ${gcsCount} screenshot(s) uploaded.`,
      );
    } else {
      emitNarration(socket, `[OK] Report saved to Firestore.`);
    }
  } catch (err: any) {
    console.error("[Report] Pipeline failed:", err);
    emitNarration(
      socket,
      `[WARN] Report compilation had errors: ${err.message}. Using local report.`,
    );
  }

  socket.emit("event", {
    type: "session_complete",
    reportId,
  } as SessionCompleteEvent);

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

// ─── Pause helper ───────────────────────────────────────
// Polls every 200ms while the session is paused. Returns immediately if
// the abort signal fires so a pending pause doesn't block a clean shutdown.

async function waitWhilePaused(
  pauseSignal: { paused: boolean } | undefined,
  abortSignal: { aborted: boolean },
): Promise<void> {
  while (pauseSignal?.paused && !abortSignal.aborted) {
    await new Promise((r) => setTimeout(r, 200));
  }
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
  modelState: { useFallback: boolean; escalated: boolean },
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

  const MAX_ACTIONS_PER_STEP = 7;
  let lastScreenshot = "";

  console.log(`\n${"─".repeat(60)}`);
  console.log(`[Step ${step.id}] "${step.text}"`);
  console.log(`[Step ${step.id}] Expected: "${step.expectedBehavior}"`);
  console.log(`${"─".repeat(60)}`);

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

    if (modelState.escalated) {
      // Vision model was confused (premature STEP_COMPLETE) — use pro model
      try {
        action = await escalatedDecideAction(screenshot, aom, step, actionLog, ctx);
        console.log(`[Step ${step.id}] escalated pro model responded`);
      } catch (proErr: any) {
        if (proErr instanceof GeminiRateLimitError || proErr.name === "GeminiRateLimitError") {
          throw proErr;
        }
        emitNarration(socket, `[WARN] Pro model error: ${proErr?.message?.slice(0, 80) ?? "unknown"}. Falling back to vision...`);
        modelState.escalated = false;
        try {
          action = await decideAction(screenshot, aom, step, actionLog, ctx);
        } catch {
          if (actionNum < MAX_ACTIONS_PER_STEP - 1) continue;
          break;
        }
      }
    } else if (modelState.useFallback) {
      // Previous step required fallback — start there to avoid wasting vision quota
      try {
        action = await fallbackDecideAction(screenshot, aom, step, ctx);
      } catch (fallbackErr: any) {
        if (
          fallbackErr instanceof GeminiRateLimitError ||
          fallbackErr.name === "GeminiRateLimitError"
        ) {
          throw fallbackErr;
        }
        // Fallback also broken — try vision as last resort
        emitNarration(socket, `[WARN] Fallback model error, retrying with vision...`);
        try {
          action = await decideAction(screenshot, aom, step, actionLog, ctx);
          modelState.useFallback = false; // Vision is healthy again
        } catch {
          emitNarration(socket, `[ERROR] All models failed`);
          if (actionNum < MAX_ACTIONS_PER_STEP - 1) continue;
          break;
        }
      }
    } else {
      // Normal path — try vision first
      try {
        action = await decideAction(screenshot, aom, step, actionLog, ctx);
      } catch (visionErr: any) {
        if (
          visionErr instanceof GeminiRateLimitError ||
          visionErr.name === "GeminiRateLimitError"
        ) {
          emitNarration(socket, `[INFO] Vision model rate limited, trying fallback...`);
        } else {
          console.error(
            `[Vision] Model error (${MODELS.vision}):`,
            visionErr?.message || visionErr,
          );
          emitNarration(
            socket,
            `[WARN] Vision model error: ${visionErr?.message?.slice(0, 80) ?? "unknown"}. Trying fallback...`,
          );
        }
        try {
          action = await fallbackDecideAction(screenshot, aom, step, ctx);
          modelState.useFallback = true; // Stick with fallback for subsequent steps
          emitNarration(socket, `[INFO] Fallback succeeded — using fallback model for remaining steps`);
        } catch (fallbackErr: any) {
          if (
            fallbackErr instanceof GeminiRateLimitError ||
            fallbackErr.name === "GeminiRateLimitError"
          ) {
            throw fallbackErr;
          }
          emitNarration(socket, `[ERROR] All models failed: ${fallbackErr.message}`);
          if (actionNum < MAX_ACTIONS_PER_STEP - 1) continue;
          break;
        }
      }
    }

    if (!action) break;

    // Log every action decision clearly
    console.log(`[Step ${step.id}] action ${actionNum + 1}/${MAX_ACTIONS_PER_STEP}: type=${action.type}${action.coordinate ? ` coord=[${action.coordinate}]` : ""}${action.text ? ` text="${action.text.slice(0, 40)}"` : ""}${action.key ? ` key=${action.key}` : ""}${action.url ? ` url=${action.url}` : ""}`);
    console.log(`[Step ${step.id}] reasoning: ${(action.reasoning ?? "—").slice(0, 120)}`);

    // Abort/skip check after decideAction resolves (before touching the browser)
    if (checkAbort()) return { status: "incomplete" };

    // ┌──────────────────────────────────────────────┐
    // │ 2b. Check if step is already done            │
    // └──────────────────────────────────────────────┘
    if (
      action.type === "screenshot" &&
      action.reasoning?.toLowerCase().includes("complete")
    ) {
      // Don't break blindly — verify the expected outcome is actually on screen.
      // Gemini may report "complete" too early (e.g. after filling form fields but
      // before clicking Submit), which would skip the remaining required action.
      emitNarration(socket, "[INFO] AI reports step complete — verifying...");
      try {
        const checkShot = await takeScreenshot();
        const quickCheck = await verifyStep(checkShot, step.expectedBehavior, ctx);
        if (quickCheck.passed) {
          emitNarration(socket, `[OK] Confirmed — step outcome visible: ${quickCheck.finding}`);
          break;
        }
        emitNarration(socket, `[INFO] Expected outcome not yet visible (${quickCheck.finding}) — escalating to pro model`);
        console.log(`[Step ${step.id}] STEP_COMPLETE rejected — escalating to pro model`);
        modelState.escalated = true;
      } catch {
        // verifyStep failed — safer to keep going than to break early
        emitNarration(socket, "[INFO] Could not verify step completion — continuing");
      }
      continue;
    }

    // ┌──────────────────────────────────────────────┐
    // │ 3. LOG — Tell the frontend what we're doing  │
    // └──────────────────────────────────────────────┘
    const actionDesc = formatAction(action);
    emitNarration(socket, `[INFO] Action: ${actionDesc}`);

    // Fire-and-forget narration (non-critical) — suppress if step was aborted
    generateNarration(action, ctx)
      .then((n) => {
        if (!abortToken?.aborted) emitNarration(socket, `[INFO] ${n}`);
      })
      .catch(() => { });

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
        emitNarration(
          socket,
          `[WARN] Step incomplete — ${isNav ? "navigation" : "action"} ${caughtActionErr.incompleteReason}: ${caughtActionErr.message}`,
        );
        return {
          status: "incomplete",
          incompleteReason: caughtActionErr.incompleteReason,
          lastScreenshot,
        };
      }

      // Regular action error (bad coordinates, element issue) → try self-heal
      emitNarration(
        socket,
        `[ERROR] Action failed: ${caughtActionErr.message}`,
      );

      if (actionNum < MAX_ACTIONS_PER_STEP - 1) {
        // Guard: don't self-heal if step was already skipped/aborted
        if (checkAbort()) return { status: "incomplete" };

        emitNarration(socket, "[INFO] Attempting self-heal...");

        const healShot = await takeScreenshot();
        emitScreenshot(socket, step.id, healShot, await getCurrentUrl());
        const healAom = await getAOMSnapshot();

        try {
          const healAction = await retryAction(
            caughtActionErr.message,
            healShot,
            healAom,
            step,
            ctx,
          );
          // Guard: don't execute heal action if aborted while Gemini was thinking
          if (checkAbort()) return { status: "incomplete" };
          await executeComputerAction(healAction);
          emitNarration(socket, "[OK] Recovered with new approach");
          actionLog.push(`Self-healed: ${formatAction(healAction)}`);
          await new Promise((r) => setTimeout(r, 500));
          break;
        } catch (healErr: any) {
          if (
            healErr instanceof GeminiRateLimitError ||
            healErr.name === "GeminiRateLimitError"
          ) {
            throw healErr;
          }
          if (healErr instanceof PlaywrightActionError) {
            emitNarration(
              socket,
              `[WARN] Self-heal hit infrastructure error: ${healErr.message}`,
            );
            return {
              status: "incomplete",
              incompleteReason: healErr.incompleteReason,
              lastScreenshot,
            };
          }
          emitNarration(socket, `[ERROR] Self-heal failed: ${healErr.message}`);
        }
      }
    } else {
      actionLog.push(actionDesc);
      await new Promise((r) => setTimeout(r, 500));
      // Don't break — continue the loop so the model can take more actions
      // toward the goal (e.g. click field → type → press Enter).
      // The loop exits when: STEP_COMPLETE is returned, MAX_ACTIONS_PER_STEP
      // is reached, or an abort/skip is detected at the top of the next iteration.
    }
  }

  // Reset escalation state — it's per-step, not session-wide
  modelState.escalated = false;

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
    if (
      verifyErr instanceof GeminiRateLimitError ||
      verifyErr.name === "GeminiRateLimitError"
    ) {
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
  if (action.coordinate)
    parts.push(`at (${action.coordinate[0]},${action.coordinate[1]})`);
  if (action.text) parts.push(`"${action.text.slice(0, 30)}"`);
  if (action.key) parts.push(action.key);
  if (action.direction) parts.push(action.direction);
  if (action.url) parts.push(action.url);
  return parts.join(" ");
}
