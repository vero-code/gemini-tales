import logging
import os
import json
from dotenv import load_dotenv
from typing import Any, AsyncGenerator, Dict, List, Optional

import httpx
from httpx_sse import aconnect_sse

from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from google.genai import types as genai_types
from opentelemetry import trace
from opentelemetry.exporter.cloud_trace import CloudTraceSpanExporter
from opentelemetry.sdk.trace import TracerProvider, export
from pydantic import BaseModel

from authenticated_httpx import create_authenticated_client

load_dotenv()

class Feedback(BaseModel):
    score: float
    text: str | None = None
    run_id: str | None = None
    user_id: str | None = None

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

provider = TracerProvider()
processor = export.BatchSpanProcessor(
    CloudTraceSpanExporter(),
)
provider.add_span_processor(processor)
trace.set_tracer_provider(provider)

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

agent_name = os.getenv("AGENT_NAME", None)
agent_server_url = os.getenv("AGENT_SERVER_URL")
if not agent_server_url:
    raise ValueError("AGENT_SERVER_URL environment variable not set")
else:
    agent_server_url = agent_server_url.rstrip("/")

clients: Dict[str, httpx.AsyncClient] = {}

async def get_client(agent_server_origin: str) -> httpx.AsyncClient:
    global clients
    if agent_server_origin not in clients:
        clients[agent_server_origin] = create_authenticated_client(agent_server_origin)
    return clients[agent_server_origin]

async def create_session(agent_server_origin: str, agent_name: str, user_id: str) -> Dict[str, Any]:
    httpx_client = await get_client(agent_server_origin)
    headers=[
        ("Content-Type", "application/json")
    ]
    session_request_url = f"{agent_server_origin}/apps/{agent_name}/users/{user_id}/sessions"
    session_response = await httpx_client.post(
        session_request_url,
        headers=headers
    )
    session_response.raise_for_status()
    return session_response.json()

async def get_session(agent_server_origin: str, agent_name: str, user_id: str, session_id: str) -> Optional[Dict[str, Any]]:
    httpx_client = await get_client(agent_server_origin)
    headers=[
        ("Content-Type", "application/json")
    ]
    session_request_url = f"{agent_server_origin}/apps/{agent_name}/users/{user_id}/sessions/{session_id}"
    session_response = await httpx_client.get(
        session_request_url,
        headers=headers
    )
    if session_response.status_code == 404:
        return None
    session_response.raise_for_status()
    return session_response.json()


async def list_agents(agent_server_origin: str) -> List[str]:
    httpx_client = await get_client(agent_server_origin)
    headers=[
        ("Content-Type", "application/json")
    ]
    list_url = f"{agent_server_origin}/list-apps"
    list_response = await httpx_client.get(
        list_url,
        headers=headers
    )
    list_response.raise_for_status()
    agent_list = list_response.json()
    if not agent_list:
        agent_list = ["agent"]
    return agent_list


async def query_adk_sever(
        agent_server_origin: str, agent_name: str, user_id: str, message: str, session_id
) -> AsyncGenerator[Dict[str, Any], None]:
    httpx_client = await get_client(agent_server_origin)
    request = {
        "appName": agent_name,
        "userId": user_id,
        "sessionId": session_id,
        "newMessage": {
            "role": "user",
            "parts": [{"text": message}]
        },
        "streaming": False
    }
    async with aconnect_sse(
        httpx_client,
        "POST",
        f"{agent_server_origin}/run_sse",
        json=request
    ) as event_source:
        if event_source.response.is_error:
            event = {
                "author": agent_name,
                "content":{
                    "parts": [
                        {
                            "text": f"Error {event_source.response.text}"
                        }
                    ]
                }
            }
            yield event
        else:
            async for server_event in event_source.aiter_sse():
                event = server_event.json()
                yield event

class SimpleChatRequest(BaseModel):
    message: str
    user_id: str = "test_user"
    session_id: Optional[str] = None

@app.post("/api/chat_stream")
async def chat_stream(request: SimpleChatRequest):
    """Streaming chat endpoint."""
    global agent_name, agent_server_url
    if not agent_name:
        agent_name = (await list_agents(agent_server_url))[0] # type: ignore

    session = None
    if request.session_id:
        session = await get_session(
            agent_server_url, # type: ignore
            agent_name,
            request.user_id,
            request.session_id
        )
    if session is None:
        session = await create_session(
            agent_server_url, # type: ignore
            agent_name,
            request.user_id
        )

    events = query_adk_sever(
        agent_server_url, # type: ignore
        agent_name,
        request.user_id,
        request.message,
        session["id"]
    )

    async def event_generator():
        final_text = ""
        rendered_content = None
        async for event in events:
            author = event.get("author")
            
            # 1. Search for rendered_content exactly where ADK puts it
            # It can be in grounding_metadata or a top-level field in some event types
            def extract_google_html(data):
                if not isinstance(data, dict): return None
                # Check direct fields
                for key in ["rendered_content", "renderedContent"]:
                    if data.get(key): return data.get(key)
                # Check grounding_metadata
                gm = data.get("grounding_metadata") or data.get("groundingMetadata")
                if isinstance(gm, dict):
                    rc = gm.get("rendered_content") or gm.get("renderedContent")
                    if rc: return rc
                # Recursive search for deeper nesting
                for v in data.values():
                    if isinstance(v, dict):
                        res = extract_google_html(v)
                        if res: return res
                return None

            rc = extract_google_html(event)
            if rc and not rendered_content:
                rendered_content = rc
                logger.info(f"Found google search html from {author}")
                yield json.dumps({"type": "progress", "text": "🔍 Google Search sources found..."}) + "\n"

            # 2. Progress updates
            if author == "researcher":
                 yield json.dumps({"type": "progress", "text": "🔍 Adventure Seeker is scouting..."}) + "\n"
            elif author == "judge":
                 yield json.dumps({"type": "progress", "text": "⚖️ Guardian is checking safety..."}) + "\n"
            elif author == "content_builder":
                 yield json.dumps({"type": "progress", "text": "✍️ Storysmith is writing..."}) + "\n"
            
            # 3. Accumulate text but STRICTLY FILTER OUT thoughts and technical noise
            if "content" in event and event["content"]:
                parts = event["content"].get("parts", [])
                for part in parts:
                    # BLOCK thoughts (this removes the "AI brain" chatter)
                    if part.get("thought") == True:
                        continue
                    
                    text = part.get("text")
                    if text:
                        # Filter out Judge's JSON and internal feedback
                        is_technical = text.strip().startswith("{") or text.strip().startswith("---{") or "Feedback:" in text
                        if not is_technical:
                            # Only take text from the Storysmith or Orchestrator to keep clean story
                            if author in ["content_builder", "gemini_tales_pipeline"]:
                                final_text += text
        
        # Final safety check for text
        if not final_text.strip():
            final_text = "The story is taking shape..."

        # Send final result
        yield json.dumps({"type": "result", "text": final_text.strip(), "rendered_content": rendered_content}) + "\n"

    return StreamingResponse(event_generator(), media_type="application/x-ndjson")

# Mount frontend from the copied location
frontend_path = os.path.join(os.path.dirname(__file__), "frontend")
if os.path.exists(frontend_path):
    app.mount("/", StaticFiles(directory=frontend_path, html=True), name="frontend")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", 8000)))
