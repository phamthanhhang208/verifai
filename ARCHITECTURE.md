# Verifai Architecture

Verifai uses a modern, real-time architecture optimized for AI-driven browser automation and human-in-the-loop interventions.

## High-Level System Diagram

```mermaid
graph TD
    %% Define Styles
    classDef frontend fill:#3b82f6,stroke:#1d4ed8,stroke-width:2px,color:white;
    classDef backend fill:#10b981,stroke:#047857,stroke-width:2px,color:white;
    classDef ai fill:#8b5cf6,stroke:#6d28d9,stroke-width:2px,color:white;
    classDef storage fill:#f59e0b,stroke:#b45309,stroke-width:2px,color:white;
    classDef external fill:#ef4444,stroke:#b91c1c,stroke-width:2px,color:white;

    %% Client / Frontend
    subgraph Frontend["Web Client (Next.js)"]
        Config["Configure Test"]
        Exec["Execute Session (WebSocket connection)"]
        HITL_UI["HITL Overlay (Human Intervention)"]
        Runs["Test History Dashboard"]
        Exec -.-> HITL_UI
    end
    class Frontend,Config,Exec,HITL_UI,Runs frontend;

    %% Server / Backend
    subgraph Backend["Agent Server (Node.js)"]
        Session["Session Manager (State & Execution Loop)"]
        Playwright["Playwright Automation Node"]
        HITL_Mgr["HITL Manager"]
        Demo_Mgr["Demo Recording Manager"]
        
        Session <--> Playwright
        Session <--> HITL_Mgr
        Session <--> Demo_Mgr
    end
    class Backend,Session,Playwright,HITL_Mgr,Demo_Mgr backend;

    %% AI Models
    subgraph AI["Google Gemini API"]
        G3F["Gemini 3 Flash (Computer Use)"]
        G25FL["Gemini 2.5 Flash Lite (Verify)"]
        G25F["Gemini 2.5 Flash (Fallback Reasoning)"]
    end
    class AI,G3F,G25FL,G25F ai;

    %% Storage & Infrastructure
    subgraph Storage["Google Cloud Platform"]
        Firestore["Firestore (Test Reports & History)"]
        GCS["Cloud Storage (Screenshots)"]
    end
    class Storage,Firestore,GCS storage;

    %% Third-Party Integrations
    subgraph External["External Integrations"]
        Jira["Jira Cloud API (Bug Tracking)"]
    end
    class External,Jira external;

    %% Data Flow
    Config -->|Target URL, Spec Details| Session
    Exec <-->|Socket.io (Live Transcript, DOM state)| Session
    
    Session -->|Screenshot + Context| G3F
    G3F -->|Action Decision + Confidence| Session
    
    Session -->|Screenshot + Objective| G25FL
    G25FL -->|Verification Status + Confidence| Session
    
    Session -.->|Low Confidence Event| HITL_Mgr
    HITL_Mgr -->|hitl_pause| HITL_UI
    HITL_UI -->|hitl_decision| HITL_Mgr
    
    Session -->|Create Jira Ticket| Jira
    Session -->|Upload Bug Images| GCS
    Session -->|Save Structured Report| Firestore
    
    Runs -->|Fetch history| Firestore
```

## Core Components

### 1. Web Client (Frontend)
Built with Next.js, Tailwind CSS, and shadcn/ui. 
- **Configure**: Collects Target URL and Test Spec (from user or Jira).
- **Execute**: A real-time WebSocket dashboard displaying the agent's browser view, a streaming execution transcript, and the live status of each test step.
- **HITL Overlay**: A pause modal that takes over the screen when the AI Agent needs human help.
- **Test History**: Fetches past execution results and aggregated statistics from Firestore.

### 2. Agent Server (Backend)
Built with Node.js and Socket.io.
- **Session Manager**: The core loop. Ingests the `TestPlan`, spins up a Playwright browser, navigates, takes screenshots, talks to Gemini, and iterates.
- **HITL Manager**: Calculates model confidence. If an action or verification falls below `HITL_ACTION_THRESHOLD` or `HITL_VERIFY_THRESHOLD`, it pauses the session, emits an event to the UI, and waits for a human decision to unblock it.
- **Demo Recording Manager**: Optionally serializes and records the entire DOM / AI interaction stream for latency-free replay during live presentations.

### 3. Google Gemini (AI Layer)
Implements a multi-model architecture routing tasks to the optimal model based on capability and cost:
- **Gemini 3 Flash**: Handles all granular Computer Use interaction (click, type, scroll) driven by vision.
- **Gemini 2.5 Flash Lite**: Fast model optimized for text and layout comprehension. Used for generating test plans from initial specs and verifying step success.
- **Gemini 2.5 Flash**: Standby model for fallback reasoning if the primary action model loops or gets stuck.

### 4. GCP & External Integrations
- **Cloud Storage**: Hosts images from the automation timeline to ensure reports have permanent, public links to bug screenshots.
- **Firestore**: NoSQL cloud database persisting all structured `BugReport` and tracking analytics.
- **Jira Cloud**: Receives API calls to auto-create bug tickets complete with replication steps and visual proof from Cloud Storage.
