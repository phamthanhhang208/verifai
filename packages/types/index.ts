// ─── Step & Plan ───────────────────────────────────────

/** Tri-state step model:
 *  passed     — step executed and verified successfully
 *  failed     — Gemini verification says the expected behaviour didn't happen (real bug)
 *  incomplete — step could not be assessed due to infrastructure (rate limit, timeout, crash)
 */
export type StepStatus = "pending" | "running" | "passed" | "failed" | "incomplete";

/** Why a step could not complete — only set when status === "incomplete" */
export type IncompleteReason =
  | "rate_limit"  // Gemini 429 — model quota exhausted
  | "timeout"     // Playwright navigation/action timeout
  | "crash";      // Unexpected agent error or 60s step timer exceeded

/** Why a failed step failed — only set when status === "failed" */
export type FailureType =
  | "assertion"   // Gemini verification says expected outcome didn't occur
  | "timeout";    // Playwright wait timed out (counts as a product bug)

export interface TestStep {
  id: string;
  text: string;
  expectedBehavior: string;
  targetElement?: string;
  dependsOn?: string[];              // step IDs this step depends on — skipped if any dependency failed
  status: StepStatus;
  incompleteReason?: IncompleteReason; // set when status === "incomplete"
  failureType?: FailureType;           // set when status === "failed"
}

export interface TestPlan {
  id: string;
  sourceTicket: string;
  targetUrl: string;
  steps: TestStep[];
  createdAt: string;
}

// ─── Bugs & Reports ───────────────────────────────────
export type BugSeverity = "high" | "medium" | "low";

export interface Bug {
  id: string;
  stepId: string;
  title: string;
  description: string;
  severity: BugSeverity;
  screenshotUrl: string;
  expectedBehavior: string;
  actualBehavior: string;
  failureType?: FailureType;
  jiraTicketUrl?: string;
  jiraTicketKey?: string;
}

/** Overall session outcome:
 *  passed     — all steps passed, zero bugs
 *  failed     — one or more steps failed (bugs found)
 *  incomplete — no failures but some steps couldn't run (infrastructure issues)
 */
export type ReportStatus = "passed" | "failed" | "incomplete";

export interface BugReport {
  id: string;
  testPlanId: string;
  sourceTicket: string;
  targetUrl: string;
  steps: TestStep[];
  bugs: Bug[];
  reportStatus: ReportStatus;
  totalSteps: number;
  passedSteps: number;
  failedSteps: number;
  completedSteps: number;  // passedSteps + failedSteps (steps that actually ran)
  incompleteSteps: number; // steps that could not be assessed
  passRate: number;        // passedSteps / completedSteps * 100
  summary: string;         // human-readable one-liner
  createdAt: string;
  completedAt: string;
}

// ─── Session ───────────────────────────────────────────
export interface SessionState {
  id: string;
  testPlan: TestPlan;
  targetUrl: string;
  status: "idle" | "running" | "complete" | "error";
  currentStepIndex: number;
}

// ─── Socket Events ─────────────────────────────────────
export interface StepStartEvent {
  type: "step_start";
  stepId: string;
  stepIndex: number;
}

export interface StepResultEvent {
  type: "step_result";
  stepId: string;
  status: StepStatus;
  finding?: string;
  severity?: BugSeverity;
  failureType?: FailureType;
  incompleteReason?: IncompleteReason;
}

export interface ScreenshotEvent {
  type: "screenshot";
  stepId: string;
  base64: string;
  url: string;
}

export interface NarrationEvent {
  type: "narration";
  text: string;
  timestamp: string;
}

export interface SessionCompleteEvent {
  type: "session_complete";
  reportId: string;
  bugs?: Bug[];
}

export interface SessionAbortedEvent {
  type: "session_aborted";
}

export interface ErrorEvent {
  type: "error";
  message: string;
  stepId?: string;
}

export interface VoiceEvent {
  type: "voice";
  audio: string;       // base64-encoded audio
  mimeType: string;    // "audio/mp3" or "audio/wav" or "audio/pcm"
  text: string;        // the narration text (for accessibility / fallback)
}

export type SocketEvent =
  | StepStartEvent
  | StepResultEvent
  | ScreenshotEvent
  | NarrationEvent
  | SessionCompleteEvent
  | SessionAbortedEvent
  | ErrorEvent
  | VoiceEvent;

// ─── Jira ──────────────────────────────────────────────
export interface JiraTicket {
  key: string;
  summary: string;
  description: string;
  acceptanceCriteria?: string;
  url: string;
}

// ─── Gemini Tool Calls ─────────────────────────────────
export interface GeminiAction {
  action: "click" | "type" | "navigate" | "scroll" | "wait" | "assert";
  selector?: string;
  value?: string;
  reasoning: string;
}

export interface GeminiVerification {
  passed: boolean;
  finding: string;
  severity?: BugSeverity;
}

// ─── Computer Use Actions (Gemini 3 Flash native tool) ──
export interface ComputerUseAction {
  type: "click" | "type" | "scroll" | "wait" | "screenshot" | "navigate" | "key_press" | "drag";
  coordinate?: [number, number];     // [x, y] pixel coordinates
  text?: string;                     // For type actions
  key?: string;                      // For key_press (e.g., "Enter", "Tab")
  url?: string;                      // For navigate actions
  direction?: "up" | "down" | "left" | "right";
  reasoning?: string;
}

// ─── Model Configuration ────────────────────────────────
export interface ModelConfig {
  vision: string;
  lite: string;
  tts?: string;
}

// ─── Confluence ─────────────────────────────────────────
export interface ConfluencePage {
  id: string;
  title: string;
  spaceKey: string;
  body: string;           // Extracted plain text content
  url: string;
  lastUpdated: string;
  childPages?: ConfluencePage[];  // Optional child pages for hierarchical specs
}

export type SpecSource = "jira" | "confluence" | "manual";

export interface SpecInput {
  source: SpecSource;
  // Jira
  jiraTicketId?: string;
  // Confluence
  confluencePageUrl?: string;
  confluencePageId?: string;
  includeChildPages?: boolean;
  // Manual
  manualText?: string;
  // Common
  targetUrl: string;
}
