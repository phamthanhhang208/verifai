"use client";

import { useState } from "react";
import {
  Link2,
  Monitor,
  Loader2,
  ArrowRight,
  Key,
  BookOpen,
  PenTool,
  Search,
  ExternalLink,
} from "lucide-react";
import { cn } from "@/lib/utils";

type SourceTab = "jira" | "confluence" | "manual";

interface ConfigureScreenProps {
  onSubmit: (input: {
    source: SourceTab;
    specText: string;
    targetUrl: string;
    sourceLabel: string;
    geminiApiKey: string;
  }) => void;
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
  const [activeTab, setActiveTab] = useState<SourceTab>("jira");

  // Common
  const [targetUrl, setTargetUrl] = useState("https://www.saucedemo.com/");

  // Jira state
  const [jiraTicketId, setJiraTicketId] = useState("KAN-5");

  // Confluence state
  const [confluenceInput, setConfluenceInput] = useState("");
  const [includeChildPages, setIncludeChildPages] = useState(false);
  const [confluenceContent, setConfluenceContent] = useState<{
    title: string;
    content: string;
    url: string;
    childPageCount: number;
  } | null>(null);
  const [confluenceLoading, setConfluenceLoading] = useState(false);
  const [confluenceError, setConfluenceError] = useState("");

  // Manual state
  const [manualText, setManualText] = useState("");

  const tabs: {
    id: SourceTab;
    label: string;
    icon: typeof Link2;
    desc: string;
  }[] = [
    {
      id: "jira",
      label: "Jira Ticket",
      icon: Link2,
      desc: "Import from Jira issue",
    },
    {
      id: "confluence",
      label: "Confluence",
      icon: BookOpen,
      desc: "Import from Confluence page",
    },
    {
      id: "manual",
      label: "Manual",
      icon: PenTool,
      desc: "Paste spec text directly",
    },
  ];

  const inputClass = cn(
    "w-full bg-[#1A1C20] border border-gray-800 rounded-xl pl-10 pr-4 py-3",
    "text-sm text-white placeholder:text-gray-600",
    "focus:outline-none focus:border-indigo-500 transition-colors",
    "disabled:opacity-50 disabled:cursor-not-allowed",
  );

  // ─── Confluence: Fetch page content ───────────────────
  async function handleFetchConfluence() {
    if (!confluenceInput.trim()) return;

    setConfluenceLoading(true);
    setConfluenceError("");
    setConfluenceContent(null);

    try {
      const res = await fetch("/api/confluence/fetch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pageUrl: confluenceInput.includes("http")
            ? confluenceInput
            : undefined,
          pageId: !confluenceInput.includes("http")
            ? confluenceInput
            : undefined,
          includeChildPages,
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to fetch Confluence page");
      }

      const data = await res.json();
      setConfluenceContent({
        title: data.page.title,
        content: data.content,
        url: data.page.url,
        childPageCount: data.childPageCount,
      });
    } catch (err: any) {
      setConfluenceError(err.message);
    } finally {
      setConfluenceLoading(false);
    }
  }

  // ─── Submit handler ───────────────────────────────────
  function handleSubmit() {
    if (!targetUrl.trim()) return;

    if (activeTab === "jira" && jiraTicketId.trim()) {
      onSubmit({
        source: "jira",
        specText: jiraTicketId.trim(),
        targetUrl: targetUrl.trim(),
        sourceLabel: jiraTicketId.trim(),
        geminiApiKey: geminiApiKey.trim(),
      });
    } else if (activeTab === "confluence" && confluenceContent) {
      onSubmit({
        source: "confluence",
        specText: confluenceContent.content,
        targetUrl: targetUrl.trim(),
        sourceLabel: confluenceContent.title,
        geminiApiKey: geminiApiKey.trim(),
      });
    } else if (activeTab === "manual" && manualText.trim()) {
      onSubmit({
        source: "manual",
        specText: manualText.trim(),
        targetUrl: targetUrl.trim(),
        sourceLabel: "Manual Input",
        geminiApiKey: geminiApiKey.trim(),
      });
    }
  }

  const canSubmit =
    targetUrl.trim() &&
    !isLoading &&
    ((activeTab === "jira" && jiraTicketId.trim()) ||
      (activeTab === "confluence" && confluenceContent) ||
      (activeTab === "manual" && manualText.trim()));

