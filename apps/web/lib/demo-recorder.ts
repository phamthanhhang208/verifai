/**
 * Records all socket events during a live session.
 * Events are stored with relative timestamps for replay.
 * 
 * Usage:
 *   recorder.start()           — begin recording
 *   recorder.record(event)     — capture each socket event
 *   recorder.stop()            — end recording, returns JSON
 *   recorder.download()        — triggers browser download of recording
 */

import type { SocketEvent } from "@verifai/types";

export interface RecordedEvent {
    timestamp: number;      // ms since recording started
    event: SocketEvent;
}

export interface DemoRecording {
    version: 1;
    recordedAt: string;     // ISO date
    targetUrl: string;
    totalDuration: number;  // ms
    eventCount: number;
    events: RecordedEvent[];
    testPlan?: any;  // TestPlan snapshot from recording time
}

class DemoRecorder {
    private events: RecordedEvent[] = [];
    private startTime = 0;
    private _recording = false;
    private _targetUrl = "";
    private _testPlan: any = undefined;

    get recording() {
        return this._recording;
    }

    start(targetUrl: string, testPlan?: any) {
        this.events = [];
        this.startTime = Date.now();
        this._recording = true;
        this._targetUrl = targetUrl;
        this._testPlan = testPlan;
        console.log("[DemoRecorder] Recording started");
    }

    record(event: SocketEvent) {
        if (!this._recording) return;

        // Deep clone the event to avoid mutation
        const cloned = JSON.parse(JSON.stringify(event));

        this.events.push({
            timestamp: Date.now() - this.startTime,
            event: cloned,
        });
    }

    stop(): DemoRecording {
        this._recording = false;
        const recording: DemoRecording = {
            version: 1,
            recordedAt: new Date().toISOString(),
            targetUrl: this._targetUrl,
            totalDuration: Date.now() - this.startTime,
            eventCount: this.events.length,
            events: this.events,
            testPlan: this._testPlan,
        };
        console.log(
            `[DemoRecorder] Recording stopped: ${this.events.length} events, ${Math.round(recording.totalDuration / 1000)}s`
        );
        return recording;
    }

    download() {
        const recording = this.stop();
        const blob = new Blob([JSON.stringify(recording, null, 2)], {
            type: "application/json",
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `verifai-demo-${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(url);
        console.log("[DemoRecorder] Recording downloaded");
    }
}

export const demoRecorder = new DemoRecorder();
