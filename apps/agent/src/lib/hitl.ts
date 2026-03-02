import { EventEmitter } from "events";
import type {
    HITLPauseReason,
    HITLDecision,
    HITLOption,
    HITLPauseEvent,
    HITLDecisionEvent,
    HITLLogEntry,
    ComputerUseAction,
} from "@verifai/types";
import type { Socket } from "socket.io";

// ─── Configuration ──────────────────────────────────────

export const HITL_CONFIG = {
    // Confidence threshold — actions below this trigger a pause
    actionConfidenceThreshold: parseFloat(process.env.HITL_ACTION_THRESHOLD || "0.7"),
    // Verification confidence threshold
    verifyConfidenceThreshold: parseFloat(process.env.HITL_VERIFY_THRESHOLD || "0.6"),
    // Whether HITL is enabled at all
    enabled: process.env.HITL_ENABLED !== "false", // Enabled by default
    // Maximum wait time for human decision (ms) — auto-proceeds after this
    maxWaitMs: parseInt(process.env.HITL_MAX_WAIT_MS || "120000"), // 2 minutes
};

// ─── Decision Emitter ───────────────────────────────────
// Per-socket emitter so multiple sessions don't interfere

const decisionEmitters = new Map<string, EventEmitter>();

function getEmitter(socketId: string): EventEmitter {
    if (!decisionEmitters.has(socketId)) {
        decisionEmitters.set(socketId, new EventEmitter());
    }
    return decisionEmitters.get(socketId)!;
}

export function cleanupEmitter(socketId: string) {
    decisionEmitters.delete(socketId);
}

// ─── Audit Log ──────────────────────────────────────────

const auditLogs = new Map<string, HITLLogEntry[]>(); // sessionId → logs

export function getAuditLog(sessionId: string): HITLLogEntry[] {
    return auditLogs.get(sessionId) || [];
}

export function clearAuditLog(sessionId: string) {
    auditLogs.delete(sessionId);
}

// ─── Register Decision Handler ──────────────────────────
// Called from index.ts when "hitl_decision" socket event arrives

export function registerDecision(socketId: string, decision: HITLDecisionEvent) {
    const emitter = getEmitter(socketId);
    emitter.emit(`decision:${decision.pauseId}`, decision);
}

// ─── Pause and Wait for Human Decision ──────────────────

