# Verifai — AI-Powered QA Agent

> Built for the Gemini Live Agent Challenge hackathon

Verifai is an autonomous QA agent that reads Jira tickets, navigates live web applications using AI vision, finds bugs, and auto-creates Jira tickets with screenshots.

## How It Works

1. **Configure** — Enter a Jira ticket ID (or paste spec text) + target URL
2. **AI parses the spec** into a sequential test plan (5-7 steps)
3. **For each step**, the agent:
   - Takes a screenshot of the current browser state
   - Sends it to Gemini 3 Flash (Computer Use) to decide the next action
   - Executes the action via Playwright (click, type, scroll, navigate)
   - Verifies the result with Gemini 2.5 Flash Lite
4. **Reports** bugs with screenshots, expected vs actual behavior, and auto-created Jira tickets

**Simulation Tickets**: https://docs.google.com/spreadsheets/d/1j0AUvxSyCdNytiWE141tgbuf2KhZlE0N/edit?usp=sharing&ouid=108633293263262860350&rtpof=true&sd=true

## Key Features

- **Autonomous Web Testing**: AI vision navigates the DOM, clicks, types, and verifies outcomes.
- **Human-in-the-Loop (HITL)**: Agent pauses and asks for human confirmation if its action or verification confidence is low.
- **Test History Dashboard**: Explore past runs, review metrics, and find aggregated bug reports.
- **Presentation Demo Mode**: Record and replay AI sessions perfectly to avoid live latency.

## Architecture

Verifai is built on a real-time, WebSocket-first architecture connecting a Next.js frontend to a Node.js Agent running Playwright and Gemini.

For a detailed breakdown of the system components, data flow, and interactive diagrams, see the **[Architecture Documentation](./ARCHITECTURE.md)**.

## AI Models

Verifai utilizes a multi-model architecture that routes tasks to the optimal Gemini model based on capability and cost. For a detailed routing diagram, see the Architecture Documentation.

| Task | Model | Why | Protocol |
|------|-------|-----|----------|
| **Browser action decisions** | Gemini 3 Flash | Best model for understanding complex spatial/visual action parsing | Native Computer Use tool |
| **Verification & narration** | Gemini 2.5 Flash Lite | Fast and cheap for simple DOM parsing and status updates | Vision + JSON prompt |
| **Spec parsing** | Gemini 2.5 Flash Lite | Excellent for extracting steps from structured text | Text → JSON |
| **Fallback Reasoning** | Gemini 2.5 Flash | Provides in-depth reasoning when vision loops fail | Vision + Text |

## Tri-State Reporting

Steps have three possible outcomes:
- **Passed** ✅ — Step executed and verified successfully
- **Failed** ❌ — Gemini verification confirmed a product bug → Jira ticket created
- **Incomplete** ⚠️ — Step could not be assessed (rate limit / timeout / crash / user skip)

Incomplete steps can be retried individually or in bulk after the session.

## Tech Stack

- **Frontend**: Next.js (App Router) + Tailwind CSS + shadcn/ui
- **Agent**: Node.js + Express + Socket.io
- **AI**: Google Gemini (multi-model via @google/genai SDK)
- **Browser**: Playwright (headless Chromium)
- **Storage**: Google Cloud Storage (screenshots) + Firestore (reports)
- **Integration**: Jira REST API (bug ticket creation)
- **Deployment**: Cloud Run (agent) + Vercel (web)

## Local Setup

### Prerequisites

- Node.js 20+
- Google Cloud project with Firestore + GCS
- Jira Cloud account with API token
- Gemini API key (free tier works)

### Install

```bash
npm install
cd apps/agent && npx playwright install chromium
```

### Environment

Copy `.env.example` and fill in values:

```bash
cp .env.example apps/agent/.env
cp .env.example apps/web/.env.local
# Edit both files with your credentials
```

### Run

```bash
turbo dev
```

- Web: http://localhost:3000
- Agent: http://localhost:3001

## Deploy

`deploy.sh` handles both services in one command: builds and pushes the agent Docker image to Artifact Registry, deploys it to Cloud Run, then deploys the web app to Vercel.

### One-time setup

**1. Enable GCP APIs**
```bash
gcloud services enable run.googleapis.com artifactregistry.googleapis.com \
  secretmanager.googleapis.com firestore.googleapis.com storage.googleapis.com \
  --project=YOUR_PROJECT_ID
```

