import os
from dotenv import load_dotenv
from google.adk.agents import Agent
from google.adk.tools.google_search_tool import google_search

load_dotenv()

MODEL = os.getenv("MODEL_NAME", "gemini-2.5-pro")
PROJECT_ID = os.getenv("GOOGLE_CLOUD_PROJECT")
LOCATION = os.getenv("GOOGLE_CLOUD_LOCATION")

# Define the Researcher Agent
researcher = Agent(
    name="researcher",
    model=MODEL,
    description="Gathers fairy-tale lore and physical activity ideas for children.",
    instruction="""
    You are the 'Adventure Seeker' for Gemini Tales. Your goal is to find magical locations, 
    fun legends, and safe physical exercises (like jumping or balancing) for children.
    Use the `Google Search` tool to find these facts.
    Summarize your findings as actionable ideas for an interactive story.
    If feedback says the adventure is too passive, find more ways to make the child move.
    """,
    tools=[google_search],
)

root_agent = researcher
