import { CheckCircle2, Activity } from "lucide-react";
import Link from "next/link";
import { cn } from "@/lib/utils";

interface HeaderProps {
  currentScreen: 1 | 2 | 3;
}

const STEPS = [
  { id: 1 as const, label: "Configure" },
  { id: 2 as const, label: "Execute" },
  { id: 3 as const, label: "Results" },
];

export default function Header({ currentScreen }: HeaderProps) {
  return (
    <header className="sticky top-0 z-50 h-16 border-b border-gray-800 bg-[#0A0A0B]/90 backdrop-blur-sm">
      <div className="max-w-7xl mx-auto h-full px-6 flex items-center justify-between">
        {/* Logo */}
        <div className="flex items-center">
          <span className="text-white font-bold text-lg tracking-tight">Verif</span>
          <span className="text-indigo-400 font-bold text-lg tracking-tight">AI</span>
        </div>

        {/* Stepper */}
        <div className="flex items-center">
          {STEPS.map((step, index) => (
            <div key={step.id} className="flex items-center">
              {currentScreen > step.id ? (
                <div className="flex items-center gap-1.5 px-3">
                  <CheckCircle2 className="w-4 h-4 text-gray-400" />
                  <span className="text-sm text-gray-400">{step.label}</span>
                </div>
              ) : currentScreen === step.id ? (
                <div className="flex flex-col items-center px-3">
                  <span className="text-sm font-medium text-indigo-400">{step.label}</span>
                  <div className="h-0.5 w-full bg-indigo-500 rounded-full mt-0.5" />
                </div>
              ) : (
                <span className="text-sm text-gray-600 px-3">{step.label}</span>
              )}
              {index < STEPS.length - 1 && (
                <div className="w-8 h-px bg-gray-700" />
              )}
            </div>
          ))}
        </div>

        {/* Right Action */}
        <div className="flex items-center">
          <Link
            href="/runs"
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-400 hover:text-gray-200 bg-gray-800/50 hover:bg-gray-800 rounded-lg border border-gray-700/50 transition-colors"
          >
            <Activity className="w-3.5 h-3.5" />
            History
          </Link>
        </div>
      </div>
    </header>
  );
}