  return (
    <main className="min-h-[calc(100vh-64px)] flex items-center justify-center px-4">
      <div className="w-full max-w-2xl bg-[#141517] rounded-2xl p-8 card-glow">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-xl font-semibold text-white">
            Create New Test Run
          </h1>
          <p className="mt-1 text-sm text-gray-400">
            Configure your AI-powered test session
          </p>
        </div>

        {/* Inputs */}
        <div className="space-y-5">
          {/* Target URL */}
          <div className="space-y-2">
            <label className="block text-sm text-gray-400">
              Target Application URL
            </label>
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

          {/* ─── Source Tabs ─────────────────────────────── */}
          <div className="space-y-3">
            <label className="block text-sm text-gray-400">
              Test Specification Source
            </label>
            <div className="flex gap-2">
              {tabs.map((tab) => {
                const Icon = tab.icon;
                const isActive = activeTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    disabled={isLoading}
                    className={cn(
                      "flex-1 flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl border text-sm font-medium transition-all duration-200",
                      isActive
                        ? "bg-indigo-500/15 border-indigo-500/40 text-indigo-400"
                        : "bg-[#1A1C20] border-gray-800 text-gray-500 hover:text-gray-300 hover:border-gray-600",
                      "disabled:opacity-50 disabled:cursor-not-allowed",
                    )}
                  >
                    <Icon className="w-4 h-4" />
                    {tab.label}
                  </button>
                );
              })}
            </div>

            {/* ─── Tab Content ─────────────────────────── */}
            <div className="min-h-[160px]">
              {/* JIRA TAB */}
              {activeTab === "jira" && (
                <div className="space-y-3">
                  {/* Demo disclaimer */}
                  <div className="rounded-lg border border-indigo-500/20 bg-indigo-500/5 px-4 py-3">
                    <p className="text-xs font-semibold text-indigo-300 mb-1">
                      🧪 Demo mode
                    </p>
                    <p className="text-xs text-gray-400 mb-2">
                      Try these sample tickets — each demos a different Verifai capability:
                    </p>
                    <ul className="text-xs text-gray-400 space-y-1">
                      <li>
                        <span className="text-indigo-400 font-mono">KAN-65</span>{" "}
                        · Login flow — verifies that <span className="text-yellow-400/80">locked_out_user</span> is correctly blocked
                      </li>
                      <li>
                        <span className="text-indigo-400 font-mono">KAN-47</span>{" "}
                        · Checkout flow — triggers a real bug + HITL confirmation on <span className="text-yellow-400/80">problem_user</span>
                      </li>
                      <li>
                        <span className="text-indigo-400 font-mono">KAN-5</span>{" "}
                        · Happy path — end-to-end smoke test for a clean purchase
                      </li>
                    </ul>
                  </div>
                  <div className="relative">
                    <Link2 className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
                    <input
                      type="text"
                      value={jiraTicketId}
                      onChange={(e) => setJiraTicketId(e.target.value)}
                      placeholder="PROJ-123"
                      disabled={isLoading}
                      className={inputClass}
                    />
                  </div>
                  <p className="text-xs text-gray-600">
                    Enter a Jira ticket ID. Verifai will read the summary,
                    description, and acceptance criteria.
                  </p>
                </div>
              )}

