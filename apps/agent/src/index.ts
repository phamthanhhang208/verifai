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
        await runSession(socket, sessionId, data.testPlan, data.targetUrl);
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

  socket.on("disconnect", () => {
    console.log(`[Socket] Client disconnected: ${socket.id}`);
  });
});

const PORT = parseInt(process.env.PORT || "3001");
server.listen(PORT, () => {
  console.log(`[Verifai Agent] Running on port ${PORT}`);
});
