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

### Agent → Cloud Run

```bash
export GCP_PROJECT_ID=your-project
export GEMINI_API_KEY=your-key
# Set other env vars as needed (see .env.example)
chmod +x deploy.sh
./deploy.sh
```

### Web → Vercel

Set these env vars in Vercel dashboard:
- `NEXT_PUBLIC_AGENT_URL` = Cloud Run agent URL
- `GCP_PROJECT_ID` = your GCP project
- `FIRESTORE_COLLECTION` = reports
- `GEMINI_API_KEY` = your key

```bash
cd apps/web && vercel --prod
```

## Environment Variables

| Variable | Where | Description |
|----------|-------|-------------|
| `GEMINI_API_KEY` | Agent + Web | Google Gemini API key |
| `GEMINI_CALL_DELAY_MS` | Agent | Min delay between Gemini calls (default: 2000) |
| `JIRA_BASE_URL` | Agent + Web | Jira instance URL |
| `JIRA_EMAIL` | Agent + Web | Jira account email |
| `JIRA_API_TOKEN` | Agent + Web | Jira API token |
| `JIRA_PROJECT_KEY` | Agent | Jira project key for bug tickets |
| `GCP_PROJECT_ID` | Agent + Web | Google Cloud project ID |
| `GCS_BUCKET_NAME` | Agent | GCS bucket for screenshots |
| `FIRESTORE_COLLECTION` | Agent + Web | Firestore collection (default: reports) |
| `NEXT_PUBLIC_AGENT_URL` | Web | Agent WebSocket URL |
| `CORS_ORIGIN` | Agent | Allowed CORS origin |
| `PLAYWRIGHT_NAVIGATION_TIMEOUT_MS` | Agent | Navigation timeout (default: 15000) |
| `PORT` | Agent | Server port (default: 3001) |
| `HITL_ENABLED` | Agent | Enable Human-in-the-Loop interventions (default: true) |
| `HITL_ACTION_THRESHOLD` | Agent | Minimum confidence to autonomously run an action (default: 0.7) |
| `HITL_VERIFY_THRESHOLD` | Agent | Minimum confidence to autonomously report a verification (default: 0.6) |
| `HITL_MAX_WAIT_MS` | Agent | Max time to wait for a human decision before auto-resuming (default: 120000) |

## Hackathon

Built for the **Gemini Live Agent Challenge** (UI Navigator category):
- Uses Gemini model + Google GenAI SDK ✅
- Uses Google Cloud services (Cloud Run, Firestore, GCS) ✅
- Hosted on Google Cloud ✅
- Vision-based UI automation with Computer Use ✅
