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
  FillRejectedError,
} from "../lib/playwright.js";
import {
  decideAction,
  visionFallbackDecideAction,
  escalatedDecideAction,
  verifyStep,
  generateNarration,
  generateVoiceNarration,
  retryAction,
  type GeminiCallContext,
} from "../lib/gemini.js";
import { GeminiRateLimitError, MODELS } from "../lib/models.js";
import type { VoiceEvent } from "@verifai/types";
import { compileAndSaveReport } from "../lib/report.js";
import {
  DEMO_FALLBACK_ENABLED,
  demoStepResults,
} from "../lib/demo-fallback.js";
import {
  shouldPauseForAction,
  shouldPauseForVerification,
  classifyPauseReason,
  generateQuestion,
  pauseForHuman,
  getAuditLog,
} from "../lib/hitl.js";
import type { HITLLogEntry, HITLDecisionEvent } from "@verifai/types";

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

function emitVoice(socket: Socket, text: string, ctx?: GeminiCallContext) {
  // Fire-and-forget — don't await, don't block execution
  generateVoiceNarration(text, ctx)
    .then((result) => {
      if (result) {
        socket.emit("event", {
          type: "voice",
          audio: result.audio,
          mimeType: result.mimeType,
          text,
        } as VoiceEvent);
      }
    })
    .catch(() => {}); // Silently ignore TTS failures
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
  const hitlLog: HITLLogEntry[] = [];
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
  const modelState = { useVisionFallback: false, escalated: false };
  const failedStepIds = new Set<string>(); // Track failed steps for dependency checking

  try {
    emitNarration(socket, "[INFO] Launching headless browser...");
    await launchBrowser();

    emitNarration(socket, `[INFO] Navigating to ${targetUrl}`);
    await navigateTo(targetUrl);

    const initShot = await takeScreenshot();
    emitScreenshot(socket, "init", initShot, targetUrl);
    emitNarration(socket, "[OK] Target application loaded");
    emitVoice(socket, `Starting QA session against ${targetUrl}`, geminiCtx);

    for (let i = 0; i < testPlan.steps.length; i++) {
      const step = testPlan.steps[i];

      // ── DEPENDENCY CHECK: Skip if any dependency failed ──
      if (step.dependsOn && step.dependsOn.length > 0) {
        const failedDep = step.dependsOn.find((depId) =>
          failedStepIds.has(depId),
        );
        if (failedDep) {
          const depStep = testPlan.steps.find((s) => s.id === failedDep);
          const depName = depStep ? depStep.text : failedDep;
          socket.emit("event", {
            type: "step_start",
            stepId: step.id,
            stepIndex: i,
          } as StepStartEvent);
          emitNarration(
            socket,
            `[INFO] Step ${i + 1}/${testPlan.steps.length}: ${step.text}`,
          );
          emitNarration(
            socket,
            `[WARN] Skipped — depends on failed step: "${depName}"`,
          );
          step.status = "incomplete";
          incompleteCount++;
          socket.emit("event", {
            type: "step_result",
            stepId: step.id,
            status: "incomplete",
            finding: `Skipped — depends on failed step "${depName}"`,
          } as StepResultEvent);
          actionLog.push(
            `Step "${step.text}" → skipped (depends on ${failedDep})`,
          );
          continue;
        }
      }

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
      emitVoice(socket, `Step ${i + 1}: ${step.text}`, geminiCtx);

      // Per-step abort token — set in finally so background vision loop stops ASAP
      const abortToken = { aborted: false };

      const skipRacer = skipSignal ? raceSkip(skipSignal, step.id) : null;
      // Keep a reference to the vision promise so we can attach .catch() to it.
      // This prevents an unhandled rejection warning if the background goroutine
      // eventually throws (e.g. GeminiRateLimitError from the sessionAbort check)
      // after the race has already resolved via skip or timeout.
      const visionPromise = executeStepWithVisionLoop(
        socket,
        _sessionId,
        step,
        actionLog,
        geminiCtx,
        modelState,
        skipSignal,
        abortToken,
      );
      visionPromise.catch(() => {});
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

      // Track failed step IDs for dependency checking
      if (result.status === "failed") {
        failedStepIds.add(step.id);
      }

      socket.emit("event", {
        type: "step_result",
        stepId: step.id,
        status: result.status,
        finding: result.bug?.actualBehavior,
        severity: result.bug?.severity,
        failureType: result.failureType,
        incompleteReason: result.incompleteReason,
      } as StepResultEvent);

      // Voice narration for step results (fire-and-forget)
      if (result.status === "passed") {
        emitVoice(socket, `Step ${i + 1} passed`, geminiCtx);
      } else if (result.status === "failed" && result.bug) {
        emitVoice(socket, `Bug found: ${result.bug.title}`, geminiCtx);
      } else if (result.status === "incomplete") {
        emitVoice(socket, `Step ${i + 1} skipped`, geminiCtx);
      }

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
    await closeBrowser().catch(() => {});

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

  // Collect HITL audit log
  const hitlAuditLog = getAuditLog(_sessionId);
  if (hitlAuditLog.length > 0) {
    emitNarration(
      socket,
      `[INFO] ${hitlAuditLog.length} human intervention(s) logged`,
    );
  }

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

  console.log(
    `[Session] Emitting session_complete with ${bugs.length} bugs:`,
    bugs.map((b) => ({
      id: b.id,
      jiraTicketKey: b.jiraTicketKey,
      jiraTicketUrl: b.jiraTicketUrl,
      screenshotUrl: b.screenshotUrl?.slice(0, 50),
    })),
  );
  socket.emit("event", {
    type: "session_complete",
    reportId,
    bugs,
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
  emitVoice(socket, finalNarration.replace(/\[.*?\]\s*/g, ""), geminiCtx);
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
  sessionId: string,
  step: TestStep,
  actionLog: string[],
  ctx: GeminiCallContext,
  modelState: { useVisionFallback: boolean; escalated: boolean },
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

  const MAX_ACTIONS_PER_STEP = 8;
  let lastScreenshot = "";
  let completeRejections = 0;
  const stepActions: string[] = []; // Per-step action history — passed to Gemini so it knows what was already done
  let consecutiveRepeats = 0; // Tracks repeated identical actions (same coord + text)
  let lastActionKey = ""; // Fingerprint of the previous action for repeat detection

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
      // Pro model — loop detected or vision declared complete but verify disagreed
      try {
        action = await escalatedDecideAction(screenshot, aom, step, stepActions, ctx);
        console.log(`[Step ${step.id}] escalated pro model responded`);
      } catch (proErr: any) {
        if (proErr instanceof GeminiRateLimitError || proErr.name === "GeminiRateLimitError") {
          throw proErr;
        }
        console.error(`[Pro] Model error (${MODELS.pro}):`, proErr?.message || proErr);
        emitNarration(socket, `[ERROR] All models failed: ${proErr?.message?.slice(0, 80) ?? "unknown"}`);
        if (actionNum < MAX_ACTIONS_PER_STEP - 1) continue;
        break;
      }
    } else if (modelState.useVisionFallback) {
      // Tier 2 — Computer Use fallback (primary vision was failing)
      try {
        action = await visionFallbackDecideAction(screenshot, aom, step, stepActions, ctx);
      } catch (visionFallbackErr: any) {
        if (visionFallbackErr instanceof GeminiRateLimitError || visionFallbackErr.name === "GeminiRateLimitError") {
          throw visionFallbackErr;
        }
        console.error(`[VisionFallback] Model error (${MODELS.visionFallback}):`, visionFallbackErr?.message || visionFallbackErr);
        emitNarration(socket, `[WARN] Vision fallback failed — trying pro model...`);
        try {
          action = await escalatedDecideAction(screenshot, aom, step, stepActions, ctx);
          emitNarration(socket, `[INFO] Pro model succeeded`);
        } catch (proErr: any) {
          console.error(`[Pro fallback] Model error (${MODELS.pro}):`, proErr?.message || proErr);
          emitNarration(socket, `[ERROR] All models failed`);
          if (actionNum < MAX_ACTIONS_PER_STEP - 1) continue;
          break;
        }
      }
    } else {
      // Normal path — Tier 1: primary vision model (Computer Use)
      try {
        action = await decideAction(screenshot, aom, step, stepActions, ctx);
      } catch (visionErr: any) {
        if (visionErr instanceof GeminiRateLimitError || visionErr.name === "GeminiRateLimitError") {
          emitNarration(socket, `[INFO] Vision model rate limited, trying vision fallback...`);
        } else {
          console.error(`[Vision] Model error (${MODELS.vision}):`, visionErr?.message || visionErr);
          emitNarration(socket, `[WARN] Vision model error: ${visionErr?.message?.slice(0, 80) ?? "unknown"}. Trying vision fallback...`);
        }
        try {
          action = await visionFallbackDecideAction(screenshot, aom, step, stepActions, ctx);
          modelState.useVisionFallback = true;
          emitNarration(socket, `[INFO] Vision fallback succeeded — using for remaining actions`);
        } catch (visionFallbackErr: any) {
          if (visionFallbackErr instanceof GeminiRateLimitError || visionFallbackErr.name === "GeminiRateLimitError") {
            throw visionFallbackErr;
          }
          console.error(`[VisionFallback] Model error (${MODELS.visionFallback}):`, visionFallbackErr?.message || visionFallbackErr);
          emitNarration(socket, `[WARN] Vision fallback also failed — trying pro model...`);
          try {
            action = await escalatedDecideAction(screenshot, aom, step, stepActions, ctx);
            emitNarration(socket, `[INFO] Pro model succeeded`);
          } catch (proErr: any) {
            console.error(`[Pro fallback] Model error (${MODELS.pro}):`, proErr?.message || proErr);
            emitNarration(socket, `[ERROR] All models failed: ${proErr?.message ?? visionFallbackErr.message}`);
            if (actionNum < MAX_ACTIONS_PER_STEP - 1) continue;
            break;
          }
        }
      }
    }

    if (!action) break;

    // Log every action decision clearly
    console.log(
      `[Step ${step.id}] action ${actionNum + 1}/${MAX_ACTIONS_PER_STEP}: type=${action.type}${action.coordinate ? ` coord=[${action.coordinate}]` : ""}${action.text ? ` text="${action.text.slice(0, 40)}"` : ""}${action.key ? ` key=${action.key}` : ""}${action.url ? ` url=${action.url}` : ""}`,
    );
    console.log(
      `[Step ${step.id}] reasoning: ${(action.reasoning ?? "—").slice(0, 120)}`,
    );

    // ── REPEAT DETECTION — escalate to pro model if stuck in a loop ──
    const actionKey = `${action.type}|${action.coordinate?.join(",") ?? ""}|${action.text ?? ""}`;
    if (actionKey === lastActionKey) {
      consecutiveRepeats++;
      if (consecutiveRepeats >= 2) {
        console.log(
          `[Step ${step.id}] Detected ${consecutiveRepeats} repeat actions — escalating to pro model`,
        );
        emitNarration(
          socket,
          `[WARN] Agent stuck in loop — switching to stronger model`,
        );
        modelState.escalated = true;
        consecutiveRepeats = 0;
        continue; // Re-run this iteration with the escalated model
      }
    } else {
      consecutiveRepeats = 0;
    }
    lastActionKey = actionKey;

    // ┌──────────────────────────────────────────────┐
    // │ 2c. HITL CHECK — Low confidence action       │
    // └──────────────────────────────────────────────┘
    if (shouldPauseForAction(action)) {
      const reason = classifyPauseReason(action, {
        currentUrl: await getCurrentUrl(),
        stepText: step.text,
      });
      const question = generateQuestion(reason, action, step.text);

      const decision = await pauseForHuman(socket, sessionId, {
        stepId: step.id,
        stepText: step.text,
        reason,
        question,
        screenshotBase64: screenshot,
        suggestedAction: action,
        confidence: action.confidence ?? 0,
      });

      // Apply decision
      switch (decision.decision) {
        case "proceed":
          // Continue with the AI's action
          break;
        case "skip":
          return { status: "incomplete" as const, incompleteReason: undefined };
        case "retry":
          // Re-take screenshot and re-analyze — continue the action loop
          continue;
        case "abort":
          throw new Error("Session aborted by human operator");
        case "override":
          if (decision.overrideAction) {
            action = {
              type: decision.overrideAction.type as any,
              coordinate: decision.overrideAction.coordinate,
              text: decision.overrideAction.text,
              reasoning: `Human override: ${decision.overrideAction.reasoning || "manual action"}`,
              confidence: 1.0,
            };
          }
          break;
      }
    }

    // Abort/skip check after decideAction resolves (before touching the browser)
    if (checkAbort()) return { status: "incomplete" };

    // ┌──────────────────────────────────────────────┐
    // │ 2b. Check if AI says step is already done    │
    // └──────────────────────────────────────────────┘
    if (
      action.type === "screenshot" &&
      action.reasoning?.toLowerCase().includes("complete")
    ) {
      emitNarration(socket, "[INFO] AI reports step complete — verifying...");
      try {
        const checkShot = await takeScreenshot();
        const isActionStep = /^(navigate|click|type|enter|press|go|fill|log\s*in|login)/i.test(step.text.trim());
        const quickCheck = await verifyStep(
          checkShot,
          step.expectedBehavior,
          isActionStep,
          ctx,
        );
        if (quickCheck.passed) {
          emitNarration(
            socket,
            `[OK] Confirmed — step outcome visible: ${quickCheck.finding}`,
          );
          break;
        }

        completeRejections++;

        if (completeRejections >= 2) {
          // Verify rejected STEP_COMPLETE twice — it's detecting a real bug, not a vision misread
          emitNarration(
            socket,
            `[ERROR] Verification failed: ${quickCheck.finding}`,
          );
          return {
            status: "failed",
            failureType: "assertion" as const,
            lastScreenshot: checkShot,
            bug: {
              id: `bug-${Date.now()}`,
              stepId: step.id,
              title: `Step failed: ${step.text}`,
              description: step.text,
              expectedBehavior: step.expectedBehavior,
              actualBehavior: quickCheck.finding,
              severity: quickCheck.severity ?? "medium",
              screenshotUrl: "",
            },
          };
        }

        // First rejection — escalate to pro in case vision misread the screen
        emitNarration(
          socket,
          `[INFO] Expected outcome not yet visible (${quickCheck.finding}) — escalating to pro model`,
        );
        console.log(
          `[Step ${step.id}] STEP_COMPLETE rejected — escalating to pro model`,
        );
        modelState.escalated = true;
      } catch {
        emitNarration(
          socket,
          "[INFO] Could not verify step completion — continuing",
        );
      }
      continue;
    }

    // ┌──────────────────────────────────────────────┐
    // │ 3. LOG — Tell the frontend what we're doing  │
    // └──────────────────────────────────────────────┘
    const actionDesc = formatAction(action);
    emitNarration(socket, `[INFO] Action: ${actionDesc}`);

    // Fire-and-forget narration (non-critical)
    generateNarration(action, ctx)
      .then((n) => {
        if (!abortToken?.aborted) emitNarration(socket, `[INFO] ${n}`);
      })
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
    // │ 5. SELF-HEAL — If action failed, fix coords  │
    // └──────────────────────────────────────────────┘
    if (caughtActionErr) {
      // Field rejected all fill attempts — potential product bug, ask human
      if (caughtActionErr instanceof FillRejectedError) {
        const pauseShot = await takeScreenshot();
        emitNarration(
          socket,
          `[WARN] Field "${caughtActionErr.selector}" rejected all fill attempts — asking human`,
        );

        const decision = await pauseForHuman(socket, sessionId, {
          stepId: step.id,
          stepText: step.text,
          reason: "unexpected_page_state",
          question: `The field "${caughtActionErr.selector}" rejected all fill attempts (value always empty after write). Is this a product bug, or should we skip this step?`,
          screenshotBase64: pauseShot,
          confidence: 0,
        });

        if (decision.decision === "proceed") {
          emitNarration(socket, `[FAIL] Field fill rejected — human confirmed as bug`);
          return {
            status: "failed" as const,
            lastScreenshot: pauseShot,
            bug: {
              id: `bug-${Date.now()}`,
              stepId: step.id,
              title: `Form field rejects input: ${caughtActionErr.selector}`,
              description: `Field "${caughtActionErr.selector}" rejects all programmatic value writes. The value is always empty after fill(), native setter, and keyboard input — indicating a broken React controlled component.`,
              severity: "high" as const,
              screenshotUrl: "",
              expectedBehavior: step.expectedBehavior,
              actualBehavior: `Field "${caughtActionErr.selector}" does not accept input`,
              failureType: "assertion" as const,
            },
          };
        } else {
          emitNarration(socket, `[WARN] Field fill rejected — skipping step per human decision`);
          return {
            status: "incomplete" as const,
            incompleteReason: "crash" as const,
            lastScreenshot: pauseShot,
          };
        }
      }

      // Playwright infrastructure failure → mark incomplete
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

      // Regular action error (bad coordinates) → self-heal targeting ONCE, no escalation
      emitNarration(
        socket,
        `[ERROR] Action failed: ${caughtActionErr.message}`,
      );

      if (actionNum < MAX_ACTIONS_PER_STEP - 1) {
        if (checkAbort()) return { status: "incomplete" };

        emitNarration(socket, "[INFO] Attempting self-heal (fix targeting)...");

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
          if (checkAbort()) return { status: "incomplete" };
          await executeComputerAction(healAction);
          emitNarration(socket, "[OK] Recovered with corrected targeting");
          actionLog.push(`Self-healed: ${formatAction(healAction)}`);
          await new Promise((r) => setTimeout(r, 500));
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
      stepActions.push(actionDesc);
      await new Promise((r) => setTimeout(r, 500));

      // ── MID-LOOP VERIFICATION — catch pass early, stop wasting actions ──
      // Skip verification when the most recent action was a "type" — typing into a field
      // alone never completes a step (still need submit/Enter), so verifying wastes an API
      // call and can cause premature termination on multi-input forms.
      const skipMidVerify =
        action && (action.type === "type" || action.type === "key_press");
        
      const isActionStep = /^(navigate|click|type|enter|press|go|fill|log\s*in|login)/i.test(step.text.trim());

      if (actionNum >= 1 && !skipMidVerify) {
        try {
          const midShot = await takeScreenshot();
          const midCheck = await verifyStep(
            midShot,
            step.expectedBehavior,
            isActionStep,
            ctx,
          );
          if (midCheck.passed) {
            emitNarration(socket, `[OK] Step passed: ${midCheck.finding}`);
            return { status: "passed", lastScreenshot: midShot };
          }
          console.log(
            `[Step ${step.id}] Mid-loop verify after action ${actionNum + 1}: not passed (${midCheck.finding})`,
          );
          if (actionNum >= MAX_ACTIONS_PER_STEP - 2) {
            // Near the end of our action budget — stop trying
            console.log(
              `[Step ${step.id}] ${actionNum + 1} actions exhausted without passing — stopping`,
            );
            emitNarration(
              socket,
              `[INFO] Step not passing after ${actionNum + 1} actions — verifying final state`,
            );
            break;
          }
        } catch {
          // verifyStep error — continue the loop
        }
      }
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
    const isActionStep = /^(navigate|click|type|enter|press|go|fill|log\s*in|login)/i.test(step.text.trim());
    const v = await verifyStep(verifyShot, step.expectedBehavior, isActionStep, ctx);

    // Abort/skip check after verifyStep resolves
    if (checkAbort()) return { status: "incomplete" };

    // ┌──────────────────────────────────────────────┐
    // │ 6b. HITL CHECK — Ambiguous verification      │
    // └──────────────────────────────────────────────┘
    if (shouldPauseForVerification(v)) {
      const decision = await pauseForHuman(socket, sessionId, {
        stepId: step.id,
        stepText: step.text,
        reason: "verification_ambiguous",
        question: generateQuestion(
          "verification_ambiguous",
          { type: "screenshot" } as any,
          step.text,
        ),
        screenshotBase64: verifyShot,
        confidence: v.confidence ?? 0,
      });

      if (decision.decision === "proceed") {
        // Human says it passed
        emitNarration(socket, `[OK] Step passed (human confirmed)`);
        return { status: "passed" as const, lastScreenshot };
      } else if (decision.decision === "skip") {
        // Human says it failed
        emitNarration(socket, `[ERROR] Step failed (human confirmed)`);
        return {
          status: "failed" as const,
          lastScreenshot,
          bug: {
            id: `bug-${Date.now()}`,
            stepId: step.id,
            title: `Human-confirmed failure: ${step.text}`,
            description: `${v.finding}. Human operator confirmed this is a failure.`,
            severity: v.severity || "medium",
            screenshotUrl: "",
            expectedBehavior: step.expectedBehavior,
            actualBehavior: v.finding,
            failureType: "assertion",
          },
        };
      } else if (decision.decision === "retry") {
        // Re-verify with fresh screenshot
        // Fall through to take another screenshot and verify again
        // (Simplest: just let the normal flow re-run by not returning)
        await new Promise((r) => setTimeout(r, 1000));
        const retryShot = await takeScreenshot();
        const isActionStep = /^(navigate|click|type|enter|press|go|fill|log\s*in|login)/i.test(step.text.trim());
        const retryV = await verifyStep(retryShot, step.expectedBehavior, isActionStep, ctx);
        if (retryV.passed) {
          emitNarration(socket, `[OK] Step passed on re-verification`);
          return { status: "passed" as const, lastScreenshot: retryShot };
        } else {
          emitNarration(
            socket,
            `[ERROR] Step still failing on re-verification: ${retryV.finding}`,
          );
          return {
            status: "failed" as const,
            lastScreenshot: retryShot,
            bug: {
              id: `bug-${Date.now()}`,
              stepId: step.id,
              title: `Failed: ${step.text}`,
              description: retryV.finding,
              severity: retryV.severity || "medium",
              screenshotUrl: "",
              expectedBehavior: step.expectedBehavior,
              actualBehavior: retryV.finding,
              failureType: "assertion",
            },
          };
        }
      } else if (decision.decision === "abort") {
        throw new Error("Session aborted by human operator");
      }
    }

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
