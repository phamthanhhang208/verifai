"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
    Activity,
    Bug,
    CheckCircle2,
    XCircle,
    AlertTriangle,
    ChevronRight,
    ExternalLink,
    BarChart3,
    Clock,
    Loader2,
    ArrowLeft,
    TrendingUp,
} from "lucide-react";

interface RunSummary {
    id: string;
    targetUrl: string;
    sourceTicket: string;
    reportStatus: "passed" | "failed" | "incomplete";
    totalSteps: number;
    passedSteps: number;
    failedSteps: number;
    incompleteSteps: number;
    passRate: number;
    bugCount: number;
    summary: string;
    completedAt: string;
    createdAt: string;
}

interface Stats {
    totalRuns: number;
    totalBugs: number;
    avgPassRate: number;
    passedRuns: number;
    failedRuns: number;
    incompleteRuns: number;
}

export default function RunsPage() {
    const router = useRouter();
    const [runs, setRuns] = useState<RunSummary[]>([]);
    const [stats, setStats] = useState<Stats | null>(null);
    const [loading, setLoading] = useState(true);
    const [hasMore, setHasMore] = useState(false);
    const [loadingMore, setLoadingMore] = useState(false);

    useEffect(() => {
        fetchRuns();
        fetchStats();
    }, []);

    async function fetchRuns(startAfter?: string) {
        try {
            const params = new URLSearchParams({ limit: "20" });
            if (startAfter) params.set("startAfter", startAfter);

            const res = await fetch(`/api/runs?${params}`);
            if (!res.ok) throw new Error("Failed to fetch runs");

            const data = await res.json();

            if (startAfter) {
                setRuns((prev) => [...prev, ...data.runs]);
            } else {
                setRuns(data.runs);
            }
            setHasMore(data.hasMore);
        } catch (err) {
            console.error("[Runs] Fetch error:", err);
        } finally {
            setLoading(false);
            setLoadingMore(false);
        }
    }

    async function fetchStats() {
        try {
            const res = await fetch("/api/runs/stats");
            if (res.ok) {
                setStats(await res.json());
            }
        } catch {
            // Stats are non-critical
        }
    }

    function handleLoadMore() {
        if (runs.length === 0) return;
        setLoadingMore(true);
        fetchRuns(runs[runs.length - 1].completedAt);
    }

    function formatDate(iso: string): string {
        if (!iso) return "—";
        const d = new Date(iso);
        return d.toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit",
        });
    }

    function formatUrl(url: string): string {
        try {
            return new URL(url).hostname;
        } catch {
            return url;
        }
    }

    const statusConfig = {
        passed: {
            icon: CheckCircle2,
            label: "Passed",
            className: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
            dot: "bg-emerald-500",
        },
        failed: {
            icon: XCircle,
            label: "Failed",
            className: "bg-rose-500/15 text-rose-400 border-rose-500/30",
            dot: "bg-rose-500",
        },
        incomplete: {
            icon: AlertTriangle,
            label: "Incomplete",
            className: "bg-amber-500/15 text-amber-400 border-amber-500/30",
            dot: "bg-amber-500",
        },
    };

    return (
        <div className="min-h-screen bg-[#0A0A0B] text-gray-100">
            {/* Header */}
            <div className="border-b border-gray-800">
                <div className="max-w-6xl mx-auto px-6 py-6">
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-4">
                            <button
                                onClick={() => router.push("/")}
                                className="p-2 rounded-lg bg-gray-800/50 hover:bg-gray-800 text-gray-400 hover:text-gray-200 transition-colors"
                            >
                                <ArrowLeft className="w-4 h-4" />
                            </button>
                            <div>
                                <h1 className="text-xl font-semibold flex items-center gap-2">
                                    <Activity className="w-5 h-5 text-indigo-400" />
                                    Test History
                                </h1>
                                <p className="text-sm text-gray-500 mt-0.5">
                                    All past QA test sessions
                                </p>
                            </div>
                        </div>

                        <button
                            onClick={() => router.push("/")}
                            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-lg transition-colors"
                        >
                            New Test Run
                        </button>
                    </div>
                </div>
            </div>

            <div className="max-w-6xl mx-auto px-6 py-8">
                {/* Stats Cards */}
                {stats && stats.totalRuns > 0 && (
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
                        <StatCard
                            icon={<BarChart3 className="w-4 h-4 text-indigo-400" />}
                            label="Total Runs"
                            value={String(stats.totalRuns)}
                            color="indigo"
                        />
                        <StatCard
                            icon={<TrendingUp className="w-4 h-4 text-emerald-400" />}
                            label="Avg Pass Rate"
                            value={`${stats.avgPassRate}%`}
                            color="emerald"
                        />
                        <StatCard
                            icon={<Bug className="w-4 h-4 text-rose-400" />}
                            label="Total Bugs Found"
                            value={String(stats.totalBugs)}
                            color="rose"
                        />
                        <StatCard
                            icon={<CheckCircle2 className="w-4 h-4 text-emerald-400" />}
                            label="Clean Runs"
                            value={`${stats.passedRuns}/${stats.totalRuns}`}
                            color="emerald"
                            subtitle={`${stats.failedRuns} failed · ${stats.incompleteRuns} incomplete`}
                        />
                    </div>
                )}

                {/* Loading */}
                {loading && (
                    <div className="flex items-center justify-center py-20">
                        <Loader2 className="w-6 h-6 text-indigo-400 animate-spin" />
                        <span className="ml-3 text-gray-400">Loading test history...</span>
                    </div>
                )}

                {/* Empty state */}
                {!loading && runs.length === 0 && (
                    <div className="text-center py-20">
                        <Activity className="w-12 h-12 text-gray-700 mx-auto mb-4" />
                        <h3 className="text-lg font-medium text-gray-400 mb-2">No test runs yet</h3>
                        <p className="text-sm text-gray-600 mb-6">
                            Run your first QA session to see results here.
                        </p>
                        <button
                            onClick={() => router.push("/")}
                            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-lg transition-colors"
                        >
                            Start First Test
                        </button>
                    </div>
                )}

                {/* Runs List */}
                {!loading && runs.length > 0 && (
                    <div className="space-y-3">
                        {runs.map((run) => {
                            const config = statusConfig[run.reportStatus] || statusConfig.incomplete;
                            const StatusIcon = config.icon;

                            return (
                                <button
                                    key={run.id}
                                    onClick={() => router.push(`/runs/${run.id}`)}
                                    className="w-full text-left p-4 bg-gray-900/50 hover:bg-gray-800/50 border border-gray-800 hover:border-gray-700 rounded-xl transition-all group"
                                >
                                    <div className="flex items-center gap-4">
                                        {/* Status indicator */}
                                        <div className={`p-2 rounded-lg ${config.className}`}>
                                            <StatusIcon className="w-4 h-4" />
                                        </div>

                                        {/* Main content */}
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-2 mb-1">
                                                <span className="text-sm font-medium text-gray-200 truncate">
                                                    {formatUrl(run.targetUrl)}
                                                </span>
                                                {run.sourceTicket && (
                                                    <span className="text-xs text-gray-500 bg-gray-800 px-1.5 py-0.5 rounded">
                                                        {run.sourceTicket}
                                                    </span>
                                                )}
                                            </div>
                                            <p className="text-xs text-gray-500 truncate">
                                                {run.summary || `${run.totalSteps} steps · ${run.bugCount} bug(s)`}
                                            </p>
                                        </div>

                                        {/* Metrics */}
                                        <div className="hidden md:flex items-center gap-6">
                                            {/* Steps breakdown */}
                                            <div className="flex items-center gap-1.5">
                                                <div className="flex gap-0.5">
                                                    {run.passedSteps > 0 && (
                                                        <span className="text-xs text-emerald-400">
                                                            {run.passedSteps}✓
                                                        </span>
                                                    )}
                                                    {run.failedSteps > 0 && (
                                                        <span className="text-xs text-rose-400 ml-1">
                                                            {run.failedSteps}✗
                                                        </span>
                                                    )}
                                                    {run.incompleteSteps > 0 && (
                                                        <span className="text-xs text-amber-400 ml-1">
                                                            {run.incompleteSteps}⏭
                                                        </span>
                                                    )}
                                                </div>
                                                <span className="text-xs text-gray-600">
                                                    /{run.totalSteps}
                                                </span>
                                            </div>

                                            {/* Pass rate */}
                                            <div className="text-right w-14">
                                                <span
                                                    className={`text-sm font-mono font-medium ${run.passRate >= 80
                                                            ? "text-emerald-400"
                                                            : run.passRate >= 50
                                                                ? "text-amber-400"
                                                                : "text-rose-400"
                                                        }`}
                                                >
                                                    {run.passRate}%
                                                </span>
                                            </div>

                                            {/* Bug count */}
                                            {run.bugCount > 0 && (
                                                <div className="flex items-center gap-1 text-rose-400">
                                                    <Bug className="w-3.5 h-3.5" />
                                                    <span className="text-xs font-medium">{run.bugCount}</span>
                                                </div>
                                            )}

                                            {/* Date */}
                                            <div className="flex items-center gap-1 text-gray-500 w-36 text-right">
                                                <Clock className="w-3 h-3" />
                                                <span className="text-xs">{formatDate(run.completedAt)}</span>
                                            </div>
                                        </div>

                                        {/* Arrow */}
                                        <ChevronRight className="w-4 h-4 text-gray-600 group-hover:text-gray-400 transition-colors" />
                                    </div>

                                    {/* Mobile metrics row */}
                                    <div className="flex md:hidden items-center gap-4 mt-3 pt-3 border-t border-gray-800/50">
                                        <span className={`text-xs font-medium px-2 py-0.5 rounded border ${config.className}`}>
                                            {config.label}
                                        </span>
                                        <span className="text-xs text-gray-500">
                                            {run.passRate}% pass rate
                                        </span>
                                        {run.bugCount > 0 && (
                                            <span className="text-xs text-rose-400">
                                                {run.bugCount} bug(s)
                                            </span>
                                        )}
                                        <span className="text-xs text-gray-600 ml-auto">
                                            {formatDate(run.completedAt)}
                                        </span>
                                    </div>
                                </button>
                            );
                        })}

                        {/* Load More */}
                        {hasMore && (
                            <div className="text-center pt-4">
                                <button
                                    onClick={handleLoadMore}
                                    disabled={loadingMore}
                                    className="px-6 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm rounded-lg border border-gray-700 transition-colors disabled:opacity-50"
                                >
                                    {loadingMore ? (
                                        <span className="flex items-center gap-2">
                                            <Loader2 className="w-4 h-4 animate-spin" />
                                            Loading...
                                        </span>
                                    ) : (
                                        "Load More"
                                    )}
                                </button>
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}

// ─── Stat Card Component ────────────────────────────────

function StatCard({
    icon,
    label,
    value,
    color,
    subtitle,
}: {
    icon: React.ReactNode;
    label: string;
    value: string;
    color: string;
    subtitle?: string;
}) {
    const colorMap: Record<string, string> = {
        indigo: "border-indigo-500/20",
        emerald: "border-emerald-500/20",
        rose: "border-rose-500/20",
        amber: "border-amber-500/20",
    };

    return (
        <div className={`p-4 bg-gray-900/50 border ${colorMap[color] || colorMap.indigo} rounded-xl`}>
            <div className="flex items-center gap-2 mb-2">
                {icon}
                <span className="text-xs text-gray-500 uppercase tracking-wider">{label}</span>
            </div>
            <div className="text-2xl font-semibold text-gray-100">{value}</div>
            {subtitle && (
                <div className="text-xs text-gray-500 mt-1">{subtitle}</div>
            )}
        </div>
    );
}
