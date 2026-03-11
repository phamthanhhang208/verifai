import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import path from "path";

// Point to the agent's service-account.json so Firebase Admin picks it up
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  process.env.GOOGLE_APPLICATION_CREDENTIALS = path.resolve(
    process.cwd(),
    "../agent/service-account.json",
  );
}

if (getApps().length === 0) {
  initializeApp({ projectId: process.env.GCP_PROJECT_ID });
}

export const FIRESTORE_DATABASE_ID =
  process.env.FIRESTORE_DATABASE_ID || "(default)";
export const db = getFirestore(undefined, FIRESTORE_DATABASE_ID);
export const COLLECTION = process.env.FIRESTORE_COLLECTION || "reports";