**2. Store the service account key in Secret Manager**
```bash
gcloud secrets create verifai-sa-key \
  --data-file=apps/agent/service-account.json --project=YOUR_PROJECT_ID

SA="$(gcloud projects describe YOUR_PROJECT_ID --format='value(projectNumber)')-compute@developer.gserviceaccount.com"
gcloud secrets add-iam-policy-binding verifai-sa-key \
  --member="serviceAccount:$SA" --role=roles/secretmanager.secretAccessor \
  --project=YOUR_PROJECT_ID
```

**3. Authenticate Docker**
```bash
gcloud auth configure-docker us-central1-docker.pkg.dev
```

**4. Install and authenticate Vercel CLI**
```bash
npm i -g vercel && vercel login
cd apps/web && vercel link && cd ../..
```

**5. Add `GOOGLE_APPLICATION_CREDENTIALS_JSON` to Vercel**

In Vercel dashboard → your project → **Settings → Environment Variables**, add:
- `GOOGLE_APPLICATION_CREDENTIALS_JSON` = paste the full contents of `apps/agent/service-account.json`

### Run

```bash
export GCP_PROJECT_ID=your-project
export GEMINI_API_KEY=your-key
export JIRA_BASE_URL=https://yourorg.atlassian.net/
export JIRA_EMAIL=you@example.com
export JIRA_API_TOKEN=your-jira-token
export JIRA_PROJECT_KEY=YOUR_KEY
export GCS_BUCKET_NAME=your-bucket
export CONFLUENCE_BASE_URL=https://yourorg.atlassian.net
export CONFLUENCE_EMAIL=you@example.com
export CONFLUENCE_API_TOKEN=your-confluence-token
export CORS_ORIGIN=https://your-vercel-domain.vercel.app

chmod +x deploy.sh && ./deploy.sh
```

The script will output the Cloud Run URL and automatically pass it to Vercel as `NEXT_PUBLIC_AGENT_URL`.

> **Note:** The first build uses `--platform linux/amd64` (cross-compilation for Apple Silicon users) and may take a few extra minutes.

## Environment Variables

| Variable | Where | Description |
|----------|-------|-------------|
| `GEMINI_API_KEY` | Agent | Google Gemini API key |
| `GEMINI_CALL_DELAY_MS` | Agent | Min delay between Gemini calls (default: 2000) |
| `JIRA_BASE_URL` | Agent | Jira instance URL |
| `JIRA_EMAIL` | Agent | Jira account email |
| `JIRA_API_TOKEN` | Agent | Jira API token |
| `JIRA_PROJECT_KEY` | Agent | Jira project key for bug tickets |
| `GCP_PROJECT_ID` | Agent + Web | Google Cloud project ID |
| `GCS_BUCKET_NAME` | Agent | GCS bucket for screenshots |
| `GOOGLE_APPLICATION_CREDENTIALS_JSON` | Agent + Web | Service account JSON (inline, for Cloud Run / Vercel) |
| `FIRESTORE_COLLECTION` | Agent + Web | Firestore collection (default: reports) |
| `CONFLUENCE_BASE_URL` | Agent | Confluence instance URL |
| `CONFLUENCE_EMAIL` | Agent | Confluence account email |
| `CONFLUENCE_API_TOKEN` | Agent | Confluence API token |
| `NEXT_PUBLIC_AGENT_URL` | Web | Agent WebSocket URL |
| `CORS_ORIGIN` | Agent | Allowed CORS origin |
| `PLAYWRIGHT_TIMEOUT_MS` | Agent | Global Playwright timeout ms (default: 30000) |
| `PLAYWRIGHT_NAVIGATION_TIMEOUT_MS` | Agent | Navigation timeout ms (default: 15000) |
| `HITL_ENABLED` | Agent | Enable Human-in-the-Loop interventions (default: true) |
| `HITL_ACTION_THRESHOLD` | Agent | Min confidence to autonomously run an action (default: 0.7) |
| `HITL_VERIFY_THRESHOLD` | Agent | Min confidence to autonomously report a verification (default: 0.6) |
| `HITL_MAX_WAIT_MS` | Agent | Max wait time for human decision before auto-resuming (default: 120000) |

## Hackathon

Built for the **Gemini Live Agent Challenge** (UI Navigator category):
- Uses Gemini model + Google GenAI SDK ✅
- Uses Google Cloud services (Cloud Run, Firestore, GCS) ✅
- Hosted on Google Cloud ✅
- Vision-based UI automation with Computer Use ✅
