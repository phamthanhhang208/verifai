"use client";

import { useState, useRef } from "react";
import { Play, Square, Upload, Download, Radio, Gauge } from "lucide-react";

interface DemoControlsProps {
    /** Whether a demo recording is loaded and ready to play */
    hasRecording: boolean;
    /** Whether currently replaying a demo */
    isPlaying: boolean;
    /** Whether currently recording a live session */
    isRecording: boolean;
    /** Current playback speed */
    speed: number;
    onLoadRecording: (file: File) => void;
    onPlay: (speed: number) => void;
    onStop: () => void;
    onSpeedChange: (speed: number) => void;
    onDownloadRecording: () => void;
}

export function DemoControls({
    hasRecording,
    isPlaying,
    isRecording,
    speed,
    onLoadRecording,
    onPlay,
    onStop,
    onSpeedChange,
    onDownloadRecording,
}: DemoControlsProps) {
    const fileRef = useRef<HTMLInputElement>(null);

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) onLoadRecording(file);
    };

    return (
        <div className="fixed bottom-4 right-4 z-50 bg-gray-900/95 border border-indigo-500/30 rounded-xl p-3 shadow-2xl backdrop-blur-sm">
            <div className="flex items-center gap-2 mb-2">
                <Radio className="w-3 h-3 text-indigo-400" />
                <span className="text-xs font-medium text-indigo-400 uppercase tracking-wider">
                    Demo Mode
                </span>
                {isRecording && (
                    <span className="flex items-center gap-1 text-xs text-red-400">
                        <span className="w-2 h-2 bg-red-500 rounded-full animate-pulse" />
                        REC
                    </span>
                )}
            </div>

            <div className="flex items-center gap-2">
                {/* Load recording */}
                <input
                    ref={fileRef}
                    type="file"
                    accept=".json"
                    onChange={handleFileChange}
                    className="hidden"
                />
                <button
                    onClick={() => fileRef.current?.click()}
                    className="p-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-gray-200 transition-colors"
                    title="Load recording"
                >
                    <Upload className="w-3.5 h-3.5" />
                </button>

                {/* Play / Stop */}
                {isPlaying ? (
                    <button
                        onClick={onStop}
                        className="p-1.5 rounded-lg bg-red-500/20 hover:bg-red-500/30 text-red-400 transition-colors"
                        title="Stop replay"
                    >
                        <Square className="w-3.5 h-3.5" />
                    </button>
                ) : (
                    <button
                        onClick={() => onPlay(speed)}
                        disabled={!hasRecording}
                        className="p-1.5 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-400 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                        title="Play recording"
                    >
                        <Play className="w-3.5 h-3.5" />
                    </button>
                )}

                {/* Speed selector */}
                <div className="flex items-center gap-1">
                    <Gauge className="w-3 h-3 text-gray-500" />
                    <select
                        value={speed}
                        onChange={(e) => onSpeedChange(parseFloat(e.target.value))}
                        className="bg-gray-800 text-gray-300 text-xs rounded px-1.5 py-1 border border-gray-700"
                    >
                        <option value={0.3}>0.3x (fast)</option>
                        <option value={0.5}>0.5x</option>
                        <option value={0.7}>0.7x (rec.)</option>
                        <option value={1.0}>1.0x (real)</option>
                    </select>
                </div>

                {/* Download last recording */}
                <button
                    onClick={onDownloadRecording}
                    disabled={!isRecording && !hasRecording}
                    className="p-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-gray-200 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                    title="Download recording"
                >
                    <Download className="w-3.5 h-3.5" />
                </button>
            </div>
        </div>
    );
}
