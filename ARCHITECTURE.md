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

Gemini Tales consists of **two independent subsystems** that share a common Google AI backbone:

| Subsystem | Where it runs | Primary API |
|---|---|---|
| **Live Storytelling** | Browser (React/Vite) | Gemini Live API (WebSocket) |
| **Story Engine** | Server (Python/FastAPI) | Gemini via Google ADK + A2A |

The two subsystems are deployed together: the FastAPI server serves the compiled frontend as static files, and exposes a `/api/chat_stream` endpoint for the Story Engine UI.

Browser
  ├── Live Storytelling (WebSocket → Gemini Live API)   [direct, no backend]
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
├── frontend/                       # React 19 + Vite 6 + TypeScript
│   ├── index.html
│   ├── vite.config.ts
│   ├── package.json
│   └── src/
│       ├── main.tsx                # React entry point
│       ├── App.tsx                 # Entire Live storytelling app (single-component)
│       ├── types.ts                # AppState enum, Achievement, StoryScene interfaces
│       └── services/
│           └── audioUtils.ts       # PCM encode / decode / AudioBuffer helpers
│
├── pyproject.toml              # Root workspace manifest (uv)
├── run_local.ps1               # Starts all 5 services locally
├── deploy.sh                   # Deploys all 5 services to Cloud Run
├── shared/                     # Shared utilities (authenticated_httpx)
│
├── agents/
│   ├── researcher/
│   │   ├── agent.py            # ADK Agent with google_search tool (gemini-2.5-pro)
│   │   └── Dockerfile
│   ├── judge/
│   │   ├── agent.py            # ADK Agent with structured JudgeFeedback output schema
│   │   └── Dockerfile
│   ├── content_builder/
│   │   ├── agent.py            # ADK Agent — writes the final course markdown
│   │   └── Dockerfile
│   └── orchestrator/
│       ├── agent.py            # SequentialAgent + LoopAgent + EscalationChecker
│       └── Dockerfile
│
└── app/
    ├── main.py                 # FastAPI server — proxy to orchestrator + static files
    ├── authenticated_httpx.py  # Google-auth aware httpx client factory
    ├── Dockerfile
    └── frontend/               # Compiled Vite build (copied here before deploy)
```

---

## 3. Subsystem A — Live Storytelling (Frontend)

The entire interactive experience lives in a **single React component** (`App.tsx`). It connects directly to the Gemini API from the browser — there is no backend involved in the storytelling path.

### 3.1 Component Map

```
App.tsx
  ├── State: AppState { IDLE → STARTING → STORYTELLING }
  ├── Refs
  │   ├── videoRef          — <video> element for camera preview
  │   ├── canvasRef         — off-screen canvas for JPEG frame capture
  │   ├── audioContextInRef — AudioContext @ 16 kHz  (microphone input)
  │   ├── audioContextOutRef— AudioContext @ 24 kHz  (AI audio output)
  │   ├── sourcesRef        — Set<AudioBufferSourceNode> (for interruption)
  │   ├── nextStartTimeRef  — scheduled playback cursor
  │   └── sessionPromiseRef — Promise<Session> (Live API handle)
  │
  ├── generateNewIllustration(prompt)   → Gemini Image API
  ├── handleAwardBadge(badgeId)         → local state mutation
  ├── selectChoice(choice)              → s.send({ text })
  ├── handleSessionMessage(message)     → dispatches all server events
  ├── startStory()                      → opens camera + Live session
  └── stopStory()                       → cleans up all resources
```

### 3.2 State Machine

```
IDLE
  │  user clicks "Begin Your Story"
  ▼
STARTING  ←──────────────────────────────────┐
  │  camera permission granted               │ camera error
  │  Live API session connecting             │
  ▼                                          │
STORYTELLING ──────── onclose / stopStory() ─┘
  │  all interactions happen here
  ▼
IDLE  (after stopStory)
```

### 3.3 Live API Session Lifecycle

```
startStory()
  1. getUserMedia({ video: true, audio: true })
  2. new AudioContext({ sampleRate: 16000 })   ← microphone
  3. new AudioContext({ sampleRate: 24000 })   ← speaker
  4. ai.live.connect(model, config, callbacks)
       ├── onopen  → send initial "Start the magical fairy tale..." turn
       │            connect ScriptProcessor for mic streaming
       │            start setInterval (4 s) for camera frames
       ├── onmessage → handleSessionMessage()
       └── onclose → AppState.IDLE

stopStory()
  1. clearInterval (frame capture)
  2. s.close()
  3. stop all MediaStream tracks
  4. reset state
