import { NextRequest, NextResponse } from "next/server";
import { db, COLLECTION } from "@/lib/firebase-admin";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const limit = Math.min(parseInt(searchParams.get("limit") || "20"), 50);
    const startAfter = searchParams.get("startAfter"); // ISO date for pagination

    let query = db
      .collection(COLLECTION)
      .orderBy("completedAt", "desc")
      .limit(limit);

    if (startAfter) {
      query = query.startAfter(startAfter);
    }

    const snapshot = await query.get();
    const runs = snapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        targetUrl: data.targetUrl || "",
        sourceTicket: data.sourceTicket || "",
        reportStatus: data.reportStatus || "passed",
        totalSteps: data.totalSteps || 0,
        passedSteps: data.passedSteps || 0,
        failedSteps: data.failedSteps || 0,
        incompleteSteps: data.incompleteSteps || 0,
        passRate: data.passRate || 0,
        bugCount: data.bugs?.length || 0,
        summary: data.summary || "",
        completedAt: data.completedAt || "",
        createdAt: data.createdAt || "",
      };
    });

    // Check if there are more results
    const hasMore = runs.length === limit;

    return NextResponse.json({ runs, hasMore });
  } catch (error: any) {
    console.error("[Runs] List error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
