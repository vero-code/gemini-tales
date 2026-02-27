# 🏗️ Architecture — Gemini Tales

> Deep-dive into the system design, component responsibilities, data flows, and key design decisions.

---

## Table of Contents

1. [High-level Overview](#1-high-level-overview)
2. [Repository Layout](#2-repository-layout)
3. [Subsystem A — Live Storytelling (Frontend)](#3-subsystem-a--live-storytelling-frontend)
   - [Component Map](#31-component-map)
   - [State Machine](#32-state-machine)
   - [Live API Session Lifecycle](#33-live-api-session-lifecycle)
   - [Tool-call Protocol](#34-tool-call-protocol)
   - [Audio Pipeline](#35-audio-pipeline)
   - [Camera Pipeline](#36-camera-pipeline)
4. [Subsystem B — Multi-agent Story Engine (Backend)](#4-subsystem-b--multi-agent-story-engine-backend)
   - [Agent Roles](#41-agent-roles)
   - [Orchestration Logic](#42-orchestration-logic)
   - [A2A Communication](#43-a2a-communication)
   - [FastAPI Proxy Layer](#44-fastapi-proxy-layer)
5. [Data Flows](#5-data-flows)
   - [Live Storytelling End-to-End](#51-live-storytelling-end-to-end)
   - [Multi-agent Story Engine End-to-End](#52-multi-agent-story-engine-end-to-end)
6. [Service Topology & Ports](#6-service-topology--ports)
7. [Deployment](#7-deployment)
8. [Key Design Decisions](#8-key-design-decisions)
9. [Tech Stack Summary](#9-tech-stack-summary)

---

## 1. High-level Overview

Gemini Tales is an integrated AI storytelling system built on the Google Agent Development Kit (ADK). It allows users to generate interactive stories based on any topic.

| Component | Responsibility | Primary Technology |
|---|---|---|
| **Frontend** | Modern, interactive UI for story generation and live storytelling | React / Vite / Tailwind CSS |
| **API Layer** | WebSocket Proxy & Static File Host | Python / FastAPI / Uvicorn |
| **Story Engine** | Multi-agent pipeline for research and writing | Google ADK / A2A Protocol |

The system is deployed as a suite of microservices: a main FastAPI server serves the frontend and exposes the chat API, while four independent agents handle the processing logic.

User Browser
  └── Story Engine UI (HTTP → FastAPI → ADK Agents)

Server (Cloud Run / localhost)
  ├── FastAPI app (port 8000)
  ├── Orchestrator (port 8004)
  ├── Adventure Seeker (Researcher - 8001)
  ├── Guardian of Balance (Judge - 8002)
  └── Storysmith (Content Builder - 8003)


---

## 2. Repository Layout

```
gemini-tales/
├── app/                        # Main FastAPI Server & Frontend
│   ├── main.py                 # WebSocket Proxy & Static Site Host
│   ├── frontend/               # React Frontend source
│   │   ├── src/                # TypeScript/React components
│   │   ├── dist/               # Production build (mounted by FastAPI)
│   │   └── package.json        # Node.js dependencies
│   ├── authenticated_httpx.py  # Google-auth client factory
│   └── Dockerfile
│
├── agents/                     # ADK Agents (microservices)
│   ├── researcher/             # Adventure Seeker (Search + Planning)
│   ├── judge/                  # Guardian of Balance (Quality evaluation)
│   ├── content_builder/        # Storysmith (Markdown generation)
│   └── orchestrator/           # Pipeline logic (SequentialAgent + LoopAgent)
│
├── shared/                     # Shared utilities for agents
│   ├── adk_app.py              # Common A2A server entry point
│   ├── config.py               # Shared Gemini config (Safety settings)
│   └── authenticated_httpx.py  # Shared auth client
│
├── assets/                     # UI Assets & Documentation images
├── pyproject.toml              # Root workspace manifest (uv)
├── run_local.ps1               # Starts all 5 services locally
└── deploy.ps1                  # Deploys all 5 services to Cloud Run
```

---

## 3. Subsystem A — Interactive Story UI (Frontend)

The frontend is a modern, high-performance web interface built with **React**, **Vite**, and **Tailwind CSS**. It serves as a real-time bridge to the **Gemini Live API** for immersive storytelling.

### 3.1 Component Map

```
app/frontend/src/
  ├── App.tsx       — Main application container & logic
  ├── types.ts      — Shared TypeScript interfaces
  └── utils/
      ├── geminilive.ts — Gemini Live API client & tool definitions
      └── mediaUtils.ts — Audio/Video streaming utilities
```

### 3.2 State Management & Hooks

The application uses standard React state (`useState`, `useRef`, `useEffect`) to manage the complex real-time story state:

1. **App State**: Tracks connection status (`IDLE`, `STARTING`, `STORYTELLING`, `ERROR`).
2. **Media State**: Manages microphone/camera activation and selected devices.
3. **Story State**: Handles AI transcriptions, generated illustrations, and story choices.
4. **Achievements**: Persists unlocked badges for the current session.

### 3.3 Gemini Live Integration

The frontend establishes a direct WebSocket connection to the backend proxy, which forwards messages to the Gemini Live API:

- **Audio Pipeline**: Raw PCM audio is captured from the mic, base64 encoded, and sent to Gemini. AI audio responses are decoded and played using the `AudioContext` API.
- **Vision Pipeline**: Video frames are captured at a low frame rate (1 fps) and sent to Gemini for visual awareness.
- **Interruption Handling**: The client listens for the `INTERRUPTED` event to stop local audio playback immediately.

### 3.4 Tool-call Protocol

The system implements a custom tool-calling protocol over the Gemini Live session:

| Tool | Action |
|---|---|
| `generateIllustration` | Triggers **Gemini 2.5 Flash Image** to create a scene illustration. |
| `awardBadge` | Unlocks a virtual achievement in the UI. |
| `showChoice` | Renders interactive buttons for story branch selection. |

---

## 4. Subsystem B — Multi-agent Story Engine (Backend)

### 4.1 Agent Roles

| Agent | Model | Key tools / output | ADK type |
|---|---|---|---|
| **Adventure Seeker** (Researcher) | `gemini-2.5-flash` | `google_search` + `BuiltInPlanner` | `Agent` |
| **Guardian of Balance** (Judge) | `gemini-2.5-flash` | Structured `JudgeFeedback` (`{ status, feedback }`) | `Agent` with `output_schema` |
| **Storysmith** (Content Builder) | `gemini-2.5-pro` | Markdown Interactive Story | `Agent` |
| **Orchestrator** | — | Coordinates the pipeline | `SequentialAgent` + `LoopAgent` |

### 4.2 Orchestration Logic

```
story_engine_pipeline (SequentialAgent)
  └─► research_loop (LoopAgent, max_iterations=3)
  │     ├─► adventure_seeker  → saves output to state["research_findings"]
  │     ├─► guardian_of_balance → saves JudgeFeedback to state["judge_feedback"]
  │     └─► escalation_checker (BaseAgent)
  │           ├─► feedback.status == "pass"  → EventActions(escalate=True)  ← exits loop
  │           └─► feedback.status == "fail"  → loop again (up to 3 times)
  │
  └─► storysmith              → reads state["research_findings"], outputs markdown story
```

**EscalationChecker** is a custom `BaseAgent` subclass. It reads `session.state["judge_feedback"]` and yields an `Event(escalate=True)` to break the `LoopAgent`, or an empty event to continue.

### 4.3 A2A Communication

Each of the three leaf agents (Researcher, Judge, Content Builder) runs as a standalone **A2A server** (served by `adk_app.py`). The Orchestrator connects to them via `RemoteA2aAgent`, which:

1. Reads the agent card from `<agent_url>/.well-known/agent-card.json`
2. Posts tasks over HTTP using the A2A protocol
3. Uses an **authenticated HTTPX client** (`authenticated_httpx.py`) to attach Google OAuth2 bearer tokens automatically — required when deployed on Cloud Run

```
Orchestrator
  ├── RemoteA2aAgent("researcher")  → HTTP POST  http://localhost:8001/a2a/... (Adventure Seeker)
  ├── RemoteA2aAgent("judge")       → HTTP POST  http://localhost:8002/a2a/... (Guardian of Balance)
  └── RemoteA2aAgent("content_builder") → HTTP POST  http://localhost:8003/a2a/... (Storysmith)
```

### 4.4 FastAPI Proxy Layer

`app/main.py` serves two critical functions:

1. **Static File Hosting**: Serves the compiled React frontend from the `dist/` directory.
2. **Gemini Live WebSocket Proxy**: Exposes a `/ws/proxy` endpoint that handles the complex handshake and authentication with the Google Cloud Vertex AI endpoint.

**Proxy Workflow:**
1. Browser connects to `ws://localhost:8000/ws/proxy?project=...&model=...`.
2. FastAPI backend generates a fresh **Google OAuth2 bearer token**.
3. It establishes a secure WebSocket connection to the **LlmBidiService** in `us-central1`.
4. It bi-directionally pipes messages between the browser and Google, handling binary audio data and JSON tool calls transparently.

---

## 5. Data Flows

### 5.1 Real-time Storytelling Flow (WebSocket)

```
┌─────────────────────────┐          ┌─────────────────────────┐          ┌─────────────────────────┐
│   Browser (React UI)    │          │     FastAPI Proxy       │          │    Gemini Live API      │
└────────────┬────────────┘          └────────────┬────────────┘          └────────────┬────────────┘
             │                                    │                                    │
             │ ─── WebSocket Connection ─────────►│                                    │
             │                                    │ ─── Handshake & Auth ─────────────►│
             │                                    │                                    │
             │ ◄── [Setup Complete] ──────────────│ ◄──────────────────────────────────│
             │                                    │                                    │
             │ ─── Audio/Video Stream ───────────►│ ─── Forward Binary ───────────────►│
             │                                    │                                    │
             │ ◄── AI Audio & Transcript ─────────│ ◄── Forward Response ──────────────│
             │                                    │                                    │
             │ ◄── [TOOL_CALL: awardBadge] ───────│ ◄──────────────────────────────────│
             │                                    │                                    │
```

### 5.2 Multi-agent Research Flow

The ADK agents are still utilized by the `content_builder` during specific story transitions or for pre-generating lore, following the same A2A orchestration described in Subsystem B.

---

## 6. Service Topology & Ports

| Service | Port | Technology | Start command |
|---|---|---|---|
| **App** (Frontend + Proxy) | `8000` | FastAPI + React (dist) | `uvicorn main:app` |
| **Adventure Seeker** | `8001` | ADK A2A server | `adk_app.py --a2a` |
| **Guardian of Balance**| `8002` | ADK A2A server | `adk_app.py --a2a` |
| **Storysmith** | `8003` | ADK A2A server | `adk_app.py --a2a` |
| **Orchestrator** | `8004` | ADK server | `adk_app.py` |

All services are started in the correct order by `run_local.ps1`. A 5-second sleep ensures leaf agents are ready before the orchestrator tries to resolve their agent cards.

---

## 7. Deployment

All five services are containerised with individual `Dockerfile`s and deployed to **Google Cloud Run** via `deploy.ps1`.

**Deployment order** (enforced by the script):

1. Adventure Seeker → deployed, URL captured
2. Guardian of Balance → deployed, URL captured
3. Storysmith → deployed, URL captured
4. Orchestrator → deployed (receives agent URLs as env vars), URL captured
5. App → deployed (receives orchestrator URL as `AGENT_SERVER_URL`)

The `course-creator` (App) Cloud Run service is publicly accessible. The four agent services have `--no-allow-unauthenticated` and require a Google OAuth2 bearer token — handled transparently by `authenticated_httpx.py` using Application Default Credentials.

**Observability:** The FastAPI app instruments traces with **OpenTelemetry** and exports them to **Google Cloud Trace** via `CloudTraceSpanExporter`.

---

## 8. Key Design Decisions

### Proxied WebSocket Communication
Instead of calling the Gemini Live API directly from the browser, we use a FastAPI WebSocket proxy. This ensures that the **Vertex AI credentials** and **Project ID** remain secure on the server, while still providing a low-latency pipe for audio and video data.

### React + Vite Single Page Application (SPA)
The front end was migrated from Vanilla JS to a React SPA. This allows for more robust state management of the complex real-time media streams and tool calls, as well as a more responsive and premium UI.

### LoopAgent with EscalationChecker
Rather than using a fixed number of research passes, the Judge's `output_schema` produces a structured `{ status: "pass"|"fail" }` verdict. The `EscalationChecker` reads this from session state and escalates the loop early when quality is sufficient (up to a safety cap of 3 iterations).

### A2A over direct agent calls
Using the A2A protocol means each agent is independently deployable and scalable. The Orchestrator only needs to know the agent card URL — not the implementation. This also enables mixing agents written in different languages or frameworks in the future.

### Session state as the shared-memory bus
The Orchestrator saves agent outputs (`research_findings`, `judge_feedback`) into ADK **session state**. Sub-agents read from this state in their prompts via the `{state[key]}` template syntax. This avoids passing large payloads through function arguments and keeps the inter-agent contract simple.

### Authenticated HTTPX client
`authenticated_httpx.py` wraps `google.auth.transport.requests` to inject an OAuth2 bearer token into every outgoing request. The same helper is used both by the Orchestrator (to call leaf agents) and by the FastAPI app (to call the Orchestrator). In local development, tokens are sourced from `gcloud auth application-default login`.

---

## 9. Tech Stack Summary

| Layer | Technology | Version |
|---|---|---|
| Large Language Model | Gemini 2.5 Flash / Pro | (Default: `gemini-2.5-flash`) |
| Live Interaction | Gemini Live API | — |
| Multi-agent framework | Google Agent Development Kit (ADK) | `1.22.0` |
| Frontend | React + Vite + Tailwind CSS | — |
| Backend | FastAPI + Uvicorn | `0.123.*` |
| Protocol | WebSocket / A2A | — |
| Python | CPython | `≥ 3.10` |
| Package manager | uv | — |
| Hosting | Google Cloud Run | — |
