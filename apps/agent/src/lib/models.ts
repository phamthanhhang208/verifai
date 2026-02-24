// Multi-model router with per-model rate limiting + skip-on-exhaustion
//
// Free tier limits:
//   gemini-3-flash:        5 RPM  (Computer Use — action decisions)
//   gemini-2.5-flash-lite: 10 RPM (verification, narration, bug gen, spec parsing)
//   gemini-2.5-flash:      5 RPM  (fallback for complex reasoning)
//   gemini-2.5-flash-tts:  3 RPM  (voice — stretch goal)

// ─── Model Configuration ────────────────────────────────
export const MODELS = {
  vision: "gemini-3-flash-preview", // Computer Use / action decisions — 5 RPM
  lite: "gemini-2.5-flash-lite", // verification, narration, bug gen, spec parsing — 10 RPM
  flash: "gemini-2.5-flash", // fallback for complex reasoning — 5 RPM
  tts: "gemini-2.5-flash-tts-preview",
} as const;

// ─── Typed error for exhausted rate limits ───────────────
// Thrown by callGeminiWithBackoff when all retries are exhausted.
// Caught in session.ts to mark the step as "skipped" instead of "fail".
export class GeminiRateLimitError extends Error {
  constructor(model: string) {
    super(`Gemini rate limit exhausted for ${model} after retries`);
    this.name = "GeminiRateLimitError";
  }
}

// ─── Minimum delay between Gemini calls ─────────────────
// Prevents bursting through free tier RPM. All calls are sequential.
const GEMINI_CALL_DELAY_MS = parseInt(
  process.env.GEMINI_CALL_DELAY_MS || "2000",
);
let lastCallTimestamp = 0;

async function enforceMinDelay(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastCallTimestamp;
  if (elapsed < GEMINI_CALL_DELAY_MS) {
    const wait = GEMINI_CALL_DELAY_MS - elapsed;
    await new Promise((r) => setTimeout(r, wait));
  }
  lastCallTimestamp = Date.now();
}

// ─── Per-model RPM tracking ─────────────────────────────
const callTimestamps = new Map<string, number[]>();

export async function waitForRateLimit(model: string): Promise<void> {
  const rpmLookup: Record<string, number> = {
    [MODELS.vision]: 5,
    [MODELS.lite]: 10,
    [MODELS.flash]: 5,
    [MODELS.tts]: 3,
  };
  const rpm = rpmLookup[model] ?? 5;
  const windowMs = 60_000;
  const now = Date.now();

  if (!callTimestamps.has(model)) callTimestamps.set(model, []);
  const stamps = callTimestamps.get(model)!;

  // Evict old entries
  while (stamps.length > 0 && stamps[0] < now - windowMs) stamps.shift();

  if (stamps.length >= rpm) {
    const delay = stamps[0] + windowMs - now + 200;
    console.log(
      `[RateLimit] ${model}: ${stamps.length}/${rpm} RPM — pre-waiting ${Math.round(delay / 1000)}s`,
    );
    await new Promise((r) => setTimeout(r, delay));
    const nowAfter = Date.now();
    while (stamps.length > 0 && stamps[0] < nowAfter - windowMs) stamps.shift();
  }

  stamps.push(Date.now());
}

// ─── The universal Gemini call wrapper ──────────────────
// Retries up to 3 times with backoff on 429.
// If all retries exhausted → throws GeminiRateLimitError (step gets skipped).
// Never pauses the session — caller decides what to do with the error.

export async function callGeminiWithBackoff<T>(
  fn: () => Promise<T>,
  ctx: { model: string; socket?: any; abortSignal?: { aborted: boolean } },
): Promise<T> {
  // Bail immediately (silently) if the session that owns this call has ended.
  const checkAbort = () => {
    if (ctx.abortSignal?.aborted) throw new GeminiRateLimitError(ctx.model);
  };

  // 1. Enforce minimum delay
  await enforceMinDelay();
  checkAbort();

  // 2. Wait for RPM capacity
  await waitForRateLimit(ctx.model);
  checkAbort();

  // 3. Attempt 1
  try {
    return await fn();
  } catch (err: any) {
    if (!is429(err)) throw err;
    checkAbort(); // Don't warn/sleep if session already ended
    console.warn(`[RateLimit] 429 from ${ctx.model} — waiting 5s, retry #1`);
    console.warn(`[RateLimit] Full error:`, err?.message ?? err);
    emitTranscriptWarn(
      ctx.socket,
      `Rate limit hit on ${ctx.model}. Retrying in 5s...`,
    );
  }

  // 4. Attempt 2: wait 5s (exits early if session is aborted)
  await abortableSleep(5000, ctx.abortSignal);
  checkAbort(); // Bail before next API call if session ended
  await waitForRateLimit(ctx.model);
  try {
    return await fn();
  } catch (err: any) {
    if (!is429(err)) throw err;
    checkAbort();
    console.warn(
      `[RateLimit] 429 again from ${ctx.model} — waiting 15s, retry #2`,
    );
    console.warn(`[RateLimit] Full error:`, err?.message ?? err);
    emitTranscriptWarn(ctx.socket, `Rate limit persists. Retrying in 15s...`);
  }

  // 5. Attempt 3: wait 15s (exits early if session is aborted)
  await abortableSleep(15000, ctx.abortSignal);
  checkAbort(); // Bail before next API call if session ended
  await waitForRateLimit(ctx.model);
  try {
    return await fn();
  } catch (err: any) {
    if (!is429(err)) throw err;
    // All retries exhausted — throw typed error, step will be skipped
    console.error(
      `[RateLimit] ${ctx.model} still 429 after all retries — skipping step`,
    );
    console.error(`[RateLimit] Full error:`, err?.message ?? err);
    emitTranscriptWarn(
      ctx.socket,
      `Rate limit exhausted on ${ctx.model}. Skipping this step.`,
    );
    throw new GeminiRateLimitError(ctx.model);
  }
}

// ─── Helpers ────────────────────────────────────────────

// Sleeps for `ms` milliseconds but resolves early (within ~50ms) if
// abortSignal.aborted becomes true. This lets retry backoffs cancel immediately
// when a step is skipped or the session ends, rather than waiting the full delay.
function abortableSleep(
  ms: number,
  abortSignal?: { aborted: boolean },
): Promise<void> {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      if (abortSignal?.aborted) return resolve();
      if (Date.now() - start >= ms) return resolve();
      setTimeout(tick, 50);
    };
    tick();
  });
}

function is429(err: any): boolean {
  const msg = err?.message || "";
  return (
    msg.includes("429") ||
    msg.includes("RESOURCE_EXHAUSTED") ||
    msg.includes("rate")
  );
}

function emitTranscriptWarn(socket: any, text: string) {
  socket?.emit?.("event", {
    type: "narration",
    text: `[WARN] ${text}`,
    timestamp: new Date().toISOString(),
  });
}

// ─── Legacy withRetry (used by gemini.ts fallback paths) ────────────────────

export async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  maxRetries = 2,
): Promise<T> {
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      const backoff = is429(err) ? (attempt + 1) * 15_000 : 1_000;
      console.warn(
        `[Gemini] ${label} attempt ${attempt + 1}/${maxRetries + 1}: ${err.message}`,
      );
      console.warn(`[Gemini] ${label} full error:`, err?.message ?? err);
      if (attempt < maxRetries)
        await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw lastErr!;
}
