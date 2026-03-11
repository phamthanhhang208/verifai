#!/bin/bash
set -e

# ─── Config ──────────────────────────────────────────────
PROJECT_ID="${GCP_PROJECT_ID:?Set GCP_PROJECT_ID}"
REGION="${GCP_REGION:-us-central1}"
AGENT_SERVICE="verifai-agent"
REGISTRY="${REGION}-docker.pkg.dev/${PROJECT_ID}/verifai"

echo "╔════════════════════════════════════╗"
echo "║      Verifai Deployment            ║"
echo "╚════════════════════════════════════╝"

# ─── 1. Create Artifact Registry repo (idempotent) ──────
echo ""
echo "[1/5] Setting up Artifact Registry..."
gcloud artifacts repositories create verifai \
  --repository-format=docker \
  --location="${REGION}" \
  --project="${PROJECT_ID}" 2>/dev/null || true

# ─── 2. Build and push agent image ──────────────────────
echo ""
echo "[2/5] Building agent Docker image..."
docker build -t "${REGISTRY}/${AGENT_SERVICE}:latest" -f apps/agent/Dockerfile .
docker push "${REGISTRY}/${AGENT_SERVICE}:latest"

# ─── 3. Deploy agent to Cloud Run ───────────────────────
# Key settings:
#   --timeout=600     Sessions can take 2-5 min (rate limited Gemini calls)
#   --memory=2Gi      Playwright Chromium needs memory
#   --cpu=2           Parallel screenshot processing
#   --session-affinity  WebSocket connections must stick to one instance
#   --max-instances=3   Free tier friendly
echo ""
echo "[3/5] Deploying agent to Cloud Run..."
gcloud run deploy "${AGENT_SERVICE}" \
  --image="${REGISTRY}/${AGENT_SERVICE}:latest" \
  --region="${REGION}" \
  --project="${PROJECT_ID}" \
  --memory=2Gi \
  --cpu=2 \
  --timeout=600 \
  --concurrency=5 \
  --max-instances=3 \
  --session-affinity \
  --allow-unauthenticated \
  --set-env-vars="\
GEMINI_API_KEY=${GEMINI_API_KEY},\
GEMINI_CALL_DELAY_MS=${GEMINI_CALL_DELAY_MS:-2000},\
JIRA_BASE_URL=${JIRA_BASE_URL},\
JIRA_EMAIL=${JIRA_EMAIL},\
JIRA_API_TOKEN=${JIRA_API_TOKEN},\
JIRA_PROJECT_KEY=${JIRA_PROJECT_KEY},\
GCP_PROJECT_ID=${PROJECT_ID},\
GCS_BUCKET_NAME=${GCS_BUCKET_NAME:-verifai-screenshots},\
FIRESTORE_COLLECTION=${FIRESTORE_COLLECTION:-reports},\
PLAYWRIGHT_TIMEOUT_MS=${PLAYWRIGHT_TIMEOUT_MS:-30000},\
PLAYWRIGHT_NAVIGATION_TIMEOUT_MS=${PLAYWRIGHT_NAVIGATION_TIMEOUT_MS:-15000},\
CONFLUENCE_BASE_URL=${CONFLUENCE_BASE_URL},\
CONFLUENCE_EMAIL=${CONFLUENCE_EMAIL},\
CONFLUENCE_API_TOKEN=${CONFLUENCE_API_TOKEN},\
CORS_ORIGIN=${CORS_ORIGIN:-*},\
PORT=3001" \
  --set-secrets="GOOGLE_APPLICATION_CREDENTIALS_JSON=verifai-sa-key:latest"

# Get the Cloud Run URL
AGENT_URL=$(gcloud run services describe "${AGENT_SERVICE}" \
  --region="${REGION}" \
  --project="${PROJECT_ID}" \
  --format="value(status.url)")
echo ""
echo "✅ Agent deployed at: ${AGENT_URL}"

# ─── 4. Deploy web to Vercel ────────────────────────────
echo ""
echo "[4/5] Deploying web to Vercel..."
cd apps/web
NEXT_PUBLIC_AGENT_URL="${AGENT_URL}" \
  vercel --prod --yes \
  -e GCP_PROJECT_ID="${PROJECT_ID}" \
  -e FIRESTORE_COLLECTION="${FIRESTORE_COLLECTION:-reports}" \
  -e CONFLUENCE_BASE_URL="${CONFLUENCE_BASE_URL}" \
  -e CONFLUENCE_EMAIL="${CONFLUENCE_EMAIL}" \
  -e CONFLUENCE_API_TOKEN="${CONFLUENCE_API_TOKEN}"
cd ../..

# ─── 5. Summary ─────────────────────────────────────────
echo ""
echo "╔════════════════════════════════════╗"
echo "║      Deployment Complete!          ║"
echo "╠════════════════════════════════════╣"
echo "║ Agent: ${AGENT_URL}"
echo "║ Web:   Check Vercel dashboard"
echo "╚════════════════════════════════════╝"
echo ""
echo "Next steps:"
echo "  1. Store service-account.json in Secret Manager (one-time setup):"
echo "       gcloud secrets create verifai-sa-key --data-file=apps/agent/service-account.json --project=${PROJECT_ID}"
echo "       SA=\"\$(gcloud projects describe ${PROJECT_ID} --format='value(projectNumber)')-compute@developer.gserviceaccount.com\""
echo "       gcloud secrets add-iam-policy-binding verifai-sa-key --member=\"serviceAccount:\$SA\" --role=roles/secretmanager.secretAccessor --project=${PROJECT_ID}"
echo "  2. In Vercel dashboard → Settings → Env Vars, add:"
echo "       GOOGLE_APPLICATION_CREDENTIALS_JSON = <contents of apps/agent/service-account.json>"
