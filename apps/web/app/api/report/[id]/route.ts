import { NextRequest, NextResponse } from "next/server";
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

// Initialize Firebase Admin for Next.js API route
if (getApps().length === 0) {
  initializeApp({ projectId: process.env.GCP_PROJECT_ID });
}
const db = getFirestore();

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const doc = await db
      .collection(process.env.FIRESTORE_COLLECTION || "reports")
      .doc(id)
      .get();

    if (!doc.exists) {
      return NextResponse.json({ error: "Report not found" }, { status: 404 });
    }

    return NextResponse.json(doc.data());
  } catch (error: any) {
    console.error("[API] Report fetch error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
