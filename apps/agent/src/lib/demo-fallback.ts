// Pre-recorded session results for SauceDemo
// Set DEMO_FALLBACK=true in env to enable
// Record real data by running a session and copying the step results

export const DEMO_FALLBACK_ENABLED = process.env.DEMO_FALLBACK === "true";

export interface DemoStep {
  stepId: string;
  status: "passed" | "failed" | "incomplete";
  delay: number; // ms to simulate execution time
  narration: string;
  finding?: string;
  severity?: "high" | "medium" | "low";
}

export const demoStepResults: DemoStep[] = [
  {
    stepId: "s1",
    status: "passed",
    delay: 3000,
    narration: "Navigated to login page — form is visible",
  },
  {
    stepId: "s2",
    status: "passed",
    delay: 2500,
    narration: "Entered username 'standard_user'",
  },
  {
    stepId: "s3",
    status: "passed",
    delay: 2500,
    narration: "Entered password",
  },
  {
    stepId: "s4",
    status: "passed",
    delay: 2000,
    narration: "Clicked Login — redirected to inventory",
  },
  {
    stepId: "s5",
    status: "failed",
    delay: 3500,
    narration: "Add to cart button unresponsive",
    finding: "Cart badge did not update after clicking Add to Cart",
    severity: "high",
  },
  {
    stepId: "s6",
    status: "passed",
    delay: 2000,
    narration: "Navigated to cart page",
  },
  {
    stepId: "s7",
    status: "failed",
    delay: 3000,
    narration: "Checkout total shows $0.00",
    finding: "Checkout displays $0.00 instead of expected $29.99",
    severity: "high",
  },
];

// To use: in session.ts, if DEMO_FALLBACK_ENABLED, loop through demoStepResults
// with delays instead of running the real vision loop.
// Pre-capture real screenshots from a successful run and store as base64 or GCS URLs.
