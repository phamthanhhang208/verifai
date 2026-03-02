import { NextRequest, NextResponse } from "next/server";
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

if (getApps().length === 0) {
    initializeApp({ projectId: process.env.GCP_PROJECT_ID });
}
const db = getFirestore();
const COLLECTION = process.env.FIRESTORE_COLLECTION || "reports";

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
            avgPassRate: totalRuns > 0 ? Math.round((totalPassRate / totalRuns) * 10) / 10 : 0,
            passedRuns,
            failedRuns,
            incompleteRuns,
        });
    } catch (error: any) {
        console.error("[Runs] Stats error:", error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