export async function pauseForHuman(
    socket: Socket,
    sessionId: string,
    opts: {
        stepId: string;
        stepText: string;
        reason: HITLPauseReason;
        question: string;
        screenshotBase64: string;
        suggestedAction?: ComputerUseAction;
        confidence: number;
    }
): Promise<HITLDecisionEvent> {
    const pauseId = `hitl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const pausedAt = new Date().toISOString();

    // Build context-appropriate options
    const options = buildOptions(opts.reason);

    // Emit pause event to frontend
    const pauseEvent: HITLPauseEvent = {
        type: "hitl_pause",
        pauseId,
        stepId: opts.stepId,
        stepText: opts.stepText,
        reason: opts.reason,
        question: opts.question,
        screenshotBase64: opts.screenshotBase64,
        suggestedAction: opts.suggestedAction
            ? {
                type: opts.suggestedAction.type as any,
                coordinate: opts.suggestedAction.coordinate,
                text: opts.suggestedAction.text,
                reasoning: opts.suggestedAction.reasoning,
            }
            : undefined,
        confidence: opts.confidence,
        options,
        timestamp: pausedAt,
    };

    socket.emit("event", pauseEvent);

    // Emit narration
    socket.emit("event", {
        type: "narration",
        text: `[HITL] ⏸ Paused: ${opts.question} (confidence: ${Math.round(opts.confidence * 100)}%)`,
        timestamp: pausedAt,
    });

    console.log(`[HITL] Paused session ${sessionId} at step ${opts.stepId}: ${opts.reason} (confidence: ${opts.confidence})`);

    // Wait for human decision or timeout
    const decision = await waitForDecision(socket.id, pauseId);
    const resumedAt = new Date().toISOString();

    // Log to audit trail
    const logEntry: HITLLogEntry = {
        pauseId,
        stepId: opts.stepId,
        reason: opts.reason,
        question: opts.question,
        confidence: opts.confidence,
        decision: decision.decision,
        humanNote: decision.humanNote,
        pausedAt,
        resumedAt,
        durationMs: new Date(resumedAt).getTime() - new Date(pausedAt).getTime(),
    };

    if (!auditLogs.has(sessionId)) auditLogs.set(sessionId, []);
    auditLogs.get(sessionId)!.push(logEntry);

    // Emit resume event
    socket.emit("event", {
        type: "hitl_resume",
        pauseId,
        decision: decision.decision,
    });

    socket.emit("event", {
        type: "narration",
        text: `[HITL] ▶ Resumed: Human chose "${decision.decision}"${decision.humanNote ? ` — "${decision.humanNote}"` : ""}`,
        timestamp: resumedAt,
    });

    console.log(`[HITL] Resumed: ${decision.decision} (took ${logEntry.durationMs}ms)`);

    return decision;
}

// ─── Wait for Decision (Promise) ────────────────────────

function waitForDecision(socketId: string, pauseId: string): Promise<HITLDecisionEvent> {
    return new Promise((resolve) => {
        const emitter = getEmitter(socketId);

        const timer = setTimeout(() => {
            emitter.removeAllListeners(`decision:${pauseId}`);
            // Auto-proceed after timeout
            resolve({
                type: "hitl_decision",
                pauseId,
                decision: "proceed",
                humanNote: "Auto-proceeded after timeout",
            });
        }, HITL_CONFIG.maxWaitMs);

        emitter.once(`decision:${pauseId}`, (decision: HITLDecisionEvent) => {
            clearTimeout(timer);
            resolve(decision);
        });
    });
}

// ─── Build Options Based on Reason ──────────────────────

function buildOptions(reason: HITLPauseReason): HITLOption[] {
    const baseOptions: HITLOption[] = [
        {
            decision: "proceed",
            label: "Proceed",
            description: "Continue with AI's suggested action",
            variant: "primary",
        },
        {
            decision: "skip",
            label: "Skip Step",
            description: "Mark as incomplete, move to next step",
            variant: "warning",
        },
    ];

    switch (reason) {
        case "low_confidence_action":
            return [
                ...baseOptions,
                {
                    decision: "retry",
                    label: "Re-analyze",
                    description: "Take fresh screenshot and try again",
                    variant: "secondary",
                },
                {
                    decision: "abort",
                    label: "Abort Session",
                    description: "Stop the entire test run",
                    variant: "danger",
                },
            ];

        case "unexpected_page_state":
            return [
                ...baseOptions,
                {
                    decision: "retry",
                    label: "Re-analyze",
                    description: "Page may have finished loading",
                    variant: "secondary",
                },
                {
                    decision: "abort",
                    label: "Abort",
                    variant: "danger",
                },
            ];

        case "verification_ambiguous":
            return [
                {
                    decision: "proceed",
                    label: "Mark as Passed",
                    description: "Human confirms the step succeeded",
                    variant: "primary",
                },
                {
                    decision: "skip",
                    label: "Mark as Failed",
                    description: "Human confirms this is a bug",
                    variant: "danger",
                },
                {
                    decision: "retry",
                    label: "Re-verify",
                    description: "Take new screenshot and verify again",
                    variant: "secondary",
                },
            ];

        case "destructive_action":
            return [
                {
                    decision: "proceed",
                    label: "Allow Action",
                    description: "Confirm it's safe to proceed",
                    variant: "warning",
                },
                {
                    decision: "skip",
                    label: "Skip",
                    description: "Don't perform this action",
                    variant: "secondary",
                },
                {
                    decision: "abort",
                    label: "Abort",
                    description: "Stop the session immediately",
                    variant: "danger",
                },
            ];

        case "authentication_required":
            return [
                {
                    decision: "proceed",
                    label: "I've Logged In",
                    description: "Manual login complete, continue",
                    variant: "primary",
                },
                {
                    decision: "skip",
                    label: "Skip Auth Steps",
                    variant: "warning",
                },
                {
                    decision: "abort",
                    label: "Abort",
                    variant: "danger",
                },
            ];

        default:
            return [
                ...baseOptions,
                { decision: "abort", label: "Abort", variant: "danger" },
            ];
    }
}

// ─── Confidence Check Helpers ───────────────────────────

export function shouldPauseForAction(action: ComputerUseAction): boolean {
    if (!HITL_CONFIG.enabled) return false;
    const confidence = action.confidence ?? 0.8;
    return confidence < HITL_CONFIG.actionConfidenceThreshold;
}

export function shouldPauseForVerification(verification: { confidence?: number }): boolean {
    if (!HITL_CONFIG.enabled) return false;
    const confidence = verification.confidence ?? 0.8;
    return confidence < HITL_CONFIG.verifyConfidenceThreshold;
}

export function classifyPauseReason(
    action: ComputerUseAction,
    context: { currentUrl?: string; stepText?: string }
): HITLPauseReason {
    // Check for destructive keywords
    const destructivePatterns = /delete|remove|cancel|terminate|unsubscribe|close account/i;
    if (destructivePatterns.test(action.reasoning || "") || destructivePatterns.test(context.stepText || "")) {
        return "destructive_action";
    }

    // Check for auth-related keywords
    const authPatterns = /login|sign.?in|auth|password|credential|sso|oauth/i;
    if (authPatterns.test(action.reasoning || "") && (action.confidence ?? 0.8) < 0.5) {
        return "authentication_required";
    }

    return "low_confidence_action";
}

export function generateQuestion(
    reason: HITLPauseReason,
    action: ComputerUseAction,
    stepText: string
): string {
    switch (reason) {
        case "low_confidence_action":
            return `I'm ${Math.round((action.confidence ?? 0) * 100)}% confident about this action. ` +
                `I want to ${action.type}${action.coordinate ? ` at (${action.coordinate[0]}, ${action.coordinate[1]})` : ""}` +
                `${action.text ? ` with text "${action.text.slice(0, 30)}"` : ""}. ` +
                `Does this look correct for: "${stepText}"?`;

        case "unexpected_page_state":
            return `The page doesn't look like what I expected for step: "${stepText}". ` +
                `Should I try to proceed anyway, or should we skip this step?`;

        case "verification_ambiguous":
            return `I'm not sure if this step passed or failed. ` +
                `Can you check the screenshot and tell me: did "${stepText}" succeed?`;

        case "destructive_action":
            return `This action might have permanent consequences. ` +
                `I want to ${action.type}${action.text ? ` "${action.text.slice(0, 30)}"` : ""}. ` +
                `Should I proceed?`;

        case "authentication_required":
            return `I've detected a login page or authentication wall. ` +
                `I can't enter credentials safely. Would you like to log in manually?`;

        default:
            return `I need your guidance on step: "${stepText}". How should I proceed?`;
    }
}
