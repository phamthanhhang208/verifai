// Multi-model router with per-model rate limiting
//
// Free tier limits:
//   gemini-3-flash-preview:    5 RPM  (Computer Use — action decisions)
//   gemini-2.5-flash-lite:    10 RPM  (verification, narration, bug gen)
//   gemini-2.5-flash-tts:     3 RPM  (voice — stretch goal)

export const MODELS = {
  vision: "gemini-3-flash-preview",
  lite: "gemini-2.5-flash-lite",
  tts: "gemini-2.5-flash-tts-preview",
} as const;

const callTimestamps = new Map<string, number[]>();

export async function waitForRateLimit(model: string): Promise<void> {
  const rpmLookup: Record<string, number> = {
    [MODELS.vision]: 5,
    [MODELS.lite]: 10,
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
    console.log(`[RateLimit] ${model}: ${stamps.length}/${rpm} RPM — waiting ${Math.round(delay / 1000)}s`);
    await new Promise((r) => setTimeout(r, delay));
    const nowAfter = Date.now();
    while (stamps.length > 0 && stamps[0] < nowAfter - windowMs) stamps.shift();
  }

  stamps.push(Date.now());
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  maxRetries = 2
): Promise<T> {
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      const is429 = err.message?.includes("429") || err.message?.includes("RESOURCE_EXHAUSTED");
      const backoff = is429 ? (attempt + 1) * 15_000 : 1_000;
      console.warn(`[Gemini] ${label} attempt ${attempt + 1}/${maxRetries + 1} failed: ${err.message}`);
      if (attempt < maxRetries) await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw lastErr!;
}
