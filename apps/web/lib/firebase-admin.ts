import { cert, initializeApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import path from "path";

if (getApps().length === 0) {
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
    // Vercel / Cloud Run: inline service-account JSON stored in env var
    initializeApp({
      credential: cert(JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON)),
      projectId: process.env.GCP_PROJECT_ID,
    });
  } else {
    // Local dev: fall back to file path
    if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      process.env.GOOGLE_APPLICATION_CREDENTIALS = path.resolve(
        process.cwd(),
        "../agent/service-account.json",
      );
    }
    initializeApp({ projectId: process.env.GCP_PROJECT_ID });
  }
}

export const FIRESTORE_DATABASE_ID =
  process.env.FIRESTORE_DATABASE_ID || "(default)";
export const db = getFirestore(FIRESTORE_DATABASE_ID);
export const COLLECTION = process.env.FIRESTORE_COLLECTION || "reports";
