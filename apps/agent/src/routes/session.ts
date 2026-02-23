import type { Socket } from "socket.io";
import type {
  TestPlan,
  TestStep,
  StepStatus,
  Bug,
  StepStartEvent,
  StepResultEvent,
  ScreenshotEvent,
  NarrationEvent,
  SessionCompleteEvent,
} from "@verifai/types";
import {
  launchBrowser,
  navigateTo,
  takeScreenshot,
  getAOMSnapshot,
  injectHighlight,
  executeAction,
  closeBrowser,
} from "../lib/playwright.js";
import {
  decideAction,
  verifyStep,
  generateNarration,
  sendToolResponse,
} from "../lib/gemini.js";

function timestamp(): string {
  return new Date().toISOString();
}

function emitNarration(socket: Socket, text: string) {
  const event: NarrationEvent = { type: "narration", text, timestamp: timestamp() };
  socket.emit("event", event);
}

export async function runSession(
  socket: Socket,
  sessionId: string,
  testPlan: TestPlan,
  targetUrl: string
) {
  const bugs: Bug[] = [];

  // Launch browser
  emitNarration(socket, "[INFO] Launching browser...");
  await launchBrowser();

  // Navigate to target
  emitNarration(socket, `[INFO] Navigating to ${targetUrl}`);
  await navigateTo(targetUrl);

  // Take initial screenshot
  const initialScreenshot = await takeScreenshot();
  const initScreenshotEvent: ScreenshotEvent = {
    type: "screenshot",
    stepId: "init",
    base64: initialScreenshot,
    url: targetUrl,
  };
  socket.emit("event", initScreenshotEvent);

  for (let i = 0; i < testPlan.steps.length; i++) {
    const step = testPlan.steps[i];
    const stepTimeout = 30000;

    const startEvent: StepStartEvent = {
      type: "step_start",
      stepId: step.id,
      stepIndex: i,
    };
    socket.emit("event", startEvent);
    emitNarration(
      socket,
      `[INFO] Step ${i + 1}/${testPlan.steps.length}: ${step.text}`
    );

    let stepStatus: StepStatus = "pending";

    try {
      const result = await Promise.race([
        executeStep(socket, step, targetUrl),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("Step timeout (30s)")),
            stepTimeout
          )
        ),
      ]);

      stepStatus = result.status;
      if (result.bug) bugs.push(result.bug);
    } catch (error: unknown) {
      stepStatus = "fail";
      const msg = error instanceof Error ? error.message : String(error);
      emitNarration(socket, `[ERROR] Step failed: ${msg}`);
    }

    const resultEvent: StepResultEvent = {
      type: "step_result",
      stepId: step.id,
      status: stepStatus,
      finding: stepStatus === "fail" ? "Step failed" : undefined,
      severity: stepStatus === "fail" ? "medium" : undefined,
    };
    socket.emit("event", resultEvent);
  }

  await closeBrowser();

  const reportId = `rpt-${sessionId}-${Date.now()}`;
  const completeEvent: SessionCompleteEvent = {
    type: "session_complete",
    reportId,
  };
  socket.emit("event", completeEvent);
  emitNarration(socket, "[OK] Session complete — all steps executed");
}

