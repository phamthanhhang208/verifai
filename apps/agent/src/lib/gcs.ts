import { Storage } from "@google-cloud/storage";

const storage = new Storage({
  projectId: process.env.GCP_PROJECT_ID,
});
const bucketName = process.env.GCS_BUCKET_NAME || "verifai-screenshots";

export async function uploadScreenshot(
  base64: string,
  sessionId: string,
  stepId: string
): Promise<string> {
  const bucket = storage.bucket(bucketName);
  const filename = `screenshots/${sessionId}/${stepId}-${Date.now()}.jpg`;
  const file = bucket.file(filename);

  const buffer = Buffer.from(base64, "base64");

  await file.save(buffer, {
    contentType: "image/jpeg",
    metadata: {
      cacheControl: "public, max-age=31536000",
    },
  });

  // Make publicly readable
  await file.makePublic();

  return `https://storage.googleapis.com/${bucketName}/${filename}`;
}