```

### 3.4 Tool-call Protocol

The AI can call three **function tools** during the session. The frontend handles them inside `handleSessionMessage → message.toolCall`:

| Tool | Args | Frontend action | Response sent back |
|---|---|---|---|
| `generateIllustration` | `prompt: string` | Calls `generateNewIllustration(prompt)` → sets `currentIllustration` | `{ result: "Done" }` |
| `awardBadge` | `badgeId: string` | Calls `handleAwardBadge(badgeId)` → unlocks achievement, shows popup | `{ result: "Awarded" }` |
| `showChoice` | `options: string[]` | Sets `storyChoices` → renders overlay buttons | `{ result: "Options shown" }` |

All tool responses are sent via `s.sendToolResponse()`.

### 3.5 Audio Pipeline

```
Microphone (getUserMedia)
  └─► MediaStreamSource
        └─► ScriptProcessor (bufferSize: 4096, mono, 16 kHz)
              └─► onaudioprocess
                    └─► createPcmBlob(Float32Array)   [audioUtils.ts]
                          └─► s.sendRealtimeInput({ media: blob })

Gemini Live API Response (24 kHz PCM)
  └─► message.serverContent.modelTurn.parts[0].inlineData.data  (base64)
        └─► decode(base64)                           [audioUtils.ts]
              └─► decodeAudioData(pcm, ctx, 24000, 1) [audioUtils.ts]
                    └─► AudioBufferSourceNode.start(nextStartTime)
                          └─► ctx.destination (speakers)

Interruption:
  message.serverContent.interrupted = true
  └─► sourcesRef.forEach(s => s.stop())
      nextStartTimeRef = 0
```

### 3.6 Camera Pipeline

```
setInterval(4000ms)
  └─► canvas.drawImage(videoRef, 0, 0, 320, 240)
        └─► canvas.toBlob('image/jpeg', quality=0.5)
              └─► FileReader.readAsDataURL
                    └─► base64 = result.split(',')[1]
                          └─► s.sendRealtimeInput({ media: { data: base64, mimeType: 'image/jpeg' } })
```

Frames are sent at **320×240 @ JPEG q=0.5** to keep bandwidth low while giving the model enough visual context.

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

### 5.1 Live Storytelling End-to-End

```
┌─────────────────────────────────────────────────────────────┐
│  Child's Browser                                            │
│                                                             │
│  Mic ──► PCM 16kHz ──► sendRealtimeInput ──────────────────┼──► Gemini Live API
│                                                             │    (gemini-2.5-flash-
│  Camera ──► JPEG 320×240 / 4s ──► sendRealtimeInput ───────┼──►  native-audio-preview)
│                                                             │         │
│  AI Audio (PCM 24kHz) ◄─────────── modelTurn.inlineData ◄──┼─────────┤
│  AI Text Transcript  ◄──────────── outputTranscription ◄───┼─────────┤
│                                                             │         │
│  toolCall: generateIllustration ◄───────────────────────────┼─────────┤
│    └─► Gemini Image API (gemini-2.5-flash-image)            │         │
│          └─► inlineData.data (PNG) → <img>                  │         │
│                                                             │         │
│  toolCall: awardBadge → achievement popup                   │         │
│  toolCall: showChoice → overlay buttons → sendClientContent │─────────┘
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

All services are started in the correct order by `run_local.sh`. A 5-second sleep ensures leaf agents are ready before the orchestrator tries to resolve their agent cards.

---

## 7. Deployment

All five services are containerised with individual `Dockerfile`s and deployed to **Google Cloud Run** via `deploy.sh`.

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
| Live AI | Gemini 2.5 Flash Native Audio | `gemini-2.5-flash-native-audio-preview-12-2025` |
| Image AI | Gemini 2.5 Flash Image | `gemini-2.5-flash-image` |
| Adventure Seeker / Researcher | Gemini 2.5 Flash | `gemini-2.5-flash` |
| Guardian of Balance / Judge | Gemini 2.5 Flash | `gemini-2.5-flash` |
| Storysmith / Story Builder | Gemini 2.5 Pro | `gemini-2.5-pro` |
| Multi-agent framework | Google Agent Development Kit (ADK) | `1.22.0` |
| Agent protocol | A2A (Agent-to-Agent) | `a2a-sdk 0.3.*` |
| Frontend | React 19 + TypeScript | — |
| Build tool | Vite 6 | — |
| Styling | TailwindCSS | — |
| Backend | FastAPI + Uvicorn | `0.123.*` / `0.40.0` |
| Python | CPython | `≥ 3.10, < 3.14` |
| Package manager | uv | — |
| Observability | OpenTelemetry + Google Cloud Trace | `1.11.0` |
| Hosting | Google Cloud Run | — |
