import logging
import os
import json
import asyncio
import ssl
import certifi
import google.auth
from google.auth.transport.requests import Request
import websockets
from dotenv import load_dotenv
from typing import Any, AsyncGenerator, Dict, List, Optional

import httpx
from httpx_sse import aconnect_sse

from fastapi import FastAPI, WebSocket
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
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

# GEMINI LIVE API WEBSOCKET PROXY
def generate_gcp_token():
    """Retrieves an access token using Google Cloud default credentials."""
    try:
        creds, _ = google.auth.default()
        if not creds.valid:
            creds.refresh(Request())
        return creds.token
    except Exception as e:
        logger.error(f"Error generating access token: {e}")
        return None

@app.websocket("/ws/proxy")
async def gemini_live_proxy(websocket: WebSocket):
    """
    WebSocket proxy for Gemini Live API.
    Replaces the standalone server.py from Google's demo.
    """
    await websocket.accept()
    logger.info("🔌 New WebSocket client connected to proxy")
    
    server_websocket = None
    
    try:
        # Read settings from browser
        setup_message_raw = await asyncio.wait_for(websocket.receive_text(), timeout=10.0)
        setup_data = json.loads(setup_message_raw)
        
        service_url = setup_data.get("service_url")
        if not service_url:
            await websocket.close(code=1008, reason="Service URL is required")
            return

        bearer_token = setup_data.get("bearer_token") or generate_gcp_token()
        if not bearer_token:
            await websocket.close(code=1008, reason="Authentication failed")
            return

        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {bearer_token}",
        }
        ssl_context = ssl.create_default_context(cafile=certifi.where())
        
        logger.info(f"Connecting to Gemini API: {service_url.split('?')[0]}...")
        
        async with websockets.connect(
            service_url, additional_headers=headers, ssl=ssl_context
        ) as s_ws:
            server_websocket = s_ws
            logger.info("✅ Connected to Gemini API")

            # Channel: Browser -> Google (Only text)
            async def client_to_server():
                try:
                    while True:
                        message = await websocket.receive_text()
                        await server_websocket.send(message)
                except Exception as e:
                    logger.debug(f"C->S closed: {e}")

            # Channel: Google -> Browser (Convert everything to text!)
            async def server_to_client():
                try:
                    async for message in server_websocket:
                        # If Google sends JSON as bytes, decode it to a string
                        if isinstance(message, bytes):
                            message = message.decode('utf-8')
                        
                        await websocket.send_text(message)
                except Exception as e:
                    logger.debug(f"S->C closed: {e}")

            pump_tasks = [
                asyncio.create_task(client_to_server()),
                asyncio.create_task(server_to_client())
            ]
            
            done, pending = await asyncio.wait(
                pump_tasks, return_when=asyncio.FIRST_COMPLETED
            )
            
            for task in pending:
                task.cancel()

    except Exception as e:
        logger.error(f"Proxy error: {e}")
    finally:
        if server_websocket:
            try:
                await server_websocket.close()
            except Exception:
                pass
        logger.info("Proxy connection closed")

# MOUNT STATIC FILES
# Restore legacy demo path for access
legacy_demo_path = os.path.join(os.path.dirname(__file__), "frontend_legacy", "live_demo")
if os.path.exists(legacy_demo_path):
    app.mount("/demo", StaticFiles(directory=legacy_demo_path, html=True), name="live_demo")

# Use 'dist' folder for React production build
frontend_path = os.path.join(os.path.dirname(__file__), "frontend", "dist")
if os.path.exists(frontend_path):
    app.mount("/", StaticFiles(directory=frontend_path, html=True), name="frontend")
else:
    # Fallback for development if dist doesn't exist yet
    legacy_path = os.path.join(os.path.dirname(__file__), "frontend_legacy")
    if os.path.exists(legacy_path):
        app.mount("/", StaticFiles(directory=legacy_path, html=True), name="frontend")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", 8000)))
