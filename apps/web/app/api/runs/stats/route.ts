import { NextResponse } from "next/server";
import { db, COLLECTION } from "@/lib/firebase-admin";

export async function GET() {
  try {
    const snapshot = await db.collection(COLLECTION).get();

    let totalRuns = 0;
    let totalBugs = 0;
    let totalPassRate = 0;
    let passedRuns = 0;
    let failedRuns = 0;
    let incompleteRuns = 0;

    snapshot.forEach((doc) => {
      const data = doc.data();
      totalRuns++;
      totalBugs += data.bugs?.length || 0;
      totalPassRate += data.passRate || 0;

      if (data.reportStatus === "passed") passedRuns++;
      else if (data.reportStatus === "failed") failedRuns++;
      else incompleteRuns++;
    });

    return NextResponse.json({
      totalRuns,
      totalBugs,
      avgPassRate:
        totalRuns > 0 ? Math.round((totalPassRate / totalRuns) * 10) / 10 : 0,
      passedRuns,
      failedRuns,
      incompleteRuns,
    });
  } catch (error: any) {
    console.error("[Runs] Stats error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