              {/* CONFLUENCE TAB */}
              {activeTab === "confluence" && (
                <div className="space-y-3">
                  <div className="rounded-lg border border-indigo-500/20 bg-indigo-500/5 px-4 py-3">
                    <p className="text-xs font-semibold text-indigo-300 mb-1">
                      🧪 Demo mode
                    </p>
                    <p className="text-xs text-gray-400 mb-2">
                      Try this sample Confluence spec page to quickly preview
                      Verifai's parsing and test-plan generation.
                    </p>
                    <div className="flex items-center justify-between gap-2">
                      <a
                        href="https://xmichiyo99-1772436510775.atlassian.net/wiki/spaces/SD/pages/294914/SauceDemo+Product+Specification"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-indigo-400 hover:text-indigo-300 truncate"
                      >
                        SauceDemo Product Specification
                      </a>
                      <button
                        type="button"
                        onClick={() =>
                          setConfluenceInput(
                            "https://xmichiyo99-1772436510775.atlassian.net/wiki/spaces/SD/pages/294914/SauceDemo+Product+Specification",
                          )
                        }
                        disabled={isLoading || confluenceLoading}
                        className="shrink-0 text-xs text-indigo-300 hover:text-indigo-200 border border-indigo-500/30 hover:border-indigo-400/40 px-2 py-1 rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        Use demo page
                      </button>
                    </div>
                  </div>

                  <div className="flex gap-2">
                    <div className="relative flex-1">
                      <BookOpen className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
                      <input
                        type="text"
                        value={confluenceInput}
                        onChange={(e) => setConfluenceInput(e.target.value)}
                        placeholder="Page URL or numeric page ID"
                        disabled={isLoading || confluenceLoading}
                        className={inputClass}
                      />
                    </div>
                    <button
                      onClick={handleFetchConfluence}
                      disabled={
                        !confluenceInput.trim() ||
                        confluenceLoading ||
                        isLoading
                      }
                      className={cn(
                        "flex items-center gap-2 px-4 py-2.5 rounded-xl border text-sm font-medium transition-all duration-200",
                        "bg-indigo-500/15 border-indigo-500/30 text-indigo-400 hover:bg-indigo-500/25",
                        "disabled:opacity-40 disabled:cursor-not-allowed",
                      )}
                    >
                      {confluenceLoading ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Search className="w-4 h-4" />
                      )}
                      Fetch
                    </button>
                  </div>

                  {/* Include child pages toggle */}
                  <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={includeChildPages}
                      onChange={(e) => setIncludeChildPages(e.target.checked)}
                      className="rounded border-gray-600 bg-gray-800 text-indigo-500 focus:ring-indigo-500/50 w-3.5 h-3.5"
                    />
                    Include child pages (subpages under this page)
                  </label>

                  {/* Error */}
                  {confluenceError && (
                    <div className="p-3 bg-red-950/40 border border-red-800/50 rounded-xl text-red-400 text-sm">
                      {confluenceError}
                    </div>
                  )}

                  {/* Fetched content preview */}
                  {confluenceContent && (
                    <div className="p-4 bg-[#1A1C20] border border-gray-800 rounded-xl space-y-2">
                      <div className="flex items-center justify-between">
                        <h4 className="text-sm font-medium text-gray-200 truncate pr-4">
                          {confluenceContent.title}
                        </h4>
                        <a
                          href={confluenceContent.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-indigo-400 hover:text-indigo-300 flex items-center gap-1 shrink-0"
                        >
                          Open <ExternalLink className="w-3 h-3" />
                        </a>
                      </div>
                      {confluenceContent.childPageCount > 0 && (
                        <p className="text-xs text-emerald-400">
                          + {confluenceContent.childPageCount} child page(s)
                          included
                        </p>
                      )}
                      <div className="max-h-36 overflow-y-auto text-xs text-gray-400 font-mono bg-black/30 rounded-lg p-3">
                        {confluenceContent.content.slice(0, 1500)}
                        {confluenceContent.content.length > 1500 && (
                          <span className="text-gray-600">
                            {"\n\n"}... (
                            {Math.round(
                              confluenceContent.content.length / 1000,
                            )}
                            k chars total)
                          </span>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* MANUAL TAB */}
              {activeTab === "manual" && (
                <div className="space-y-2">
                  <textarea
                    value={manualText}
                    onChange={(e) => setManualText(e.target.value)}
                    placeholder={`Describe the test scenario. For example:\n\nLogin with username standard_user and password secret_sauce.\nAdd Sauce Labs Backpack to the cart.\nGo to the cart and verify the item is there.\nProceed to checkout.`}
                    rows={6}
                    disabled={isLoading}
                    className={cn(
                      "w-full bg-[#1A1C20] border border-gray-800 rounded-xl px-4 py-3",
                      "text-sm text-white placeholder:text-gray-600",
                      "focus:outline-none focus:border-indigo-500 transition-colors resize-none",
                      "disabled:opacity-50 disabled:cursor-not-allowed",
                    )}
                  />
                  <p className="text-xs text-gray-600">
                    Describe acceptance criteria, user flows, or test steps in
                    plain language.
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* Gemini API Key */}
          <div className="space-y-2">
            <label className="block text-sm text-gray-400">
              Gemini API Key
              <span className="ml-2 text-xs text-gray-600">
                (optional — falls back to server key)
              </span>
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
            onClick={handleSubmit}
            disabled={!canSubmit}
            className={cn(
              "flex items-center gap-2 px-6 py-2.5 rounded-lg",
              "bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium",
              "transition-all duration-200",
              "disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-indigo-600",
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
