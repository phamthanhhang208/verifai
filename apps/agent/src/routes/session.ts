import type { Socket } from "socket.io";
import type {
  TestPlan, TestStep, StepStatus, Bug,
  ComputerUseAction,
  StepStartEvent, StepResultEvent, ScreenshotEvent,
  NarrationEvent, SessionCompleteEvent,
} from "@verifai/types";
import {
  launchBrowser, navigateTo, takeScreenshot, getCurrentUrl,
  getAOMSnapshot, executeComputerAction, closeBrowser,
} from "../lib/playwright.js";
import {
  decideAction, verifyStep, generateNarration,
  retryAction, fallbackDecideAction,
} from "../lib/gemini.js";

// ─── Helpers ────────────────────────────────────────────

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

// ─── Main Session Runner ────────────────────────────────

export async function runSession(
  socket: Socket,
  sessionId: string,
  testPlan: TestPlan,
  targetUrl: string
) {
  const bugs: Bug[] = [];
  const bugScreenshots = new Map<string, string>();
  const actionLog: string[] = [];

  try {
    // ── Launch browser ──
    emitNarration(socket, "[INFO] Launching headless browser...");
    await launchBrowser();

    // ── Navigate to target URL ──
    emitNarration(socket, `[INFO] Navigating to ${targetUrl}`);
    await navigateTo(targetUrl);

    // ── Send initial screenshot to frontend ──
    const initShot = await takeScreenshot();
    emitScreenshot(socket, "init", initShot, targetUrl);
    emitNarration(socket, "[OK] Target application loaded");

    // ── Execute each step with the VISION LOOP ──
    for (let i = 0; i < testPlan.steps.length; i++) {
      const step = testPlan.steps[i];

      // Announce step start
      socket.emit("event", {
        type: "step_start",
        stepId: step.id,
        stepIndex: i,
      } as StepStartEvent);
      emitNarration(socket, `[INFO] Step ${i + 1}/${testPlan.steps.length}: ${step.text}`);

      // Execute step with the vision loop (THIS IS THE KEY FUNCTION)
      let result: { status: StepStatus; bug?: Bug; lastScreenshot?: string };
      try {
        result = await Promise.race([
          executeStepWithVisionLoop(socket, step, actionLog),
          new Promise<never>((_, rej) =>
            setTimeout(() => rej(new Error("Step timeout (60s)")), 60_000)
          ),
        ]);
      } catch (err: any) {
        result = {
          status: "fail",
          lastScreenshot: await takeScreenshot().catch(() => ""),
        };
        emitNarration(socket, `[ERROR] Step failed: ${err.message}`);
      }

      // Store screenshot for failed steps (used in Phase 6 report)
      if (result.status === "fail" && result.lastScreenshot) {
        bugScreenshots.set(step.id, result.lastScreenshot);
      }
      if (result.bug) bugs.push(result.bug);

      // Emit result to frontend
      socket.emit("event", {
        type: "step_result",
        stepId: step.id,
        status: result.status,
        finding: result.bug?.actualBehavior,
        severity: result.bug?.severity,
      } as StepResultEvent);

      actionLog.push(`Step "${step.text}" → ${result.status}`);
    }

  } catch (fatalErr: any) {
    emitNarration(socket, `[ERROR] Fatal session error: ${fatalErr.message}`);
    socket.emit("event", { type: "error", message: fatalErr.message });
  } finally {
    // ALWAYS clean up browser
    await closeBrowser().catch(() => {});
  }

  // Session complete
  // TODO Phase 6: compileAndSaveReport(sessionId, testPlan, bugs, bugScreenshots)
  const reportId = `rpt-${Date.now()}`;
  socket.emit("event", { type: "session_complete", reportId } as SessionCompleteEvent);
  emitNarration(socket, `[OK] Session complete — ${bugs.length} bug(s) found`);
}

// ─── THE VISION LOOP ────────────────────────────────────
//
// This is the CORRECT architecture. For each test step:
//   1. Screenshot current state
//   2. Send to Gemini vision → get action
//   3. Execute action in browser
//   4. Screenshot again → verify with Gemini
//
// Gemini SEES the browser before EVERY decision.
// Playwright only executes — it never decides.
//
// ─────────────────────────────────────────────────────────

