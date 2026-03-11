import { NextRequest, NextResponse } from "next/server";
import { db, COLLECTION } from "@/lib/firebase-admin";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const doc = await db.collection(COLLECTION).doc(id).get();

    if (!doc.exists) {
      return NextResponse.json({ error: "Report not found" }, { status: 404 });
    }

    return NextResponse.json(doc.data());
  } catch (error: any) {
    console.error("[API] Report fetch error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
