"use client";

import { useState } from "react";
import type { TestPlan, BugReport } from "@verifai/types";
import { mockTestPlan, mockBugReport } from "@/lib/mock-data";
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
  if (text.includes("[HEALED]")) return "healed";
  return "info";
}

function stripPrefix(text: string): string {
  return text.replace(/^\[(ERROR|OK|HEALED|INFO)\]\s*/, "");
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

  const handleConfigure = async (source: string, targetUrl: string) => {
    setIsLoading(true);
    // Phase 3 TODO: call real Jira/spec parsing API here
    await new Promise((resolve) => setTimeout(resolve, 2000));
    setTestPlan({ ...mockTestPlan, sourceTicket: source, targetUrl });
    setCurrentUrl(targetUrl);
    setIsLoading(false);
    setCurrentScreen(2);
  };

  const handleRunSession = () => {
    if (!testPlan || isRunning) return;
    setIsRunning(true);
    setTranscriptLines([]);
    setCurrentScreenshot(null);

    const agentUrl =
      process.env.NEXT_PUBLIC_AGENT_URL || "http://localhost:3001";

    socket.connect(agentUrl);

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
                s.id === event.stepId ? { ...s, status: event.status } : s
              ),
            };
          });
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
          setReportId(event.reportId);
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

    socket.emit("session:start", {
      testPlan,
      targetUrl: testPlan.targetUrl,
    });
  };

  const handleViewReport = () => {
    // Phase 6 TODO: fetch real report from Firestore using reportId
    void reportId;
    setReport(mockBugReport);
    setCurrentScreen(3);
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
  };

  return (
    <div className="min-h-screen">
      <Header currentScreen={currentScreen} />

      {currentScreen === 1 && (
        <ConfigureScreen onSubmit={handleConfigure} isLoading={isLoading} />
      )}

      {currentScreen === 2 && testPlan && (
        <ExecuteScreen
          testPlan={testPlan}
          onRunSession={handleRunSession}
          onViewReport={handleViewReport}
          isRunning={isRunning}
          isComplete={isComplete}
          currentScreenshot={currentScreenshot}
          currentUrl={currentUrl}
          transcriptLines={transcriptLines}
        />
      )}

      {currentScreen === 3 && report && (
        <ResultsScreen report={report} onNewRun={handleNewRun} />
      )}
    </div>
  );
}