async function executeStepWithVisionLoop(
  socket: Socket,
  step: TestStep,
  actionLog: string[],
): Promise<{ status: StepStatus; bug?: Bug; lastScreenshot?: string }> {

  const MAX_ACTIONS_PER_STEP = 3; // Prevent infinite loops
  let lastScreenshot = "";
  let wasHealed = false;

  for (let actionNum = 0; actionNum < MAX_ACTIONS_PER_STEP; actionNum++) {

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
    // │    Gemini SEES the screenshot and decides     │
    // │    what action to take next                   │
    // └──────────────────────────────────────────────┘
    let action: ComputerUseAction;
    try {
      action = await decideAction(screenshot, aom, step, actionLog);
    } catch (visionErr: any) {
      // Vision model failed (probably rate limited) — try lite fallback
      emitNarration(socket, `[INFO] Vision model unavailable (${visionErr.message}), trying fallback...`);
      try {
        action = await fallbackDecideAction(screenshot, aom, step);
      } catch (fallbackErr: any) {
        emitNarration(socket, `[ERROR] All models failed: ${fallbackErr.message}`);
        if (actionNum < MAX_ACTIONS_PER_STEP - 1) continue; // Retry on next iteration
        break; // Give up, go to verification
      }
    }

    // ┌──────────────────────────────────────────────┐
    // │ 2b. Check if step is already done            │
    // └──────────────────────────────────────────────┘
    if (action.type === "screenshot" && action.reasoning?.toLowerCase().includes("complete")) {
      emitNarration(socket, "[INFO] AI sees the expected outcome is already on screen");
      break; // Skip to verification
    }

    // ┌──────────────────────────────────────────────┐
    // │ 3. LOG — Tell the frontend what we're doing  │
    // └──────────────────────────────────────────────┘
    const actionDesc = formatAction(action);
    emitNarration(socket, `[INFO] Action: ${actionDesc}`);

    // Fire-and-forget narration (non-critical, uses lite model)
    generateNarration(action)
      .then((n) => emitNarration(socket, `[INFO] ${n}`))
      .catch(() => {});

    // ┌──────────────────────────────────────────────┐
    // │ 4. ACT — Playwright executes the action      │
    // └──────────────────────────────────────────────┘
    let actionError: string | null = null;
    try {
      await executeComputerAction(action);
    } catch (err: any) {
      actionError = err.message;
    }

    // ┌──────────────────────────────────────────────┐
    // │ 5. SELF-HEAL — If action failed, retry once  │
    // └──────────────────────────────────────────────┘
    if (actionError) {
      emitNarration(socket, `[ERROR] Action failed: ${actionError}`);

      if (actionNum < MAX_ACTIONS_PER_STEP - 1) {
        emitNarration(socket, "[INFO] Attempting self-heal...");

        // Take new screenshot AFTER the failure
        const healShot = await takeScreenshot();
        emitScreenshot(socket, step.id, healShot, await getCurrentUrl());
        const healAom = await getAOMSnapshot();

        try {
          // Ask Gemini to try a different approach
          const healAction = await retryAction(actionError, healShot, healAom, step);
          await executeComputerAction(healAction);
          emitNarration(socket, "[HEALED] Recovered with new approach");
          wasHealed = true;
          actionLog.push(`Self-healed: ${formatAction(healAction)}`);
          await new Promise((r) => setTimeout(r, 500));
          break; // Healed — skip to verification
        } catch (healErr: any) {
          emitNarration(socket, `[ERROR] Self-heal failed: ${healErr.message}`);
          // Continue loop — next iteration will take fresh screenshot
        }
      }
    } else {
      // Action succeeded
      actionLog.push(actionDesc);
      await new Promise((r) => setTimeout(r, 500)); // Let page settle
      break; // Go to verification
    }
  }

  // ┌──────────────────────────────────────────────────┐
  // │ 6. VERIFY — Take final screenshot, ask Gemini   │
  // │    Lite model if the expected behavior happened  │
  // └──────────────────────────────────────────────────┘
  await new Promise((r) => setTimeout(r, 500));
  const verifyShot = await takeScreenshot();
  lastScreenshot = verifyShot;
  emitScreenshot(socket, step.id, verifyShot, await getCurrentUrl());

  try {
    const v = await verifyStep(verifyShot, step.expectedBehavior);

    if (v.passed) {
      emitNarration(socket, `[OK] Step passed: ${v.finding}`);
      return { status: wasHealed ? "healed" : "pass", lastScreenshot };
    } else {
      emitNarration(socket, `[ERROR] Verification failed: ${v.finding}`);
      return {
        status: "fail",
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
        },
      };
    }
  } catch (verifyErr: any) {
    emitNarration(socket, `[ERROR] Verification error: ${verifyErr.message}`);
    return {
      status: "fail",
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
      },
    };
  }
}

// ─── Format action for logging ──────────────────────────

function formatAction(action: ComputerUseAction): string {
  const parts = [action.type];
  if (action.coordinate) parts.push(`at (${action.coordinate[0]},${action.coordinate[1]})`);
  if (action.text) parts.push(`"${action.text.slice(0, 30)}"`);
  if (action.key) parts.push(action.key);
  if (action.direction) parts.push(action.direction);
  if (action.url) parts.push(action.url);
  return parts.join(" ");
}
