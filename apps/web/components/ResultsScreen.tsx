"use client";

import { useEffect, useState } from "react";
import { Download, FileDown, Plus, Monitor, AlertTriangle, RefreshCw, Clock, ExternalLink, Activity } from "lucide-react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import type { BugReport, BugSeverity, IncompleteReason } from "@verifai/types";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface ResultsScreenProps {
  report: BugReport;
  onNewRun: () => void;
  onRetryIncomplete: () => void;
  onDownloadPDF?: () => void;
}

const RETRY_DELAY_MS = 10 * 60 * 1000; // 10 minutes
const RETRY_STORAGE_KEY = "verifai_retry_at";

function SeverityBadge({ severity }: { severity: BugSeverity }) {
  return (
    <Badge
      className={cn("text-xs capitalize border", {
        "bg-rose-500/20 text-rose-400 border-rose-500/30 hover:bg-rose-500/20": severity === "high",
        "bg-amber-500/20 text-amber-400 border-amber-500/30 hover:bg-amber-500/20": severity === "medium",
        "bg-gray-500/20 text-gray-400 border-gray-500/30 hover:bg-gray-500/20": severity === "low",
      })}
    >
      {severity}
    </Badge>
  );
}

function incompleteReasonLabel(reason: IncompleteReason | undefined): string {
  switch (reason) {
    case "rate_limit": return "Rate Limited";
    case "timeout": return "Timeout";
    case "crash": return "Agent Error";
    default: return "Skipped";
  }
}

