import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Verifai — AI QA Agent",
  description: "AI-powered QA agent that autonomously tests web applications",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
