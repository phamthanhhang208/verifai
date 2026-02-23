"use client";

import { useState } from "react";
import { Link2, Monitor, Loader2, ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";

interface ConfigureScreenProps {
  onSubmit: (source: string, targetUrl: string) => void;
  isLoading: boolean;
}

export default function ConfigureScreen({ onSubmit, isLoading }: ConfigureScreenProps) {
  const [source, setSource] = useState("");
  const [targetUrl, setTargetUrl] = useState("");

  const isDisabled = !source.trim() || !targetUrl.trim() || isLoading;

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
                placeholder="Jira Ticket ID (e.g. ACM-8892)"
                disabled={isLoading}
                className={cn(
                  "w-full bg-[#1A1C20] border border-gray-800 rounded-xl pl-10 pr-4 py-3",
                  "text-sm text-white placeholder:text-gray-600",
                  "focus:outline-none focus:border-indigo-500 transition-colors",
                  "disabled:opacity-50 disabled:cursor-not-allowed"
                )}
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
                className={cn(
                  "w-full bg-[#1A1C20] border border-gray-800 rounded-xl pl-10 pr-4 py-3",
                  "text-sm text-white placeholder:text-gray-600",
                  "focus:outline-none focus:border-indigo-500 transition-colors",
                  "disabled:opacity-50 disabled:cursor-not-allowed"
                )}
              />
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end mt-8">
          <button
            onClick={() => !isDisabled && onSubmit(source.trim(), targetUrl.trim())}
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