export default function ResultsScreen({ report, onNewRun, onRetryIncomplete, onDownloadPDF }: ResultsScreenProps) {
  const [retryReady, setRetryReady] = useState(false);

  const { reportStatus, incompleteSteps, failedSteps, passedSteps, passRate } = report;
  const isPassing = reportStatus === "passed";
  const hasIncomplete = incompleteSteps > 0;
  const hasBugs = failedSteps > 0;
  const incompleteStepsList = report.steps.filter((s) => s.status === "incomplete");

  // Schedule Retry: poll localStorage every 5s, fire notification when timer elapses
  useEffect(() => {
    if (!hasIncomplete) return;

    const check = () => {
      const stored = localStorage.getItem(RETRY_STORAGE_KEY);
      if (!stored) return;
      const { scheduledAt } = JSON.parse(stored) as { scheduledAt: number };
      if (Date.now() >= scheduledAt) {
        setRetryReady(true);
        localStorage.removeItem(RETRY_STORAGE_KEY);
      }
    };

    check();
    const interval = setInterval(check, 5000);
    return () => clearInterval(interval);
  }, [hasIncomplete]);

  const handleScheduleRetry = () => {
    localStorage.setItem(
      RETRY_STORAGE_KEY,
      JSON.stringify({ scheduledAt: Date.now() + RETRY_DELAY_MS })
    );
  };

  const statusBadge = {
    passed: { label: "PASSED", className: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/20" },
    failed: { label: "FAILED RUN", className: "bg-rose-500/20 text-rose-400 border-rose-500/30 hover:bg-rose-500/20" },
    incomplete: { label: "INCOMPLETE", className: "bg-amber-500/20 text-amber-400 border-amber-500/30 hover:bg-amber-500/20" },
  }[reportStatus];

  return (
    <div className="overflow-y-auto min-h-[calc(100vh-64px)] py-8">
      <div className="max-w-5xl mx-auto px-6">

        {/* Header row */}
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-4">
            <Badge className={cn("text-sm px-3 py-1 border", statusBadge.className)}>
              {statusBadge.label}
            </Badge>
            <div>
              <h1 className="text-2xl font-semibold text-white">Test Plan Results</h1>
              <p className="text-sm text-gray-400 mt-0.5">
                {report.sourceTicket} · {report.targetUrl}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <Link
              href="/runs"
              className="flex items-center gap-2 px-4 py-2 text-sm text-gray-400 hover:text-gray-200 bg-gray-800/50 hover:bg-gray-800 rounded-lg border border-gray-700/50 transition-colors"
            >
              <Activity className="w-4 h-4" />
              View All Runs
            </Link>
            <button
              onClick={onNewRun}
              className="flex items-center gap-2 px-4 py-2 rounded-lg border border-gray-700 text-sm text-gray-300 hover:border-gray-600 hover:text-white transition-colors"
            >
              <Plus className="w-4 h-4" />
              New Test Run
            </button>
            {onDownloadPDF && (
              <button
                onClick={onDownloadPDF}
                className="flex items-center gap-2 px-4 py-2 bg-indigo-500/20 hover:bg-indigo-500/30 text-indigo-400 text-sm font-medium rounded-lg border border-indigo-500/30 transition-colors"
              >
                <FileDown className="w-4 h-4" />
                Download PDF
              </button>
            )}
          </div>
        </div>

        {/* Metric cards: 4-col with Incomplete, 3-col without */}
        <div className={cn("grid gap-4 mb-8", hasIncomplete ? "grid-cols-4" : "grid-cols-3")}>
          {/* Passed */}
          <div className="rounded-2xl overflow-hidden bg-surface-card">
            <div className="bg-emerald-500/10 p-6 h-full">
              <div className="text-3xl font-bold text-emerald-400">{passedSteps}</div>
              <div className="text-sm text-gray-400 mt-1">Passed</div>
            </div>
          </div>

          {/* Failed */}
          <div className="rounded-2xl overflow-hidden bg-surface-card">
            <div className="bg-rose-500/10 p-6 h-full">
              <div className="text-3xl font-bold text-rose-400">{failedSteps}</div>
              <div className="text-sm text-gray-400 mt-1">Failed</div>
            </div>
          </div>

          {/* Incomplete — only shown when > 0 */}
          {hasIncomplete && (
            <div className="rounded-2xl overflow-hidden bg-surface-card">
              <div className="bg-amber-500/10 p-6 h-full">
                <div className="text-3xl font-bold text-amber-400">{incompleteSteps}</div>
                <div className="text-sm text-gray-400 mt-1">Incomplete</div>
              </div>
            </div>
          )}

          {/* Pass Rate */}
          <div className="rounded-2xl overflow-hidden bg-surface-card">
            <div className={cn("p-6 h-full", isPassing ? "bg-indigo-500/10" : "bg-rose-500/10")}>
              <div className={cn("text-3xl font-bold", isPassing ? "text-indigo-400" : "text-rose-400")}>
                {passRate.toFixed(1)}<span className="text-lg ml-0.5">%</span>
              </div>
              <div className="text-sm text-gray-400 mt-1">
                Pass Rate{hasIncomplete && <span className="text-gray-600"> (excl. incomplete)</span>}
              </div>
            </div>
          </div>
        </div>

        {/* Info banner — only when there are incomplete steps */}
        {hasIncomplete && (
          <div className="mb-8 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="text-sm text-amber-300 font-medium">
                  {incompleteSteps} step{incompleteSteps > 1 ? "s" : ""} could not complete due to rate limits or timeouts.
                </p>
                <p className="text-xs text-amber-400/70 mt-0.5">
                  Results below reflect completed steps only.
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={handleScheduleRetry}
                  className="flex items-center gap-1.5 text-xs text-amber-400/70 hover:text-amber-400 border border-amber-500/20 hover:border-amber-500/40 px-3 py-1.5 rounded-lg transition-colors"
                >
                  <Clock className="w-3.5 h-3.5" />
                  Schedule Retry in 10 min
                </button>
                <button
                  onClick={onRetryIncomplete}
                  className="flex items-center gap-1.5 text-xs text-amber-400 bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/30 px-3 py-1.5 rounded-lg transition-colors"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  Retry Now
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Bug cards — only shown when failedSteps > 0 */}
        {hasBugs && (
          <div className="space-y-4 mb-8">
            <h2 className="text-base font-semibold text-white">
              Issues Found ({report.bugs.length})
            </h2>
            {report.bugs.map((bug) => (
              <div key={bug.id} className="bg-surface-card rounded-2xl overflow-hidden flex card-glow">
                {/* Screenshot */}
                {bug.screenshotUrl ? (
                  <a
                    href={bug.screenshotUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="w-64 shrink-0 min-h-40 overflow-hidden"
                  >
                    <img
                      src={bug.screenshotUrl}
                      alt={`Screenshot for ${bug.title}`}
                      className="w-full h-full object-cover"
                    />
                  </a>
                ) : (
                  <div className="w-64 shrink-0 bg-surface-panel flex items-center justify-center group cursor-default min-h-40">
                    <div className="text-center">
                      <div className="w-16 h-12 bg-surface-bg rounded-lg mx-auto mb-2 flex items-center justify-center">
                        <Monitor className="w-8 h-8 text-gray-600" />
                      </div>
                      <span className="text-xs text-gray-600">No screenshot</span>
                    </div>
                  </div>
                )}

                {/* Bug content */}
                <div className="flex-1 p-6 min-w-0">
                  <div className="flex items-center gap-3 mb-3 flex-wrap">
                    <SeverityBadge severity={bug.severity} />
                    <span className="text-sm text-gray-500">{bug.id}</span>
                    {bug.jiraTicketUrl ? (
                      <a
                        href={bug.jiraTicketUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="ml-auto flex items-center gap-1 text-sm text-indigo-400 hover:text-indigo-300 transition-colors shrink-0"
                      >
                        {bug.jiraTicketKey || "View Jira Ticket"}
                        <ExternalLink className="w-3 h-3" />
                      </a>
                    ) : (
                      <span className="ml-auto text-sm text-gray-600 shrink-0">No Jira ticket</span>
                    )}
                  </div>
                  <h3 className="text-base font-medium text-white mb-4">{bug.title}</h3>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <div className="text-xs font-medium text-emerald-400 mb-1 uppercase tracking-wide">
                        Expected Behavior
                      </div>
                      <p className="text-sm text-gray-300">{bug.expectedBehavior}</p>
                    </div>
                    <div>
                      <div className="text-xs font-medium text-rose-400 mb-1 uppercase tracking-wide">
                        Actual Behavior
                      </div>
                      <p className="text-sm text-gray-300">{bug.actualBehavior}</p>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Incomplete Steps section — only when incompleteSteps > 0 */}
        {hasIncomplete && (
          <div className="space-y-2">
            <h2 className="text-base font-semibold text-white mb-3">
              Skipped Steps ({incompleteSteps})
            </h2>
            {incompleteStepsList.map((step) => (
              <div
                key={step.id}
                className="flex items-center gap-3 px-4 py-3 rounded-xl border border-amber-500/20 bg-amber-500/5"
              >
                <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0" />
                <span className="flex-1 text-sm text-amber-300/80">{step.text}</span>
                <span className="shrink-0 text-xs bg-amber-500/15 text-amber-400/80 border border-amber-500/20 px-2 py-0.5 rounded-full">
                  {incompleteReasonLabel(step.incompleteReason)}
                </span>
              </div>
            ))}
          </div>
        )}

      </div>

      {/* Fixed-position retry notification — fires when scheduled window elapses */}
      {retryReady && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-3 px-4 py-3 rounded-xl border border-amber-500/40 bg-[#1A1610] shadow-lg max-w-sm">
          <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
          <span className="text-sm text-amber-300 flex-1">
            Ready to retry — scheduled window reached.
          </span>
          <button
            onClick={() => { setRetryReady(false); onRetryIncomplete(); }}
            className="shrink-0 text-xs font-medium text-amber-400 bg-amber-500/20 hover:bg-amber-500/30 px-3 py-1.5 rounded-lg transition-colors"
          >
            Re-run
          </button>
          <button
            onClick={() => setRetryReady(false)}
            className="shrink-0 text-xs text-gray-500 hover:text-gray-400 transition-colors"
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
}
