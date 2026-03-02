import "dotenv/config";
import express from "express";
import { createServer } from "http";
import { Server as SocketIOServer } from "socket.io";
import cors from "cors";
import type { TestPlan } from "@verifai/types";
import { runSession } from "./routes/session.js";
import { handleGeneratePlan } from "./routes/plan.js";

const app = express();
const server = createServer(app);

const io = new SocketIOServer(server, {
  cors: {
    origin: process.env.CORS_ORIGIN || "http://localhost:3000",
    methods: ["GET", "POST"],
  },
  pingTimeout: 120000,
  pingInterval: 25000,
});

app.use(cors());
app.use(express.json());

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "verifai-agent" });
});

// Test plan generation — POST /api/plan
app.post("/api/plan", handleGeneratePlan);

// In-memory session store — TODO: Replace with Redis in production
const sessions = new Map<string, { status: string; startedAt: string }>();

io.on("connection", (socket) => {
  console.log(`[Socket] Client connected: ${socket.id}`);

  // Per-connection signals — shared between event handlers and the running session
  const skipSignal = new Set<string>();
  const pauseSignal = { paused: false };
  let abortCurrentSession: (() => void) | null = null;

  socket.on("session:skip_step", (data: { stepId: string }) => {
    console.log(`[Session] Skip requested for step: ${data.stepId}`);
    skipSignal.add(data.stepId);
  });

  socket.on("session:pause", () => {
    if (!pauseSignal.paused) {
      pauseSignal.paused = true;
      console.log(`[Session] Paused`);
      socket.emit("event", {
        type: "narration",
        text: "[INFO] Session paused — will continue after current step completes",
        timestamp: new Date().toISOString(),
      });
    }
  });

  socket.on("session:resume", () => {
    if (pauseSignal.paused) {
      pauseSignal.paused = false;
      console.log(`[Session] Resumed`);
      socket.emit("event", {
        type: "narration",
        text: "[INFO] Session resumed",
        timestamp: new Date().toISOString(),
      });
    }
  });

  socket.on("session:abort", () => {
    console.log(`[Session] Abort requested`);
    pauseSignal.paused = false; // Unblock any pause wait so abort propagates immediately
    abortCurrentSession?.();
    abortCurrentSession = null;
  });

  // ── Full session start ──────────────────────────────
  socket.on(
    "session:start",
    async (data: { testPlan: TestPlan; targetUrl: string; geminiApiKey?: string }) => {
      const sessionId = `session-${Date.now()}`;
      sessions.set(sessionId, {
        status: "running",
        startedAt: new Date().toISOString(),
      });

      // Reset pause state for the new session
      pauseSignal.paused = false;
      const abort = { aborted: false };
      abortCurrentSession = () => { abort.aborted = true; };

      const keyInfo = data.geminiApiKey
        ? `user key (${data.geminiApiKey.slice(0, 4)}...${data.geminiApiKey.slice(-4)})`
        : "server env key";
      console.log(`[Session] Starting ${sessionId} for ${data.targetUrl} — API key: ${keyInfo}`);

      try {
        await runSession(socket, sessionId, data.testPlan, data.targetUrl, skipSignal, data.geminiApiKey, pauseSignal, abort);
        sessions.set(sessionId, {
          status: "complete",
          startedAt: sessions.get(sessionId)!.startedAt,
        });
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`[Session] Error in ${sessionId}:`, error);
        socket.emit("event", {
          type: "error",
          message: msg || "Session failed unexpectedly",
        });
        sessions.set(sessionId, {
          status: "error",
          startedAt: sessions.get(sessionId)!.startedAt,
        });
      } finally {
        abortCurrentSession = null;
      }
    }
  );

  // ── Retry only the skipped steps ────────────────────
  socket.on(
    "session:retry_skipped",
    async (data: { testPlan: TestPlan; targetUrl: string; skippedStepIds: string[]; geminiApiKey?: string }) => {
      const sessionId = `retry-${Date.now()}`;
      sessions.set(sessionId, {
        status: "running",
        startedAt: new Date().toISOString(),
      });

      pauseSignal.paused = false;
      const abort = { aborted: false };
      abortCurrentSession = () => { abort.aborted = true; };

      console.log(`[Session] Retrying ${data.skippedStepIds.length} skipped steps for ${data.targetUrl}`);

      try {
        // Build a filtered plan with only the steps that were skipped
        const retryPlan: TestPlan = {
          ...data.testPlan,
          steps: data.testPlan.steps
            .filter((s) => data.skippedStepIds.includes(s.id))
            .map((s) => ({ ...s, status: "pending" as const })),
        };
        await runSession(socket, sessionId, retryPlan, data.targetUrl, skipSignal, data.geminiApiKey, pauseSignal, abort);
        sessions.set(sessionId, {
          status: "complete",
          startedAt: sessions.get(sessionId)!.startedAt,
        });
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`[Session] Retry error in ${sessionId}:`, error);
        socket.emit("event", { type: "error", message: msg });
        sessions.set(sessionId, {
          status: "error",
          startedAt: sessions.get(sessionId)!.startedAt,
        });
      } finally {
        abortCurrentSession = null;
      }
    }
  );

  socket.on("disconnect", () => {
    console.log(`[Socket] Client disconnected: ${socket.id}`);
  });
});

const PORT = parseInt(process.env.PORT || "3001");
server.listen(PORT, () => {
  console.log(`[Verifai Agent] Running on port ${PORT}`);
  console.log(`[Models] Vision:  gemini-3-flash (Computer Use — interaction + DOM decisions)`);
  console.log(`[Models] Flash:   gemini-2.5-flash (Fallback reasoning + error recovery)`);
  console.log(`[Models] Lite:    gemini-2.5-flash-lite (Summarization, verification, parsing)`);
});
