"use client";

import { useState, useEffect } from "react";
import type { TestPlan, BugReport, Bug } from "@verifai/types";
import { socket } from "@/lib/socket";
import Header from "@/components/Header";
import ConfigureScreen from "@/components/ConfigureScreen";
import ExecuteScreen, { type TranscriptLine } from "@/components/ExecuteScreen";
import ResultsScreen from "@/components/ResultsScreen";

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function classifyNarration(text: string): TranscriptLine["type"] {
  if (text.includes("[ERROR]")) return "error";
  if (text.includes("[OK]")) return "success";
  if (text.includes("[WARN]") || text.includes("[TIMEOUT]")) return "warning";
  return "info";
}

function stripPrefix(text: string): string {
  return text.replace(/^\[(ERROR|OK|INFO|WARN|TIMEOUT)\]\s*/, "");
}

export default function Home() {
  const [currentScreen, setCurrentScreen] = useState<1 | 2 | 3>(1);
  const [testPlan, setTestPlan] = useState<TestPlan | null>(null);
  const [report, setReport] = useState<BugReport | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [isComplete, setIsComplete] = useState(false);
  const [currentScreenshot, setCurrentScreenshot] = useState<string | null>(null);
  const [currentUrl, setCurrentUrl] = useState("about:blank");
  const [transcriptLines, setTranscriptLines] = useState<TranscriptLine[]>([]);
  const [reportId, setReportId] = useState<string | null>(null);
  const [incompleteStepIds, setIncompleteStepIds] = useState<string[]>([]);
  const [userIncompleteStepIds, setUserIncompleteStepIds] = useState<string[]>([]);
  const [collectedBugs, setCollectedBugs] = useState<Bug[]>([]);
  const [configureError, setConfigureError] = useState<string | null>(null);
  const [geminiApiKey, setGeminiApiKey] = useState("");
  const [isPaused, setIsPaused] = useState(false);
  const [isLoadingReport, setIsLoadingReport] = useState(false);

  // Hydrate Gemini key from localStorage after mount
  useEffect(() => {
    const stored = localStorage.getItem("verifai_gemini_key") ?? "";
    setGeminiApiKey(stored);
  }, []);

  const handleGeminiKeyChange = (key: string) => {
    setGeminiApiKey(key);
    localStorage.setItem("verifai_gemini_key", key);
  };

  // Shared socket event handler — used by both initial run and retry
  const attachSocketHandler = () => {
    socket.onEvent((event) => {
      switch (event.type) {
        case "step_start":
          setTestPlan((prev) => {
            if (!prev) return prev;
            return {
              ...prev,
              steps: prev.steps.map((s) =>
                s.id === event.stepId ? { ...s, status: "running" as const } : s
              ),
            };
          });
          break;

        case "step_result":
          setTestPlan((prev) => {
            if (!prev) return prev;
            return {
              ...prev,
              steps: prev.steps.map((s) =>
                s.id === event.stepId
                  ? {
                    ...s,
                    status: event.status,
                    incompleteReason: event.incompleteReason,
                    failureType: event.failureType,
                  }
                  : s
              ),
            };
          });
          if (event.status === "incomplete") {
            setIncompleteStepIds((prev) => [...prev, event.stepId]);
          }
          // Collect bugs from failed steps for local report fallback
          if (event.status === "failed" && event.finding) {
            setCollectedBugs((prev) => [
              ...prev,
              {
                id: `bug-${Date.now()}-${event.stepId}`,
                stepId: event.stepId,
                title: `Failed step`,
                description: event.finding!,
                severity: event.severity || "medium",
                screenshotUrl: "",
                expectedBehavior: "",
                actualBehavior: event.finding!,
                failureType: event.failureType,
              } as Bug,
            ]);
          }
          break;

        case "screenshot":
          setCurrentScreenshot(event.base64);
          setCurrentUrl(event.url);
          break;

        case "narration": {
          const type = classifyNarration(event.text);
          const text = stripPrefix(event.text);
          const timestamp = formatTimestamp(event.timestamp);
          setTranscriptLines((prev) => [...prev, { text, timestamp, type }]);
          break;
        }

        case "session_complete":
          setIsRunning(false);
          setIsComplete(true);
          setIsPaused(false);
          setReportId(event.reportId);
          break;

        case "session_aborted":
          setIsRunning(false);
          setIsComplete(false);
          setIsPaused(false);
          setCurrentScreenshot(null);
          setIncompleteStepIds([]);
          setCollectedBugs([]);
          setTestPlan((prev) => {
            if (!prev) return prev;
            return {
              ...prev,
              steps: prev.steps.map((s) => ({
                ...s,
                status: "pending" as const,
                incompleteReason: undefined,
                failureType: undefined,
              })),
            };
          });
          break;

        case "error":
          setTranscriptLines((prev) => [
            ...prev,
            {
              text: event.message,
              timestamp: new Date().toLocaleTimeString("en-US", {
                hour12: false,
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
              }),
              type: "error",
            },
          ]);
          setIsRunning(false);
          break;
      }
    });
  };

  const handleConfigure = async (source: string, targetUrl: string, geminiKey: string) => {
    setIsLoading(true);
    setConfigureError(null);
    try {
      const agentUrl = process.env.NEXT_PUBLIC_AGENT_URL || "http://localhost:3001";
      const res = await fetch(`${agentUrl}/api/plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source, targetUrl, geminiApiKey: geminiKey || undefined }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `Agent error: ${res.status}` }));
        throw new Error(err.error || `Agent error: ${res.status}`);
      }
      const plan: TestPlan = await res.json();
      setTestPlan(plan);
      setCurrentUrl(targetUrl);
      setCurrentScreen(2);
    } catch (err: any) {
      setConfigureError(err.message || "Failed to generate test plan");
    } finally {
      setIsLoading(false);
    }
  };

  const handleRunSession = () => {
    if (!testPlan || isRunning) return;
    setIsRunning(true);
    setIsComplete(false);
    setIncompleteStepIds([]);
    setCollectedBugs([]);
    setTranscriptLines([]);
    setCurrentScreenshot(null);

    const agentUrl = process.env.NEXT_PUBLIC_AGENT_URL || "http://localhost:3001";
    socket.connect(agentUrl);
    attachSocketHandler();
    socket.emit("session:start", { testPlan, targetUrl: testPlan.targetUrl, geminiApiKey: geminiApiKey.trim() || undefined });
  };

  const handleSkipStep = (stepId: string) => {
    setUserIncompleteStepIds((prev) => [...prev, stepId]);
    socket.emit("session:skip_step", { stepId });
  };

  const handleRetryStep = (stepId: string) => {
    if (!testPlan || isRunning) return;

    setTestPlan((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        steps: prev.steps.map((s) =>
          s.id === stepId ? { ...s, status: "pending" as const, incompleteReason: undefined } : s
        ),
      };
    });

    setIsRunning(true);
    setIsComplete(false);
    setIncompleteStepIds((prev) => prev.filter((id) => id !== stepId));
    setCollectedBugs([]);
    setTranscriptLines([]);
    setCurrentScreenshot(null);

    const agentUrl = process.env.NEXT_PUBLIC_AGENT_URL || "http://localhost:3001";
    socket.connect(agentUrl);
    attachSocketHandler();
    socket.emit("session:retry_skipped", {
      testPlan,
      targetUrl: testPlan.targetUrl,
      skippedStepIds: [stepId],
      geminiApiKey: geminiApiKey.trim() || undefined,
    });
  };

  const handleRetryIncomplete = () => {
    if (!testPlan || incompleteStepIds.length === 0 || isRunning) return;

    setTestPlan((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        steps: prev.steps.map((s) =>
          incompleteStepIds.includes(s.id)
            ? { ...s, status: "pending" as const, incompleteReason: undefined }
            : s
        ),
      };
    });

    setIsRunning(true);
    setIsComplete(false);
    setIncompleteStepIds([]);
    setCollectedBugs([]);
    setCurrentScreen(2);

    const agentUrl = process.env.NEXT_PUBLIC_AGENT_URL || "http://localhost:3001";
    socket.connect(agentUrl);
    attachSocketHandler();
    socket.emit("session:retry_skipped", {
      testPlan,
      targetUrl: testPlan.targetUrl,
      skippedStepIds: incompleteStepIds,
      geminiApiKey: geminiApiKey.trim() || undefined,
    });
  };

  const handlePause = () => {
    socket.emit("session:pause", {});
    setIsPaused(true);
  };

  const handleResume = () => {
    socket.emit("session:resume", {});
    setIsPaused(false);
  };

  const handleReset = () => {
    if (isRunning) {
      socket.emit("session:abort", {});
      // session_aborted event will reset state
    } else {
      // Not running — reset steps locally
      setIsComplete(false);
      setIsPaused(false);
      setCurrentScreenshot(null);
      setTranscriptLines([]);
      setIncompleteStepIds([]);
      setCollectedBugs([]);
      setTestPlan((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          steps: prev.steps.map((s) => ({
            ...s,
            status: "pending" as const,
            incompleteReason: undefined,
            failureType: undefined,
          })),
        };
      });
    }
  };

  const handleViewReport = async () => {
    setIsLoadingReport(true);
    try {
      // Try fetching the real report from Firestore via API
      if (reportId && !reportId.startsWith("rpt-")) {
        try {
          const res = await fetch(`/api/report/${reportId}`);
          if (res.ok) {
            const reportData: BugReport = await res.json();
            setReport(reportData);
            setCurrentScreen(3);
            return;
          }
        } catch {
          // Fall through to local construction
        }
      }

      // Local fallback: construct report from current testPlan state
      if (testPlan) {
        const passedSteps = testPlan.steps.filter((s) => s.status === "passed").length;
        const failedSteps = testPlan.steps.filter((s) => s.status === "failed").length;
        const incompleteSteps = testPlan.steps.filter((s) => s.status === "incomplete").length;
        const completedSteps = passedSteps + failedSteps;
        const total = testPlan.steps.length;

        const reportStatus =
          failedSteps > 0 ? "failed"
            : incompleteSteps > 0 ? "incomplete"
              : "passed";

        const passRate =
          completedSteps > 0
            ? Math.round((passedSteps / completedSteps) * 1000) / 10
            : total === incompleteSteps ? 0 : 100;

        let summary = "";
        if (reportStatus === "failed") {
          summary = `Found ${failedSteps} bug(s).${incompleteSteps > 0 ? ` ${incompleteSteps} step(s) could not complete.` : ""}`;
        } else if (reportStatus === "incomplete") {
          summary = `${incompleteSteps} step(s) could not complete. No bugs found in completed steps.`;
        } else {
          summary = `All ${total} steps passed. No bugs found.`;
        }

        setReport({
          id: reportId || `local-${Date.now()}`,
          testPlanId: testPlan.id,
          sourceTicket: testPlan.sourceTicket,
          targetUrl: testPlan.targetUrl,
          steps: testPlan.steps,
          bugs: collectedBugs,
          totalSteps: total,
          passedSteps,
          failedSteps,
          incompleteSteps,
          completedSteps,
          passRate,
          reportStatus: reportStatus as BugReport["reportStatus"],
          summary,
          createdAt: testPlan.createdAt,
          completedAt: new Date().toISOString(),
        });
        setCurrentScreen(3);
      }
    } finally {
      setIsLoadingReport(false);
    }
  };

  const handleNewRun = () => {
    socket.disconnect();
    setCurrentScreen(1);
    setTestPlan(null);
    setReport(null);
    setReportId(null);
    setIsLoading(false);
    setIsRunning(false);
    setIsComplete(false);
    setCurrentScreenshot(null);
    setCurrentUrl("about:blank");
    setTranscriptLines([]);
    setIncompleteStepIds([]);
    setUserIncompleteStepIds([]);
    setCollectedBugs([]);
    setConfigureError(null);
  };

  return (
    <div className="min-h-screen">
      <Header currentScreen={currentScreen} />

      {currentScreen === 1 && (
        <ConfigureScreen
          onSubmit={handleConfigure}
          isLoading={isLoading}
          error={configureError}
          geminiApiKey={geminiApiKey}
          onGeminiKeyChange={handleGeminiKeyChange}
        />
      )}

      {currentScreen === 2 && testPlan && (
        <ExecuteScreen
          testPlan={testPlan}
          onRunSession={handleRunSession}
          onViewReport={() => { void handleViewReport(); }}
          onRetryIncomplete={handleRetryIncomplete}
          onSkipStep={handleSkipStep}
          onRetryStep={handleRetryStep}
          onPause={handlePause}
          onResume={handleResume}
          onReset={handleReset}
          userIncompleteStepIds={userIncompleteStepIds}
          isRunning={isRunning}
          isPaused={isPaused}
          isComplete={isComplete}
          currentScreenshot={currentScreenshot}
          currentUrl={currentUrl}
          transcriptLines={transcriptLines}
          incompleteStepIds={incompleteStepIds}
          isLoadingReport={isLoadingReport}
        />
      )}

      {currentScreen === 3 && report && (
        <ResultsScreen
          report={report}
          onNewRun={handleNewRun}
          onRetryIncomplete={handleRetryIncomplete}
        />
      )}
    </div>
  );
}
