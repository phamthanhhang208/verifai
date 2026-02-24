"use client";

import { useEffect, useRef, useState } from "react";
import {
  Circle,
  CheckCircle2,
  XCircle,
  Loader2,
  Play,
  Pause,
  RotateCcw,
  Terminal,
  Monitor,
  Mic,
  RefreshCw,
  SkipForward,
  AlertTriangle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { TestPlan, StepStatus } from "@verifai/types";

export type TranscriptLine = {
  text: string;
  timestamp: string;
  type: "info" | "error" | "success" | "warning";
};

interface ExecuteScreenProps {
  testPlan: TestPlan;
  onRunSession: () => void;
  onViewReport: () => void;
  onRetryIncomplete: () => void;
  onSkipStep: (stepId: string) => void;
  onRetryStep: (stepId: string) => void;
  onPause: () => void;
  onResume: () => void;
  onReset: () => void;
  userIncompleteStepIds: string[];
  isRunning: boolean;
  isPaused: boolean;
  isComplete: boolean;
  currentScreenshot: string | null;
  currentUrl: string;
  transcriptLines: TranscriptLine[];
  incompleteStepIds: string[];
  isLoadingReport: boolean;
}

function StatusIcon({ status }: { status: StepStatus }) {
  switch (status) {
    case "pending":
      return <Circle className="w-4 h-4 text-gray-600 shrink-0 mt-0.5" />;
    case "running":
      return <Loader2 className="w-4 h-4 text-indigo-500 shrink-0 mt-0.5 animate-spin" />;
    case "passed":
      return <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0 mt-0.5" />;
    case "failed":
      return <XCircle className="w-4 h-4 text-rose-500 shrink-0 mt-0.5" />;
    case "incomplete":
      return <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />;
  }
}

const TRANSCRIPT_PREFIX: Record<TranscriptLine["type"], string> = {
  info: "",
  error: "[ERROR] ",
  success: "[OK] ",
  warning: "[WARN] ",
};

const TRANSCRIPT_COLOR: Record<TranscriptLine["type"], string> = {
  info: "text-gray-300",
  error: "text-rose-400",
  success: "text-emerald-400",
  warning: "text-amber-400",
};

const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 560;
const TRANSCRIPT_MIN = 80;
const TRANSCRIPT_MAX = 480;

export default function ExecuteScreen({
  testPlan,
  onRunSession,
  onViewReport,
  onRetryIncomplete,
  onSkipStep,
  onRetryStep,
  onPause,
  onResume,
  onReset,
  userIncompleteStepIds,
  isRunning,
  isPaused,
  isComplete,
  currentScreenshot,
  currentUrl,
  transcriptLines,
  incompleteStepIds,
  isLoadingReport,
}: ExecuteScreenProps) {
  const transcriptEndRef = useRef<HTMLDivElement>(null);
  const [stepTexts, setStepTexts] = useState<Record<string, string>>(
    () => testPlan.steps.reduce((acc, s) => ({ ...acc, [s.id]: s.text }), {} as Record<string, string>)
  );

  const [sidebarWidth, setSidebarWidth] = useState(320);
  const [transcriptHeight, setTranscriptHeight] = useState(192);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcriptLines]);

  const isEditable = !isRunning && !isComplete;
  const activeStepId = testPlan.steps.find((s) => s.status === "running")?.id;
  const hasIncomplete = isComplete && incompleteStepIds.length > 0;

  const startSidebarResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = sidebarWidth;
    const onMouseMove = (ev: MouseEvent) => {
      setSidebarWidth(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, startWidth + ev.clientX - startX)));
    };
    const onMouseUp = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  };

  const startTranscriptResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = transcriptHeight;
    const onMouseMove = (ev: MouseEvent) => {
      setTranscriptHeight(Math.min(TRANSCRIPT_MAX, Math.max(TRANSCRIPT_MIN, startHeight - (ev.clientY - startY))));
    };
    const onMouseUp = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  };

  return (
    <div className="flex h-[calc(100vh-64px)] overflow-hidden">
      {/* LEFT PANEL */}
      <div className="flex flex-col bg-surface-card shrink-0" style={{ width: sidebarWidth }}>
        {/* Panel header */}
        <div className="px-4 py-4 border-b border-gray-800 flex items-center justify-between shrink-0">
          <span className="text-xs font-semibold tracking-widest uppercase text-gray-400">
            Test Plan Scenario
          </span>
          <span className="text-xs bg-gray-800 text-gray-400 px-2 py-0.5 rounded-full">
            {testPlan.steps.length} steps
          </span>
        </div>

        {/* Steps list */}
        <div className="flex-1 overflow-y-auto">
          {testPlan.steps.map((step) => {
            const isActive = step.id === activeStepId;
            const isIncomplete = step.status === "incomplete";
            const isFailed = step.status === "failed";
            return (
              <div
                key={step.id}
                className={cn(
                  "flex items-start gap-3 px-4 py-3 border-l-2 border-transparent transition-colors",
                  isActive && "bg-indigo-500/10 border-indigo-500",
                  isIncomplete && "bg-amber-500/5 border-amber-500/30",
                  isFailed && "bg-rose-500/5 border-rose-500/30"
                )}
              >
                <StatusIcon status={step.status} />
                <div className="flex-1 min-w-0">
                  {isEditable ? (
                    <textarea
                      value={stepTexts[step.id] ?? step.text}
                      onChange={(e) => {
                        setStepTexts((prev) => ({ ...prev, [step.id]: e.target.value }));
                        e.target.style.height = "auto";
                        e.target.style.height = e.target.scrollHeight + "px";
                      }}
                      rows={1}
                      className="w-full bg-transparent text-sm text-gray-300 focus:outline-none focus:text-white leading-relaxed resize-none overflow-hidden"
                      style={{ height: "auto" }}
                      ref={(el) => {
                        if (el) { el.style.height = "auto"; el.style.height = el.scrollHeight + "px"; }
                      }}
                    />
                  ) : (
                    <div className="flex items-start justify-between gap-2 min-w-0">
                      <span
                        className={cn(
                          "text-sm leading-relaxed flex-1",
                          isIncomplete ? "text-amber-500/70" : "text-gray-300",
                          (step.status === "passed" || step.status === "failed") &&
                          "line-through text-gray-500"
                        )}
                      >
                        {step.text}
                      </span>
                      {/* Skip button — only on active running step */}
                      {isRunning && isActive && (
                        <button
                          onClick={() => onSkipStep(step.id)}
                          className="shrink-0 text-xs text-amber-400/60 hover:text-amber-400 border border-amber-500/20 hover:border-amber-500/40 px-2 py-0.5 rounded transition-colors"
                        >
                          <SkipForward className="w-3 h-3 inline mr-1" />
                          Skip
                        </button>
                      )}
                      {/* Per-step retry — after completion, for incomplete or failed steps */}
                      {isComplete && (step.status === "incomplete" || step.status === "failed") && (
                        <button
                          onClick={() => onRetryStep(step.id)}
                          className="shrink-0 text-xs text-indigo-400/60 hover:text-indigo-400 border border-indigo-500/20 hover:border-indigo-500/40 px-2 py-0.5 rounded transition-colors"
                        >
                          ↺ Retry
                        </button>
                      )}
                    </div>
                  )}
                  {/* Incomplete reason badge — system reason takes priority over user-skip label */}
                  {isIncomplete && (
                    <span className="mt-1 inline-block text-xs bg-amber-500/15 text-amber-400/80 border border-amber-500/20 px-1.5 py-0.5 rounded">
                      {step.incompleteReason === "rate_limit"
                        ? "⏭ Rate Limited"
                        : step.incompleteReason === "timeout"
                          ? "⏭ Timeout"
                          : step.incompleteReason === "crash"
                            ? "⏭ Step Error"
                            : userIncompleteStepIds.includes(step.id)
                              ? "⏭ Skipped by User"
                              : "⏭ Step Error"}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-gray-800 shrink-0 flex flex-col gap-2">
          {isComplete ? (
            <>
              <button
                onClick={onViewReport}
                disabled={isLoadingReport}
                className={cn(
                  "w-full flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-medium transition-colors",
                  isLoadingReport
                    ? "bg-gray-200 text-gray-500 cursor-wait"
                    : "bg-white text-gray-900 hover:bg-gray-100"
                )}
              >
                {isLoadingReport ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Loading Report...
                  </>
                ) : (
                  "View Detailed Report →"
                )}
              </button>
              {hasIncomplete && (
                <button
                  onClick={onRetryIncomplete}
                  className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg bg-amber-500/15 hover:bg-amber-500/25 text-amber-400 text-sm font-medium border border-amber-500/30 transition-colors"
                >
                  <RefreshCw className="w-4 h-4" />
                  Retry {incompleteStepIds.length} Incomplete Step{incompleteStepIds.length > 1 ? "s" : ""}
                </button>
              )}
              <button
                onClick={onReset}
                className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm font-medium transition-colors"
              >
                <RotateCcw className="w-4 h-4" />
                Reset All Steps
              </button>
            </>
          ) : isRunning ? (
            <>
              <div className="flex gap-2">
                {/* Pause / Resume toggle */}
                <button
                  onClick={isPaused ? onResume : onPause}
                  className={cn(
                    "flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-medium transition-colors",
                    isPaused
                      ? "bg-emerald-600 hover:bg-emerald-500 text-white"
                      : "bg-amber-500/15 hover:bg-amber-500/25 text-amber-400 border border-amber-500/30"
                  )}
                >
                  {isPaused ? <Play className="w-4 h-4" /> : <Pause className="w-4 h-4" />}
                  {isPaused ? "Resume" : "Pause"}
                </button>

                {/* Reset / Abort */}
                <button
                  onClick={onReset}
                  className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/20 text-sm font-medium transition-colors"
                >
                  <RotateCcw className="w-4 h-4" />
                  Reset
                </button>
              </div>

              {/* Paused indicator */}
              {isPaused && (
                <div className="text-center text-xs text-amber-400/70 py-1">
                  Session paused — will resume after current step
                </div>
              )}
            </>
          ) : (
            <button
              onClick={onRunSession}
              className={cn(
                "w-full flex items-center justify-center gap-2 py-2.5 rounded-lg",
                "bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors"
              )}
            >
              <Play className="w-4 h-4" />
              Run Autonomous Session
            </button>
          )}
        </div>
      </div>

      {/* SIDEBAR RESIZE HANDLE */}
      <div
        onMouseDown={startSidebarResize}
        className="w-1 shrink-0 bg-gray-800 hover:bg-indigo-500/50 cursor-col-resize transition-colors group relative"
        title="Drag to resize"
      >
        <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 flex flex-col items-center justify-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          {[0, 1, 2].map((i) => (
            <div key={i} className="w-0.5 h-0.5 rounded-full bg-indigo-400" />
          ))}
        </div>
      </div>

      {/* RIGHT PANEL */}
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        {/* Browser Viewport */}
        <div className="flex-1 flex flex-col min-h-0">
          {/* Browser chrome */}
          <div className="h-10 bg-[#1A1C20] border-b border-gray-800 flex items-center gap-3 px-4 shrink-0">
            <div className="flex items-center gap-1.5">
              <div className="w-2.5 h-2.5 rounded-full bg-rose-500/70" />
              <div className="w-2.5 h-2.5 rounded-full bg-amber-500/70" />
              <div className="w-2.5 h-2.5 rounded-full bg-emerald-500/70" />
            </div>
            <div className="flex-1 bg-[#0A0A0B] rounded-md px-3 py-1 text-xs text-gray-400 truncate">
              {currentUrl || "about:blank"}
            </div>
          </div>

          {/* Content area */}
          <div className="flex-1 bg-[#0A0A0B] relative overflow-hidden">
            {currentScreenshot ? (
              <img
                src={`data:image/png;base64,${currentScreenshot}`}
                alt="Browser screenshot"
                className="w-full h-full object-contain"
              />
            ) : (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
                <Monitor className="w-12 h-12 text-gray-700" />
                <span className="text-sm text-gray-500">Ready to start autonomous session</span>
              </div>
            )}

            {isRunning && (
              <div className="absolute inset-0 pointer-events-none">
                <div className="absolute top-1/2 left-0 right-0 h-px bg-indigo-500/30" />
                <div className="absolute left-1/2 top-0 bottom-0 w-px bg-indigo-500/30" />
              </div>
            )}

            <button
              className={cn(
                "absolute bottom-4 right-4 w-10 h-10 rounded-full flex items-center justify-center transition-all",
                isRunning ? "bg-indigo-500 animate-pulse" : "bg-[#1A1C20]"
              )}
            >
              <Mic className="w-4 h-4 text-white" />
            </button>
          </div>
        </div>

        {/* TRANSCRIPT RESIZE HANDLE */}
        <div
          onMouseDown={startTranscriptResize}
          className="h-1 shrink-0 bg-gray-800 hover:bg-indigo-500/50 cursor-row-resize transition-colors group relative"
          title="Drag to resize"
        >
          <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 flex items-center justify-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            {[0, 1, 2].map((i) => (
              <div key={i} className="w-0.5 h-0.5 rounded-full bg-indigo-400" />
            ))}
          </div>
        </div>

        {/* Agent Transcript */}
        <div
          className="flex flex-col border-gray-800 shrink-0"
          style={{ height: transcriptHeight }}
        >
          <div className="flex items-center gap-2 px-4 py-2 bg-[#1A1C20] border-b border-gray-800 shrink-0">
            <Terminal className="w-3.5 h-3.5 text-gray-400" />
            <span className="text-xs font-semibold tracking-widest uppercase text-gray-400">
              Agent Transcript
            </span>
          </div>

          <div className="flex-1 overflow-y-auto bg-[#0A0A0B] p-3 font-mono text-xs">
            {transcriptLines.length === 0 ? (
              <span className="text-gray-600">Waiting for session to start...</span>
            ) : (
              transcriptLines.map((line, i) => (
                <div key={i} className={cn("mb-0.5 leading-relaxed", TRANSCRIPT_COLOR[line.type])}>
                  <span className="text-gray-600 mr-2">[{line.timestamp}]</span>
                  {TRANSCRIPT_PREFIX[line.type]}
                  {line.text}
                </div>
              ))
            )}
            <div ref={transcriptEndRef} />
          </div>
        </div>
      </div>
    </div>
  );
}
