/**
 * Replays a recorded demo session by emitting events with original timing.
 * 
 * Usage:
 *   player.load(recording)              — load a recording
 *   player.play(handler, speed)         — start replay at given speed
 *   player.stop()                       — stop replay
 *   player.onComplete(callback)         — called when replay finishes
 */

import type { SocketEvent } from "@verifai/types";
import type { DemoRecording } from "./demo-recorder";

type EventHandler = (event: SocketEvent) => void;

class DemoPlayer {
    private recording: DemoRecording | null = null;
    private timers: ReturnType<typeof setTimeout>[] = [];
    private _playing = false;
    private _completeCb: (() => void) | null = null;

    get playing() {
        return this._playing;
    }

    load(recording: DemoRecording) {
        this.recording = recording;
        console.log(
            `[DemoPlayer] Loaded: ${recording.eventCount} events, ${Math.round(recording.totalDuration / 1000)}s`
        );
    }

    /**
     * @param handler — called for each event (same function as your socket event handler)
     * @param speed — playback speed multiplier. 1.0 = real time, 0.5 = 2x faster, 0.7 = recommended
     */
    play(handler: EventHandler, speed: number = 0.7) {
        if (!this.recording) {
            console.error("[DemoPlayer] No recording loaded");
            return;
        }

        this.stop(); // Clear any previous playback
        this._playing = true;

        const events = this.recording.events;
        let completed = 0;

        for (const recorded of events) {
            const delay = recorded.timestamp * speed;
            const timer = setTimeout(() => {
                if (!this._playing) return; // Stopped mid-replay
                handler(recorded.event);
                completed++;
                if (completed === events.length) {
                    this._playing = false;
                    this._completeCb?.();
                }
            }, delay);
            this.timers.push(timer);
        }

        console.log(
            `[DemoPlayer] Playing ${events.length} events at ${speed}x speed (${Math.round((this.recording.totalDuration * speed) / 1000)}s)`
        );
    }

    stop() {
        this._playing = false;
        for (const t of this.timers) clearTimeout(t);
        this.timers = [];
    }

    onComplete(cb: () => void) {
        this._completeCb = cb;
    }
}

export const demoPlayer = new DemoPlayer();
