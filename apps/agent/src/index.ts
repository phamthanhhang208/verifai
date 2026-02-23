import "dotenv/config";
import express from "express";
import { createServer } from "http";
import { Server as SocketIOServer } from "socket.io";
import cors from "cors";
import type { TestPlan } from "@verifai/types";
import { runSession } from "./routes/session.js";

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

// In-memory session store — TODO: Replace with Redis in production
const sessions = new Map<string, { status: string; startedAt: string }>();

io.on("connection", (socket) => {
  console.log(`[Socket] Client connected: ${socket.id}`);

  // Per-connection skip signal — shared between event handler and running session
  const skipSignal = new Set<string>();

  socket.on("session:skip_step", (data: { stepId: string }) => {
    console.log(`[Session] Skip requested for step: ${data.stepId}`);
    skipSignal.add(data.stepId);
  });

  // ── Full session start ──────────────────────────────
  socket.on(
    "session:start",
    async (data: { testPlan: TestPlan; targetUrl: string }) => {
      const sessionId = `session-${Date.now()}`;
      sessions.set(sessionId, {
        status: "running",
        startedAt: new Date().toISOString(),
      });

      console.log(`[Session] Starting ${sessionId} for ${data.targetUrl}`);

      try {
        await runSession(socket, sessionId, data.testPlan, data.targetUrl, skipSignal);
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
      }
    }
  );

  // ── Retry only the skipped steps ────────────────────
  socket.on(
    "session:retry_skipped",
    async (data: { testPlan: TestPlan; targetUrl: string; skippedStepIds: string[] }) => {
      const sessionId = `retry-${Date.now()}`;
      sessions.set(sessionId, {
        status: "running",
        startedAt: new Date().toISOString(),
      });

      console.log(`[Session] Retrying ${data.skippedStepIds.length} skipped steps for ${data.targetUrl}`);

      try {
        // Build a filtered plan with only the steps that were skipped
        const retryPlan: TestPlan = {
          ...data.testPlan,
          steps: data.testPlan.steps
            .filter((s) => data.skippedStepIds.includes(s.id))
            .map((s) => ({ ...s, status: "pending" as const })),
        };
        await runSession(socket, sessionId, retryPlan, data.targetUrl, skipSignal);
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
  console.log(`[Models] Vision:  gemini-3-flash-preview (Computer Use, 5 RPM)`);
  console.log(`[Models] Lite:    gemini-2.5-flash-lite (verify/narrate, 10 RPM)`);
});
