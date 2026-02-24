"use client";

import { useState } from "react";
import { Link2, Monitor, Loader2, ArrowRight, Key } from "lucide-react";
import { cn } from "@/lib/utils";

interface ConfigureScreenProps {
  onSubmit: (source: string, targetUrl: string, geminiApiKey: string) => void;
  isLoading: boolean;
  error?: string | null;
  geminiApiKey: string;
  onGeminiKeyChange: (key: string) => void;
}

export default function ConfigureScreen({
  onSubmit,
  isLoading,
  error,
  geminiApiKey,
  onGeminiKeyChange,
}: ConfigureScreenProps) {
  const [source, setSource] = useState("KAN-5");
  const [targetUrl, setTargetUrl] = useState("https://www.saucedemo.com/");

  const isDisabled = !source.trim() || !targetUrl.trim() || isLoading;

  const inputClass = cn(
    "w-full bg-[#1A1C20] border border-gray-800 rounded-xl pl-10 pr-4 py-3",
    "text-sm text-white placeholder:text-gray-600",
    "focus:outline-none focus:border-indigo-500 transition-colors",
    "disabled:opacity-50 disabled:cursor-not-allowed"
  );

  return (
    <main className="min-h-[calc(100vh-64px)] flex items-center justify-center px-4">
      <div className="w-full max-w-2xl bg-[#141517] rounded-2xl p-8 card-glow">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-xl font-semibold text-white">Create New Test Run</h1>
          <p className="mt-1 text-sm text-gray-400">Configure your AI-powered test session</p>
        </div>

        {/* Inputs */}
        <div className="space-y-5">
          {/* Source Specification */}
          <div className="space-y-2">
            <label className="block text-sm text-gray-400">Source Specification</label>
            <div className="relative">
              <Link2 className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
              <input
                type="text"
                value={source}
                onChange={(e) => setSource(e.target.value)}
                placeholder="Jira Ticket ID (e.g. KAN-5) or paste spec text"
                disabled={isLoading}
                className={inputClass}
              />
            </div>
          </div>

          {/* Target URL */}
          <div className="space-y-2">
            <label className="block text-sm text-gray-400">Target Application URL</label>
            <div className="relative">
              <Monitor className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
              <input
                type="url"
                value={targetUrl}
                onChange={(e) => setTargetUrl(e.target.value)}
                placeholder="https://staging.acme.com"
                disabled={isLoading}
                className={inputClass}
              />
            </div>
          </div>

          {/* Gemini API Key */}
          <div className="space-y-2">
            <label className="block text-sm text-gray-400">
              Gemini API Key
              <span className="ml-2 text-xs text-gray-600">(optional — falls back to server key)</span>
            </label>
            <div className="relative">
              <Key className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
              <input
                type="password"
                value={geminiApiKey}
                onChange={(e) => onGeminiKeyChange(e.target.value)}
                placeholder="AIza..."
                disabled={isLoading}
                className={inputClass}
              />
            </div>
          </div>
        </div>

        {/* Error */}
        {error && (
          <p className="mt-6 text-sm text-red-400 bg-red-950/40 border border-red-800/50 rounded-lg px-4 py-3">
            {error}
          </p>
        )}

        {/* Footer */}
        <div className="flex justify-end mt-4">
          <button
            onClick={() => !isDisabled && onSubmit(source.trim(), targetUrl.trim(), geminiApiKey.trim())}
            disabled={isDisabled}
            className={cn(
              "flex items-center gap-2 px-6 py-2.5 rounded-lg",
              "bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium",
              "transition-all duration-200",
              "disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-indigo-600"
            )}
          >
            {isLoading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Parsing specification...
              </>
            ) : (
              <>
                Generate Test Plan
                <ArrowRight className="w-4 h-4" />
              </>
            )}
          </button>
        </div>
      </div>
    </main>
  );
}
