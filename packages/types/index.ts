// ─── Step & Plan ───────────────────────────────────────
export type StepStatus = "pending" | "running" | "pass" | "fail" | "healed";

export interface TestStep {
  id: string;
  text: string;
  expectedBehavior: string;
  targetElement?: string;
  status: StepStatus;
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
  jiraTicketUrl?: string;
  jiraTicketKey?: string;
}

export interface BugReport {
  id: string;
  testPlanId: string;
  sourceTicket: string;
  targetUrl: string;
  steps: TestStep[];
  bugs: Bug[];
  totalSteps: number;
  passedSteps: number;
  failedSteps: number;
  healedSteps: number;
  passRate: number;
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
}

export interface ErrorEvent {
  type: "error";
  message: string;
  stepId?: string;
}

export type SocketEvent =
  | StepStartEvent
  | StepResultEvent
  | ScreenshotEvent
  | NarrationEvent
  | SessionCompleteEvent
  | ErrorEvent;

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
