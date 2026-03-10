# Verifai Architecture

Verifai uses a modern, real-time architecture optimized for AI-driven browser automation and human-in-the-loop interventions.

## High-Level System Diagram

```mermaid
sequenceDiagram
    participant User
    participant Frontend as Web Client (Next.js)
    participant Agent as Session Manager (Node.js)
    participant Browser as Playwright Browser
    participant Vision as Gemini 3 Flash (Vision)
    participant Verify as Gemini 2.5 Flash Lite
    participant Storage as GCP (Firestore/GCS)

    User->>Frontend: Enter Target URL & Test Spec
    Frontend->>Verify: Parse spec into TestPlan
    Verify-->>Frontend: JSON TestPlan
    Frontend->>Agent: Start Session (WebSocket)
    
    Agent->>Browser: Launch & Navigate to URL
    Browser-->>Agent: Initial Screenshot

    loop For each Test Step
        Agent->>Browser: step_start (Take Screenshot)
        Browser-->>Agent: Screenshot & DOM
        
        Note over Agent,Vision: The Vision Loop (decideAction)
        Agent->>Vision: Screenshot + Objective
        Vision-->>Agent: Computer Use Action (click, type, etc.)
        
        alt Low Confidence
            Agent->>Frontend: Pause for HITL
            User->>Frontend: Approve/Override/Skip
            Frontend-->>Agent: Human Decision
        end
        
        Agent->>Browser: Execute Action
        Agent->>Browser: Take Screenshot
        
        Note over Agent,Verify: The Verification Loop
        Agent->>Verify: Screenshot + Expected Behavior
        Verify-->>Agent: pass/fail/finding
        
        Agent->>Frontend: step_result
    end

    Note over Agent,Storage: Post-Session Reporting
    Agent->>Storage: Upload Screenshots (GCS)
    Agent->>Storage: Save Bug Reports (Firestore)
    Agent->>Frontend: session_complete
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

## Execution Flows

### The Core Vision Loop Details

The heart of the application is the `executeStepWithVisionLoop` function in `routes/session.ts`. It follows a specific self-healing and escalation pattern:

1. **Observe**: Take a screenshot and grab the Accessibility Object Model (AOM) from Playwright.
2. **Think**: Send the screenshot to Gemini 3 Flash to decide the next action (`click`, `type`, `scroll`, etc.).
   - *Fallback Mechanism*: If the vision model errors (e.g., rate limits), it falls back to Gemini 2.5 Flash for reasoning.
   - *Escalation Mechanism*: If the vision model claims the step is complete but the verification model disagrees, it escalates to a slower, higher-capability "Pro" model.
3. **Log/HITL**:
   - Calculate confidence based on the action. If confidence is below `HITL_ACTION_THRESHOLD`, pause the session and wait for a user to decide (Proceed, Skip, Retry, Abort, Override).
   - Emit live narration and Text-to-Speech (TTS) updates to the UI via WebSocket.
4. **Act**: Execute the Playwright native action.
   - *Self-Healing*: If an action fails (e.g., bad coordinates or element not found), the agent automatically takes a new screenshot and retries with a self-correcting prompt.
5. **Mid-Loop Verification**: Take a screenshot after the action and verify it with Gemini 2.5 Flash Lite. If it passes, break the loop early; otherwise, continue trying up to 5 actions per step.

### Test Step State Transition Diagram

Every step in a Verifai `TestPlan` goes through a strict state machine. Steps can pass, fail with bugs, be skipped by the user, or drop out due to infrastructure errors.

```mermaid
stateDiagram-v2
    [*] --> PENDING

    PENDING --> IN_PROGRESS : step_start
    PENDING --> INCOMPLETE : User Skips or Dependency Failed
    
    state IN_PROGRESS {
        [*] --> OBSERVING
        OBSERVING --> THINKING : Take Screenshot
        THINKING --> OBSERVING : Mid-loop verify (not passed) / Retry / Self-heal
        THINKING --> ACTING : High confidence action
        THINKING --> HITL_PAUSE : Low confidence action
        
        HITL_PAUSE --> ACTING : Human Approves/Overrides
        HITL_PAUSE --> [*] : Human Aborts/Skips
        
        ACTING --> VERIFYING : Execute Browser Action
        
        VERIFYING --> [*] : Verified Passed
        VERIFYING --> [*] : Verified Failed (Bug Found)
    }

    IN_PROGRESS --> PASSED : Step verified successfully
    IN_PROGRESS --> FAILED : Bug identified
    IN_PROGRESS --> INCOMPLETE : Rate limit / Crash / Human Abort
    
    PASSED --> [*]
    FAILED --> [*]
    INCOMPLETE --> [*]
```

### Multi-Model Architecture Routing

Verifai utilizes different Gemini models based on the specific capability required for the task, optimizing for both performance and cost.

```mermaid
graph TD
    %% Define Styles
    classDef model fill:#8b5cf6,stroke:#6d28d9,stroke-width:2px,color:white;
    classDef input fill:#3b82f6,stroke:#1d4ed8,stroke-width:2px,color:white;
    classDef output fill:#10b981,stroke:#047857,stroke-width:2px,color:white;

    %% Inputs
    Screenshot["Screenshot (Browser State)"]:::input
    AOM["Accessibility Object Model (AOM)"]:::input
    Spec["Jira Ticket / Test Spec"]:::input
    Target["Target URL"]:::input
    
    %% Models
    G3F["Gemini 3 Flash<br>(Computer Use / Vision)"]:::model
    G25FL["Gemini 2.5 Flash Lite<br>(Fast Verification)"]:::model
    G25F["Gemini 2.5 Flash<br>(Reasoning Fallback)"]:::model

    %% Outputs
    Action["Browser Action<br>(Click, Type, Scroll)"]:::output
    Plan["Structured Test Plan<br>(JSON)"]:::output
    Verification["Verification Result<br>(Pass/Fail/Findings)"]:::output

    %% Flow: Planning
    Spec --> G25FL
    Target --> G25FL
    G25FL -->|Text Generation| Plan

    %% Flow: Execution
    Screenshot --> G3F
    AOM --> G3F
    Plan --> G3F
    G3F -->|Primary Vision Loop| Action

    %% Flow: Fallback & Escalation
    G3F -.->|Rate Limited / Fails| G25F
    G25F -->|Fallback Reasoning| Action

    %% Flow: Verification
    Screenshot --> G25FL
    G25FL -->|Vision + JSON Output| Verification

    %% Model Selection Logic Note
    subgraph Model Routing
        note1["Optimized for capability and cost. 1) Gemini 3 Flash: Complex spatial and visual action parsing. 2) Gemini 2.5 Flash Lite: Fast text extraction and boolean visual checks. 3) Gemini 2.5 Flash: In-depth reasoning when vision loops fail."]
    end
```
