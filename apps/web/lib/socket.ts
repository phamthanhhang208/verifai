import { io, Socket } from "socket.io-client";
import type { SocketEvent } from "@verifai/types";

export type SocketEventHandler = (event: SocketEvent) => void;

class SocketClient {
  private socket: Socket | null = null;
  private handler: SocketEventHandler | null = null;

  connect(url: string) {
    // Disconnect any existing connection first
    this.disconnect();

    this.socket = io(url, {
      transports: ["websocket", "polling"],
    });

    this.socket.on("connect", () => {
      console.log("[Socket] Connected to agent");
    });

    this.socket.on("event", (event: SocketEvent) => {
      this.handler?.(event);
    });

    this.socket.on("disconnect", () => {
      console.log("[Socket] Disconnected from agent");
    });

    this.socket.on("connect_error", (err) => {
      console.error("[Socket] Connection error:", err.message);
    });
  }

  onEvent(handler: SocketEventHandler) {
    this.handler = handler;
  }

  emit(event: string, data: unknown) {
    this.socket?.emit(event, data);
  }

  disconnect() {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
  }
}

export const socket = new SocketClient();
