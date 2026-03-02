import React, { useState } from "react";
import type { HITLPauseEvent, HITLDecisionEvent, ComputerUseAction } from "@verifai/types";
import { PlayCircle, AlertTriangle, UserCheck, ShieldAlert, KeyRound, Loader2 } from "lucide-react";

export interface HITLModalProps {
    pauseEvent: HITLPauseEvent;
    onDecision: (decision: HITLDecisionEvent) => void;
}

export default function HITLModal({ pauseEvent, onDecision }: HITLModalProps) {
    const [submitting, setSubmitting] = useState(false);
    const [humanNote, setHumanNote] = useState("");
    const [overrideText, setOverrideText] = useState("");

    const handleAction = (decision: string, overrideAction?: ComputerUseAction) => {
        setSubmitting(true);
        onDecision({
            type: "hitl_decision",
            pauseId: pauseEvent.pauseId,
            decision: decision as any,
            overrideAction,
            humanNote: humanNote.trim() || undefined,
        });
    };

    const getReasonIcon = () => {
        switch (pauseEvent.reason) {
            case "low_confidence_action": return <PlayCircle className="w-6 h-6 text-yellow-400" />;
            case "unexpected_page_state": return <AlertTriangle className="w-6 h-6 text-orange-400" />;
            case "verification_ambiguous": return <UserCheck className="w-6 h-6 text-blue-400" />;
            case "destructive_action": return <ShieldAlert className="w-6 h-6 text-red-500" />;
            case "authentication_required": return <KeyRound className="w-6 h-6 text-purple-400" />;
            default: return <UserCheck className="w-6 h-6 text-blue-400" />;
        }
    };

    const getReasonTitle = () => {
        switch (pauseEvent.reason) {
            case "low_confidence_action": return "Confirmation Needed";
            case "unexpected_page_state": return "Unexpected Screen State";
            case "verification_ambiguous": return "Verification Ambiguous";
            case "destructive_action": return "Destructive Action Detected";
            case "authentication_required": return "Authentication Required";
            default: return "Human Intervention Required";
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
            <div className="w-full max-w-2xl bg-[#1e1e1e] border border-[#2a2a2a] rounded-xl shadow-2xl flex flex-col max-h-[90vh] overflow-hidden animate-in fade-in zoom-in-95 duration-200">

                {/* Header */}
                <div className="flex px-6 py-4 items-center gap-3 border-b border-[#2a2a2a] bg-[#1a1a1a]">
                    {getReasonIcon()}
                    <div>
                        <h2 className="text-lg font-semibold text-gray-100">{getReasonTitle()}</h2>
                        <div className="text-xs font-mono text-gray-500">PAUSE ID: {pauseEvent.pauseId}</div>
                    </div>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-y-auto p-6 space-y-6">
                    <div className="space-y-2">
                        <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider">The Situation</h3>
                        <p className="text-gray-200 leading-relaxed bg-[#252525] p-4 rounded-lg border border-[#333]">
                            {pauseEvent.question}
                        </p>
                    </div>

                    <div className="space-y-2">
                        <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider">Current Step</h3>
                        <p className="text-gray-300 font-medium italic border-l-2 border-indigo-500 pl-3">
                            "{pauseEvent.stepText}"
                        </p>
                    </div>

                    {pauseEvent.screenshotBase64 && (
                        <div className="space-y-2">
                            <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider">What AI Sees</h3>
                            <div className="relative rounded-lg overflow-hidden border border-[#333] shadow-inner bg-black aspect-video flex items-center justify-center">
                                <img
                                    src={`data:image/jpeg;base64,${pauseEvent.screenshotBase64}`}
                                    alt="Current state"
                                    className="max-h-[300px] object-contain rounded"
                                />
                            </div>
                        </div>
                    )}

                    {/* Override UI for low_confidence_action */}
                    {pauseEvent.reason === "low_confidence_action" && (
                        <div className="space-y-2">
                            <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider">Optional Note / Override</h3>
                            <input
                                type="text"
                                placeholder="Add a note or manually type text..."
                                value={humanNote}
                                onChange={(e) => setHumanNote(e.target.value)}
                                className="w-full bg-[#111] border border-[#333] rounded px-4 py-2 text-sm text-gray-200 focus:outline-none focus:border-indigo-500"
                            />
                        </div>
                    )}
                </div>

                {/* Action Bar */}
                <div className="p-6 bg-[#151515] border-t border-[#2a2a2a] flex flex-wrap gap-3">
                    {pauseEvent.options.map((opt) => (
                        <button
                            key={opt.decision}
                            disabled={submitting}
                            onClick={() => handleAction(opt.decision)}
                            className={`flex-1 py-3 px-4 rounded-lg font-medium transition-colors flex items-center justify-center gap-2 ${opt.variant === "primary" ? "bg-indigo-600 hover:bg-indigo-500 text-white" :
                                    opt.variant === "warning" ? "bg-orange-600 hover:bg-orange-500 text-white" :
                                        opt.variant === "danger" ? "bg-red-600 hover:bg-red-500 text-white" :
                                            "bg-[#2a2a2a] hover:bg-[#333] text-gray-200"
                                }`}
                        >
                            {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
                            {opt.label}
                        </button>
                    ))}
                </div>
            </div>
        </div>
    );
}