async function executeStep(
  socket: Socket,
  step: TestStep,
  targetUrl: string
): Promise<{ status: StepStatus; bug?: Bug }> {
  // 1. Take screenshot
  const screenshot = await takeScreenshot();
  socket.emit("event", {
    type: "screenshot",
    stepId: step.id,
    base64: screenshot,
    url: targetUrl,
  } as ScreenshotEvent);

  // 2. Get AOM snapshot
  const aom = await getAOMSnapshot();

  // 3. Ask Gemini what to do
  const action = await decideAction(screenshot, aom, step);
  emitNarration(
    socket,
    `[INFO] AI decided: ${action.action}${action.selector ? ` on "${action.selector}"` : ""} — ${action.reasoning}`
  );

  // 4. Generate narration
  const narration = await generateNarration(action);
  emitNarration(socket, `[INFO] ${narration}`);

  // 5. Inject DOM highlight for click/type actions
  if (action.selector && (action.action === "click" || action.action === "type")) {
    try {
      await injectHighlight(action.selector);
      const highlightScreenshot = await takeScreenshot();
      socket.emit("event", {
        type: "screenshot",
        stepId: step.id,
        base64: highlightScreenshot,
        url: targetUrl,
      } as ScreenshotEvent);
    } catch {
      // Highlight is cosmetic — don't fail the step
    }
  }

  // 6. Execute the action
  let actionError: string | null = null;
  try {
    await executeAction(action);
  } catch (error: unknown) {
    actionError = error instanceof Error ? error.message : String(error);
  }

  // 7. If action failed, attempt self-heal
  if (actionError) {
    emitNarration(socket, `[ERROR] Action failed: ${actionError}`);
    emitNarration(socket, "[INFO] Attempting self-heal...");

    const retryScreenshot = await takeScreenshot();
    socket.emit("event", {
      type: "screenshot",
      stepId: step.id,
      base64: retryScreenshot,
      url: targetUrl,
    } as ScreenshotEvent);

    const retryAom = await getAOMSnapshot();
    const healAction = await sendToolResponse(actionError, retryScreenshot, retryAom, step);

    try {
      await executeAction(healAction);
      emitNarration(socket, "[HEALED] Recovered from error with new approach");

      const verifyScreenshot = await takeScreenshot();
      socket.emit("event", {
        type: "screenshot",
        stepId: step.id,
        base64: verifyScreenshot,
        url: targetUrl,
      } as ScreenshotEvent);

      const verification = await verifyStep(verifyScreenshot, step.expectedBehavior);
      if (verification.passed) {
        emitNarration(socket, "[OK] Step verified after self-heal");
        return { status: "healed" };
      }

      emitNarration(
        socket,
        `[ERROR] Still failing after heal: ${verification.finding}`
      );
      return {
        status: "fail",
        bug: {
          id: `bug-${Date.now()}`,
          stepId: step.id,
          title: `Failed: ${step.text}`,
          description: verification.finding,
          severity: verification.severity ?? "medium",
          screenshotUrl: "",
          expectedBehavior: step.expectedBehavior,
          actualBehavior: verification.finding,
        },
      };
    } catch (retryError: unknown) {
      const retryMsg =
        retryError instanceof Error ? retryError.message : String(retryError);
      emitNarration(socket, `[ERROR] Self-heal failed: ${retryMsg}`);
      return {
        status: "fail",
        bug: {
          id: `bug-${Date.now()}`,
          stepId: step.id,
          title: `Failed: ${step.text}`,
          description: `Original: ${actionError}. Retry: ${retryMsg}`,
          severity: "high",
          screenshotUrl: "",
          expectedBehavior: step.expectedBehavior,
          actualBehavior: actionError,
        },
      };
    }
  }

  // 8. Action succeeded — wait for page to settle, then verify
  await new Promise((r) => setTimeout(r, 500));
  const verifyScreenshot = await takeScreenshot();
  socket.emit("event", {
    type: "screenshot",
    stepId: step.id,
    base64: verifyScreenshot,
    url: targetUrl,
  } as ScreenshotEvent);

  // 9. Gemini verification
  const verification = await verifyStep(verifyScreenshot, step.expectedBehavior);
  if (verification.passed) {
    emitNarration(socket, `[OK] Step passed: ${verification.finding}`);
    return { status: "pass" };
  }

  emitNarration(socket, `[ERROR] Verification failed: ${verification.finding}`);
  return {
    status: "fail",
    bug: {
      id: `bug-${Date.now()}`,
      stepId: step.id,
      title: `Failed: ${step.text}`,
      description: verification.finding,
      severity: verification.severity ?? "medium",
      screenshotUrl: "",
      expectedBehavior: step.expectedBehavior,
      actualBehavior: verification.finding,
    },
  };
}
