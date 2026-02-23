import { Download, Plus, Monitor } from "lucide-react";
import { cn } from "@/lib/utils";
import type { BugReport, BugSeverity } from "@verifai/types";
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
}

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

export default function ResultsScreen({ report, onNewRun }: ResultsScreenProps) {
  const isPassing = report.passRate >= 80;

  return (
    <div className="overflow-y-auto min-h-[calc(100vh-64px)] py-8">
      <div className="max-w-5xl mx-auto px-6">
        {/* Header row */}
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-4">
            <Badge
              className={cn("text-sm px-3 py-1 border", {
                "bg-emerald-500/20 text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/20": isPassing,
                "bg-rose-500/20 text-rose-400 border-rose-500/30 hover:bg-rose-500/20": !isPassing,
              })}
            >
              {isPassing ? "Passed" : "Issues Found"}
            </Badge>
            <div>
              <h1 className="text-2xl font-semibold text-white">Test Plan Results</h1>
              <p className="text-sm text-gray-400 mt-0.5">
                {report.sourceTicket} · {report.targetUrl}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={onNewRun}
              className="flex items-center gap-2 px-4 py-2 rounded-lg border border-gray-700 text-sm text-gray-300 hover:border-gray-600 hover:text-white transition-colors"
            >
              <Plus className="w-4 h-4" />
              New Test Run
            </button>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    disabled
                    className="flex items-center gap-2 px-4 py-2 rounded-lg border border-gray-700 text-sm text-gray-600 cursor-not-allowed opacity-50"
                  >
                    <Download className="w-4 h-4" />
                    Download PDF Report
                  </button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>Coming soon</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
        </div>

        {/* Metric cards */}
        <div className="grid grid-cols-4 gap-4 mb-8">
          {/* Total Steps */}
          <div className="bg-[#141517] rounded-2xl p-6">
            <div className="text-3xl font-bold text-white">{report.totalSteps}</div>
            <div className="text-sm text-gray-400 mt-1">Total Steps</div>
          </div>

          {/* Passed */}
          <div className="rounded-2xl overflow-hidden bg-[#141517]">
            <div className="bg-emerald-500/10 p-6 h-full">
              <div className="text-3xl font-bold text-emerald-400">{report.passedSteps}</div>
              <div className="text-sm text-gray-400 mt-1">Passed</div>
            </div>
          </div>

          {/* Failed */}
          <div className="rounded-2xl overflow-hidden bg-[#141517]">
            <div className="bg-rose-500/10 p-6 h-full">
              <div className="text-3xl font-bold text-rose-400">{report.failedSteps}</div>
              <div className="text-sm text-gray-400 mt-1">Failed</div>
            </div>
          </div>

          {/* Pass Rate */}
          <div className="rounded-2xl overflow-hidden bg-[#141517]">
            <div className={cn("p-6 h-full", isPassing ? "bg-indigo-500/10" : "bg-rose-500/10")}>
              <div className={cn("text-3xl font-bold", isPassing ? "text-indigo-400" : "text-rose-400")}>
                {report.passRate.toFixed(1)}
                <span className="text-lg ml-0.5">%</span>
              </div>
              <div className="text-sm text-gray-400 mt-1">Pass Rate</div>
            </div>
          </div>
        </div>

        {/* Bug cards */}
        <div className="space-y-4">
          {report.bugs.map((bug) => (
            <div key={bug.id} className="bg-[#141517] rounded-2xl overflow-hidden flex card-glow">
              {/* Screenshot placeholder */}
              <div className="w-64 flex-shrink-0 bg-[#1A1C20] flex items-center justify-center group cursor-pointer min-h-40">
                <div className="text-center transition-opacity group-hover:opacity-60">
                  <div className="w-16 h-12 bg-[#0A0A0B] rounded-lg mx-auto mb-2 flex items-center justify-center">
                    <Monitor className="w-8 h-8 text-gray-600" />
                  </div>
                  <span className="text-xs text-gray-600">No screenshot</span>
                </div>
              </div>

              {/* Bug content */}
              <div className="flex-1 p-6 min-w-0">
                {/* Top row */}
                <div className="flex items-center gap-3 mb-3 flex-wrap">
                  <SeverityBadge severity={bug.severity} />
                  <span className="text-sm text-gray-500">{bug.id}</span>
                  {bug.jiraTicketUrl && (
                    <a
                      href={bug.jiraTicketUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="ml-auto text-sm text-indigo-400 hover:text-indigo-300 transition-colors flex-shrink-0"
                    >
                      View Jira Ticket ↗
                    </a>
                  )}
                </div>

                {/* Bug title */}
                <h3 className="text-base font-medium text-white mb-4">{bug.title}</h3>

                {/* Expected / Actual */}
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
      </div>
    </div>
  );
}
