import { NextRequest, NextResponse } from "next/server";
import jsPDF from "jspdf";
import type { BugReport, TestStep, Bug } from "@verifai/types";

export async function POST(req: NextRequest) {
  try {
    const report: BugReport = await req.json();
    const pdf = generateReportPDF(report);
    const buffer = Buffer.from(pdf.output("arraybuffer"));

    return new NextResponse(buffer, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="verifai-report-${report.id}.pdf"`,
      },
    });
  } catch (error: any) {
    console.error("[PDF] Generation failed:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

function generateReportPDF(report: BugReport): jsPDF {
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 20;
  const contentWidth = pageWidth - margin * 2;
  let y = margin;

  // ─── Colors ───────────────────────────────────────────
  const colors = {
    primary: [99, 102, 241] as [number, number, number],     // indigo
    passed: [16, 185, 129] as [number, number, number],      // emerald
    failed: [244, 63, 94] as [number, number, number],       // rose
    incomplete: [245, 158, 11] as [number, number, number],  // amber
    text: [31, 41, 55] as [number, number, number],          // gray-800
    lightText: [107, 114, 128] as [number, number, number],  // gray-500
    bg: [249, 250, 251] as [number, number, number],         // gray-50
    border: [229, 231, 235] as [number, number, number],     // gray-200
  };

  // ─── Helper: Check page break ─────────────────────────
  function checkPageBreak(needed: number) {
    if (y + needed > pageHeight - margin) {
      doc.addPage();
      y = margin;
    }
  }

  // ─── Helper: Draw a horizontal rule ───────────────────
  function drawHR() {
    doc.setDrawColor(...colors.border);
    doc.setLineWidth(0.3);
    doc.line(margin, y, pageWidth - margin, y);
    y += 4;
  }

  // ─── HEADER ───────────────────────────────────────────
  // Logo/title
  doc.setFontSize(24);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(...colors.primary);
  doc.text("Verifai", margin, y);

  // Subtitle
  doc.setFontSize(10);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(...colors.lightText);
  doc.text("AI-Powered QA Report", margin + 38, y);

  // Report status badge
  const statusColor =
    report.reportStatus === "passed" ? colors.passed
    : report.reportStatus === "failed" ? colors.failed
    : colors.incomplete;
  const statusLabel =
    report.reportStatus === "passed" ? "PASSED"
    : report.reportStatus === "failed" ? "FAILED"
    : "INCOMPLETE";

  doc.setFillColor(...statusColor);
  const badgeWidth = doc.getTextWidth(statusLabel) + 8;
  doc.roundedRect(pageWidth - margin - badgeWidth, y - 7, badgeWidth, 10, 2, 2, "F");
  doc.setFontSize(9);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(255, 255, 255);
  doc.text(statusLabel, pageWidth - margin - badgeWidth + 4, y);

  y += 10;
  drawHR();

  // ─── META ─────────────────────────────────────────────
  doc.setFontSize(9);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(...colors.lightText);

  const metaLines = [
    `Target: ${report.targetUrl}`,
    `Source Ticket: ${report.sourceTicket || "Manual input"}`,
    `Generated: ${new Date(report.completedAt).toLocaleString()}`,
    `Report ID: ${report.id}`,
  ];

  for (const line of metaLines) {
    doc.text(line, margin, y);
    y += 5;
  }
  y += 4;

  // ─── SUMMARY ──────────────────────────────────────────
  doc.setFillColor(...colors.bg);
  doc.roundedRect(margin, y, contentWidth, 14, 2, 2, "F");
  doc.setFontSize(9);
  doc.setFont("helvetica", "italic");
  doc.setTextColor(...colors.text);
  const summaryLines = doc.splitTextToSize(report.summary || "No summary available.", contentWidth - 8);
  doc.text(summaryLines, margin + 4, y + 6);
  y += Math.max(14, summaryLines.length * 5 + 6);
  y += 6;

  // ─── METRICS GRID ─────────────────────────────────────
  doc.setFontSize(12);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(...colors.text);
  doc.text("Summary", margin, y);
  y += 8;

  const metricBoxWidth = (contentWidth - 6) / 4;
  const metrics = [
    { label: "Passed", value: String(report.passedSteps), color: colors.passed },
    { label: "Failed", value: String(report.failedSteps), color: colors.failed },
    { label: "Incomplete", value: String(report.incompleteSteps), color: colors.incomplete },
    { label: "Pass Rate", value: `${report.passRate}%`, color: colors.primary },
  ];

  for (let i = 0; i < metrics.length; i++) {
    const mx = margin + i * (metricBoxWidth + 2);
    doc.setDrawColor(...colors.border);
    doc.setLineWidth(0.3);
    doc.roundedRect(mx, y, metricBoxWidth, 20, 2, 2, "S");

    // Colored top border
    doc.setDrawColor(...metrics[i].color);
    doc.setLineWidth(1);
    doc.line(mx + 2, y, mx + metricBoxWidth - 2, y);

    // Value
    doc.setFontSize(16);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(...metrics[i].color);
    doc.text(metrics[i].value, mx + metricBoxWidth / 2, y + 10, { align: "center" });

    // Label
    doc.setFontSize(7);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(...colors.lightText);
    doc.text(metrics[i].label, mx + metricBoxWidth / 2, y + 16, { align: "center" });
  }

  y += 28;

  // ─── TEST STEPS TABLE ─────────────────────────────────
  doc.setFontSize(12);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(...colors.text);
  doc.text("Test Steps", margin, y);
  y += 7;

  // Table header
  doc.setFillColor(243, 244, 246);
  doc.rect(margin, y, contentWidth, 7, "F");
  doc.setFontSize(7);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(...colors.lightText);
  doc.text("#", margin + 2, y + 5);
  doc.text("Step", margin + 10, y + 5);
  doc.text("Expected", margin + 95, y + 5);
  doc.text("Status", margin + contentWidth - 18, y + 5);
  y += 9;

  // Table rows
  for (let i = 0; i < report.steps.length; i++) {
    const step = report.steps[i];
    checkPageBreak(12);

    // Alternating row bg
    if (i % 2 === 0) {
      doc.setFillColor(249, 250, 251);
      doc.rect(margin, y - 1, contentWidth, 9, "F");
    }

    doc.setFontSize(7);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(...colors.text);

    // Step number
    doc.text(String(i + 1), margin + 2, y + 4);

    // Step text (truncated)
    const stepText = step.text.length > 55 ? step.text.slice(0, 52) + "..." : step.text;
    doc.text(stepText, margin + 10, y + 4);

    // Expected (truncated)
    const expected = step.expectedBehavior.length > 35
      ? step.expectedBehavior.slice(0, 32) + "..."
      : step.expectedBehavior;
    doc.text(expected, margin + 95, y + 4);

    // Status badge
    const sColor =
      step.status === "passed" ? colors.passed
      : step.status === "failed" ? colors.failed
      : step.status === "incomplete" ? colors.incomplete
      : colors.lightText;

    const sLabel =
      step.status === "passed" ? "PASS"
      : step.status === "failed" ? "FAIL"
      : step.status === "incomplete" ? "SKIP"
      : step.status.toUpperCase();

    doc.setFillColor(...sColor);
    const sBadgeW = 12;
    doc.roundedRect(margin + contentWidth - 20, y, sBadgeW, 7, 1, 1, "F");
    doc.setFontSize(6);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(255, 255, 255);
    doc.text(sLabel, margin + contentWidth - 20 + sBadgeW / 2, y + 5, { align: "center" });

    y += 9;
  }

  y += 6;

  // ─── BUGS SECTION ─────────────────────────────────────
  const failedBugs = report.bugs.filter(b => b.failureType === "assertion" || !b.failureType);

  if (failedBugs.length > 0) {
    checkPageBreak(20);
    doc.setFontSize(12);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(...colors.failed);
    doc.text(`Issues Found (${failedBugs.length})`, margin, y);
    y += 8;

    for (const bug of failedBugs) {
      checkPageBreak(40);

      // Bug card background
      doc.setFillColor(255, 241, 242); // rose-50
      doc.setDrawColor(...colors.failed);
      doc.setLineWidth(0.3);
      doc.roundedRect(margin, y, contentWidth, 34, 2, 2, "FD");

      // Bug title
      doc.setFontSize(9);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(...colors.failed);
      const titleTrunc = bug.title.length > 70 ? bug.title.slice(0, 67) + "..." : bug.title;
      doc.text(titleTrunc, margin + 4, y + 6);

      // Severity badge
      const sevColor =
        bug.severity === "high" ? colors.failed
        : bug.severity === "medium" ? colors.incomplete
        : colors.lightText;
      doc.setFillColor(...sevColor);
      const sevLabel = bug.severity.toUpperCase();
      const sevW = doc.getTextWidth(sevLabel) + 6;
      doc.roundedRect(pageWidth - margin - sevW - 4, y + 1, sevW, 7, 1, 1, "F");
      doc.setFontSize(6);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(255, 255, 255);
      doc.text(sevLabel, pageWidth - margin - sevW / 2 - 4, y + 6, { align: "center" });

      // Expected vs Actual
      doc.setFontSize(7);
      doc.setFont("helvetica", "normal");
      doc.setTextColor(...colors.text);

      const expectedText = `Expected: ${bug.expectedBehavior}`;
      const actualText = `Actual: ${bug.actualBehavior}`;
      const expTrunc = expectedText.length > 100 ? expectedText.slice(0, 97) + "..." : expectedText;
      const actTrunc = actualText.length > 100 ? actualText.slice(0, 97) + "..." : actualText;

      doc.text(expTrunc, margin + 4, y + 14);
      doc.text(actTrunc, margin + 4, y + 20);

      // Jira ticket link (if available)
      if (bug.jiraTicketKey) {
        doc.setFontSize(7);
        doc.setTextColor(...colors.primary);
        doc.text(`Jira: ${bug.jiraTicketKey}`, margin + 4, y + 28);
        if (bug.jiraTicketUrl) {
          doc.link(margin + 4, y + 24, 40, 6, { url: bug.jiraTicketUrl });
        }
      }

      // Screenshot URL (if available)
      if (bug.screenshotUrl) {
        doc.setFontSize(6);
        doc.setTextColor(...colors.lightText);
        doc.text("Screenshot attached in Jira ticket", margin + 60, y + 28);
      }

      y += 38;
    }
  }

  // ─── INCOMPLETE STEPS SECTION ─────────────────────────
  const incompleteSteps = report.steps.filter(s => s.status === "incomplete");

  if (incompleteSteps.length > 0) {
    checkPageBreak(20);
    y += 4;
    doc.setFontSize(12);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(...colors.incomplete);
    doc.text(`Incomplete Steps (${incompleteSteps.length})`, margin, y);
    y += 8;

    for (const step of incompleteSteps) {
      checkPageBreak(14);

      doc.setFillColor(255, 251, 235); // amber-50
      doc.setDrawColor(...colors.incomplete);
      doc.setLineWidth(0.3);
      doc.roundedRect(margin, y, contentWidth, 12, 2, 2, "FD");

      doc.setFontSize(8);
      doc.setFont("helvetica", "normal");
      doc.setTextColor(...colors.text);
      doc.text(step.text, margin + 4, y + 5);

      // Reason chip
      const reason = step.incompleteReason === "rate_limit" ? "Rate Limited"
        : step.incompleteReason === "timeout" ? "Timeout"
        : step.incompleteReason === "crash" ? "Error"
        : "Skipped";
      doc.setFillColor(...colors.incomplete);
      const rW = doc.getTextWidth(reason) + 6;
      doc.roundedRect(pageWidth - margin - rW - 4, y + 2, rW, 7, 1, 1, "F");
      doc.setFontSize(6);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(255, 255, 255);
      doc.text(reason, pageWidth - margin - rW / 2 - 4, y + 7, { align: "center" });

      y += 15;
    }
  }

  // ─── FOOTER ───────────────────────────────────────────
  const totalPages = doc.getNumberOfPages();
  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p);
    doc.setFontSize(7);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(...colors.lightText);
    doc.text(
      `Generated by Verifai — AI-Powered QA Agent`,
      margin,
      pageHeight - 10
    );
    doc.text(
      `Page ${p} of ${totalPages}`,
      pageWidth - margin,
      pageHeight - 10,
      { align: "right" }
    );
  }

  return doc;
}
