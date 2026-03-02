"use client";

import { useState, useEffect, use } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Loader2 } from "lucide-react";
import ResultsScreen from "../../../components/ResultsScreen";
import type { BugReport } from "@verifai/types";

export default function RunDetailPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = use(params);
    const router = useRouter();
    const [report, setReport] = useState<BugReport | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");

    useEffect(() => {
        async function fetchReport() {
            try {
                const res = await fetch(`/api/report/${id}`);
                if (!res.ok) throw new Error("Report not found");
                const data = await res.json();
                setReport(data);
            } catch (err: any) {
                setError(err.message);
            } finally {
                setLoading(false);
            }
        }
        fetchReport();
    }, [id]);

    if (loading) {
        return (
            <div className="min-h-screen bg-[#0A0A0B] flex items-center justify-center">
                <Loader2 className="w-6 h-6 text-indigo-400 animate-spin" />
                <span className="ml-3 text-gray-400">Loading report...</span>
            </div>
        );
    }

    if (error || !report) {
        return (
            <div className="min-h-screen bg-[#0A0A0B] flex flex-col items-center justify-center">
                <p className="text-rose-400 mb-4">{error || "Report not found"}</p>
                <button
                    onClick={() => router.push("/runs")}
                    className="flex items-center gap-2 px-4 py-2 bg-gray-800 text-gray-300 rounded-lg hover:bg-gray-700 transition-colors"
                >
                    <ArrowLeft className="w-4 h-4" />
                    Back to History
                </button>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-[#0A0A0B]">
            {/* Navigation header */}
            <div className="border-b border-gray-800">
                <div className="max-w-6xl mx-auto px-6 py-4 flex items-center gap-4">
                    <button
                        onClick={() => router.push("/runs")}
                        className="p-2 rounded-lg bg-gray-800/50 hover:bg-gray-800 text-gray-400 hover:text-gray-200 transition-colors"
                    >
                        <ArrowLeft className="w-4 h-4" />
                    </button>
                    <div>
                        <h1 className="text-sm font-medium text-gray-300">
                            Test Run: {report.id}
                        </h1>
                        <p className="text-xs text-gray-500">
                            {new Date(report.completedAt).toLocaleString()} · {report.targetUrl}
                        </p>
                    </div>
                </div>
            </div>

            {/* Reuse existing ResultsScreen */}
            <div className="max-w-6xl mx-auto px-6 py-8">
                <ResultsScreen
                    report={report}
                    onNewRun={() => router.push("/")}
                    onRetryIncomplete={() => {
                        // Could navigate to home with pre-loaded test plan
                        // For now, just go to home
                        router.push("/");
                    }}
                    onDownloadPDF={async () => {
                        try {
                            const res = await fetch("/api/report/pdf", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify(report),
                            });
                            if (!res.ok) return;
                            const blob = await res.blob();
                            const url = URL.createObjectURL(blob);
                            const a = document.createElement("a");
                            a.href = url;
                            a.download = `verifai-report-${report.id}.pdf`;
                            a.click();
                            URL.revokeObjectURL(url);
                        } catch (err) {
                            console.error("[PDF] Download failed:", err);
                        }
                    }}
                />
            </div>
        </div>
    );
}
