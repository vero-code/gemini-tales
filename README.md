# ✨ Gemini Tales

![Status](https://img.shields.io/badge/status-in%20development-orange?style=flat-square) ![Hackathon](https://img.shields.io/badge/hackathon-Gemini%20Live%20Agent%20Challenge-4285F4?style=flat-square&logo=google)

> **A magical, interactive AI storyteller for children — powered by Gemini Live API and a multi-agent backend.**

Gemini Tales is an interactive storytelling experience where children can talk to an AI narrator in real time. The AI watches the child through the camera, listens via microphone, tells enchanting fairy tales, awards badges for participation, generates watercolor illustrations on the fly, and lets the child steer the story with choices and physical movement.

> 🚧 **Work in Progress** — this project is actively being developed as a submission for the **[Gemini Live Agent Challenge](https://googleai.devpost.com/)** hackathon. Features and APIs may change.

A separate **multi-agent backend** (Researcher → Judge → Content Builder) can generate structured educational content from any topic using the Google Agent Development Kit (ADK) and the Agent-to-Agent (A2A) protocol.

---

## ✨ Key Features

### 🧚 Interactive Live Storytelling (Frontend)
| Feature | Description |
|---|---|
| 🎙️ **Real-time voice conversation** | Uses **Gemini 2.5 Flash Native Audio** via the Live API — the child can interrupt the story at any time |
| 📸 **Camera awareness** | Video frames are streamed to Gemini every 4 seconds so the AI can see and react to the child's actions |
| 🎨 **Dynamic illustration generation** | The AI calls `generateIllustration` and a new watercolor image is generated with **Gemini 2.5 Flash Image** |
| 🏆 **Achievement system** | Five badges (Hop-Skip, Young Wizard, Little Inquirer, Little Leaf, Good Listener) awarded when the child interacts |
| 🔀 **Story branching choices** | Every 2–3 minutes the AI presents 2–3 buttons to let the child decide what happens next |
| 🌊 **Interruption handling** | Child can speak at any point; the AI pauses immediately and responds in character |

### 🤖 Multi-agent Course Creation (Backend)
| Agent | Role |
|---|---|
| 🔍 **Researcher** | Gathers information about the requested topic using Google Search |
| ⚖️ **Judge** | Evaluates research quality; loops up to 3 times until it passes |
| ✍️ **Content Builder** | Writes a structured educational course from the approved research |
| 🎼 **Orchestrator** | Coordinates agents in a `Researcher → Judge → Content Builder` pipeline using Google ADK |

---

## 🏗️ Architecture

```
gemini-tales/
├── frontend/                   # React + Vite + TypeScript (Gemini Live client)
│   └── src/
│       ├── App.tsx             # Main app: Live session, camera, audio, achievements
│       ├── types.ts            # Shared TypeScript types
│       └── services/
│           └── audioUtils.ts   # PCM encode/decode helpers
│
└── backend/
    ├── agents/
    │   ├── researcher/         # ADK agent – Google Search research
    │   ├── judge/              # ADK agent – quality evaluation loop
    │   ├── content_builder/    # ADK agent – course content generation
    │   └── orchestrator/       # ADK SequentialAgent + LoopAgent pipeline
    │
    └── app/                    # FastAPI server + static frontend bundle
        ├── main.py             # REST + SSE streaming proxy to ADK
        └── frontend/           # Compiled HTML/CSS/JS (served as static files)
```

**Data flow (Live storytelling):**
```
Child (mic + camera) ──► React App ──► Gemini Live API (gemini-2.5-flash-native-audio-preview)
                                            │
                              ┌─────────────┼─────────────┐
                         generateIllustration  awardBadge  showChoice
                              │
                      Gemini Image API (gemini-2.5-flash-image)
```

**Data flow (Multi-agent course creation):**
```
User input ──► FastAPI /api/chat_stream ──► Orchestrator (ADK)
                                                │
                                 ┌──────────────┼──────────────┐
                            Researcher ──► Judge ──► Content Builder
                             (A2A)         (A2A)        (A2A)
```

---

## 🚀 Getting Started

### Prerequisites

- **Python** ≥ 3.10, < 3.14
- **Node.js** ≥ 18
- **[uv](https://docs.astral.sh/uv/)** package manager
- A **Google Cloud project** with Vertex AI enabled, **or** a **Gemini API key**
- `gcloud` CLI authenticated (`gcloud auth application-default login`)

---

### 1. Frontend (Live Storytelling App)

The frontend is a standalone React/Vite application that connects directly to the Gemini API from the browser.

```bash
cd frontend
cp .env.example .env
# Set your Gemini API key in .env:
#   VITE_API_KEY=your_gemini_api_key_here
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173), click **Begin Your Story**, and allow camera + microphone access.

> **Note:** The Live API (`gemini-2.5-flash-native-audio-preview`) and Image generation (`gemini-2.5-flash-image`) require a valid API key with access to these models.

---

### 2. Backend (Multi-agent Course Creator)

The backend runs five services: Researcher, Judge, Content Builder, Orchestrator, and the FastAPI app.

```bash
cd backend
cp .env.example .env
# Edit .env with your Google Cloud settings:
#   GOOGLE_CLOUD_PROJECT=your-project-id
#   GOOGLE_CLOUD_LOCATION=us-central1
#   GOOGLE_GENAI_USE_VERTEXAI=true

# Install dependencies
uv sync

# Start all agents at once
bash run_local.sh
```

| Service | Port | Description |
|---|---|---|
| App (Frontend + API) | `8000` | FastAPI server with static frontend |
| Researcher Agent | `8001` | ADK A2A agent |
| Judge Agent | `8002` | ADK A2A agent |
| Content Builder | `8003` | ADK A2A agent |
| Orchestrator | `8004` | ADK pipeline controller |

Open [http://localhost:8000](http://localhost:8000) and enter a topic to generate a course.

#### Environment variables

| Variable | Description |
|---|---|
| `GOOGLE_CLOUD_PROJECT` | Your GCP project ID |
| `GOOGLE_CLOUD_LOCATION` | Region (e.g. `us-central1`), or `global` for Gemini API |
| `GOOGLE_GENAI_USE_VERTEXAI` | `true` to use Vertex AI, `false` to use Gemini API key |
| `GOOGLE_API_KEY` | Gemini API key (only needed when not using Vertex AI) |
| `AGENT_SERVER_URL` | URL of the Orchestrator (set automatically by `run_local.sh`) |

---

## ☁️ Deployment to Google Cloud Run

The included `deploy.sh` script deploys all five services to Cloud Run:

```bash
cd backend
# Make sure your .env has GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION set
bash deploy.sh
```

Services are deployed in dependency order (Researcher → Judge → Content Builder → Orchestrator → App). The final `course-creator` Cloud Run service is publicly accessible; the agent services require authentication.

---

## 🛠️ Tech Stack

| Layer | Technology |
|---|---|
| Live AI | [Gemini 2.5 Flash Native Audio](https://ai.google.dev/gemini-api/docs/live) via `@google/genai` |
| Image AI | Gemini 2.5 Flash Image (`gemini-2.5-flash-image`) |
| Multi-agent | [Google Agent Development Kit (ADK)](https://google.github.io/adk-docs/) |
| Agent protocol | [A2A (Agent-to-Agent)](https://google.github.io/A2A/) |
| Frontend | React 19, TypeScript, Vite 6, TailwindCSS |
| Backend | FastAPI, Uvicorn, Python ≥ 3.10 |
| Package manager | [uv](https://docs.astral.sh/uv/) |
| Observability | OpenTelemetry + Google Cloud Trace |
| Hosting | Google Cloud Run |

---

## 📁 Frontend `.env.example`

```env
VITE_API_KEY=your_gemini_api_key_here
```

## 📁 Backend `.env.example`

```env
GOOGLE_GENAI_USE_VERTEXAI="true"
GOOGLE_CLOUD_PROJECT=""
GOOGLE_CLOUD_LOCATION="global"
```

---

## 📜 License

Apache 2.0 — see [LICENSE](LICENSE).

---

*Built with ❤️ by [Veronika Kashtanova](https://x.com/veron_code)*
