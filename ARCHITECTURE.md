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
| **Frontend** | Interactive UI for story generation and display | HTML5 / Vanilla JS / CSS3 |
| **API Layer** | Proxy between UI and Agent Orchestrator | Python / FastAPI / Uvicorn |
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
│   ├── main.py                 # API proxy logic & static file mounting
│   ├── frontend/               # Vanilla JS source (index.html, app.js, style.css)
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

The frontend is a lightweight, high-performance web interface built with pure HTML, CSS, and JavaScript. It communicates with the FastAPI backend via an NDJSON (Newline Delimited JSON) stream for real-time progress updates.

### 3.1 Component Map

```
app/frontend/
  ├── index.html   — Landing page with topic input
  ├── story.html   — Dedicated viewer for the generated markdown story
  ├── app.js       — Application logic (Form handling, SSE/NDJSON streaming)
  └── style.css    — Modern, responsive design system (Glassmorphism inspired)
```

### 3.2 State Management

The frontend uses `localStorage` to persist the generated story content between the generation phase (landing page) and the reading phase (display page).

1. **Generation State**: Tracked via DOM mutations in `app.js` (swapping form for progress bar).
2. **Persistence**: `currentCourse` and `renderedContent` (Google Search HTML) are stored in `localStorage`.

### 3.3 NDJSON Stream Protocol

The frontend uses the `Fetch API` and `ReadableStream` to parse the backend response line-by-line:

| Event Type | Payload | Action |
|---|---|---|
| `progress` | `{ type: "progress", text: "..." }` | Updates the status label and highlights pipeline steps. |
| `result`   | `{ type: "result", text: "...", rendered_content: "..." }` | Saves data and redirects to `story.html`. |

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

`app/main.py` sits between the browser and the Orchestrator:

```
Browser POST /api/chat_stream
  └─► FastAPI
        ├─► list_agents()         (if agent_name not yet known)
        ├─► get_session()         (reuse existing session if session_id provided)
        │    └─► create_session() (otherwise create a new one)
        └─► query_adk_server()    (SSE stream from orchestrator /run_sse)
              └─► event_generator()
                    ├─► "researcher" event  → yield progress: "🔍 Adventure Seeker is gathering..."
                    ├─► "judge" event       → yield progress: "⚖️ Guardian of Balance is evaluating..."
                    ├─► "content_builder"   → yield progress: "✍️ Storysmith is writing..."
                    └─► final content       → yield result: <markdown story>

Response: application/x-ndjson (newline-delimited JSON)
```

All communication with the ADK server is done via `httpx_sse.aconnect_sse` for real-time streaming.

---

## 5. Data Flows

### 5.1 Main Generation Loop

```
┌─────────────────────────────────────────────────────────────┐
│  Browser (Frontend)                                         │
│                                                             │
│  User Input (Topic) ──► POST /api/chat_stream ─────────────┼──► FastAPI (Proxy)
│                                                             │         │
│  NDJSON Stream ◄────────────────────────────────────────────┼─────────┘
│    ├─► type: "progress" → Update UI status                  │
│    └─► type: "result"   → Save to localStorage & Redirect    │
└─────────────────────────────────────────────────────────────┘
```

### 5.2 Multi-agent Story Engine End-to-End {#52-multi-agent-story-engine-end-to-end}

```
User types topic
  │
  ▼
Browser POST /api/chat_stream  { message, user_id, session_id? }
  │
  ▼
FastAPI (port 8000)
  ├─► creates / reuses ADK session
  └─► SSE stream from Orchestrator (port 8004)
        │
        ├── LoopAgent starts:
        │   ├─► Adventure Seeker (8001) — google_search → research_findings (state)
        │   ├─► Guardian of Balance (8002) — evaluate research → judge_feedback (state)
        │   └─► EscalationChecker
        │         ├── FAIL → loop (max 3×)
        │         └── PASS → escalate, exit loop
        │
        └── Storysmith (8003) — reads research_findings → markdown story
              │
              ▼
        FastAPI streams NDJSON to browser:
          { type: "progress", text: "🔍 Adventure Seeker is gathering..." }
          { type: "progress", text: "⚖️ Guardian of Balance is evaluating..." }
          { type: "progress", text: "✍️ Storysmith is writing..." }
          { type: "result",   text: "# Story Title\n## Chapter..." }
```

---

## 6. Service Topology & Ports

| Service | Port | Technology | Start command |
|---|---|---|---|
| **App** (Frontend + API proxy) | `8000` | FastAPI + Uvicorn | `uvicorn main:app` |
| **Adventure Seeker** (Researcher) | `8001` | ADK A2A server | `adk_app.py --a2a` |
| **Guardian of Balance** (Judge) | `8002` | ADK A2A server | `adk_app.py --a2a` |
| **Storysmith** (Builder) | `8003` | ADK A2A server | `adk_app.py --a2a` |
| **Orchestrator Agent** | `8004` | ADK server (non-A2A) | `adk_app.py` |

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

### Direct API from browser (Live Storytelling)
The frontend calls the Gemini Live API directly using the `VITE_API_KEY` without routing through a backend. This minimises latency for the real-time audio loop, but means the API key is exposed in the browser environment — acceptable for a hackathon demo, should be proxied in production.

### Single-component frontend
All state and logic live in `App.tsx`. This was chosen for simplicity and speed of iteration during a hackathon. Future refactoring would split audio, camera, session management, and UI into separate hooks/components.

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
| Multi-agent framework | Google Agent Development Kit (ADK) | `1.22.0` |
| Agent protocol | A2A (Agent-to-Agent) | `a2a-sdk 0.3.*` |
| Frontend | Vanilla HTML5 / JavaScript / CSS3 | — |
| Backend | FastAPI + Uvicorn | `0.123.*` / `0.40.0` |
| Async Streaming | NDJSON / Event-Driven | — |
| Python | CPython | `≥ 3.10, < 3.14` |
| Package manager | uv | — |
| Observability | OpenTelemetry + Google Cloud Trace | `1.11.0` |
| Hosting | Google Cloud Run | — |
