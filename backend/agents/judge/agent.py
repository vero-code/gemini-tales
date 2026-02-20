import os
from dotenv import load_dotenv
from typing import Literal
from google.adk.agents import Agent
from google.adk.apps.app import App
from pydantic import BaseModel, Field

load_dotenv()

MODEL = os.getenv("MODEL_NAME", "gemini-2.5-pro")
PROJECT_ID = os.getenv("GOOGLE_CLOUD_PROJECT")
LOCATION = os.getenv("GOOGLE_CLOUD_LOCATION")

# 1. Define the Schema
class JudgeFeedback(BaseModel):
    """Structured feedback from the Judge agent."""
    status: Literal["pass", "fail"] = Field(
        description="Whether the research is sufficient ('pass') or needs more work ('fail')."
    )
    feedback: str = Field(
        description="Detailed feedback on what is missing. If 'pass', a brief confirmation."
    )

# 2. Define the Agent
judge = Agent(
    name="judge",
    model=MODEL,
    description="Evaluates content for safety, engagement, and physical activity.",
    instruction="""
    You are the 'Guardian of Balance'. Your task is to ensure the adventure is active and safe for kids.
    
    Evaluate the 'research_findings' based on these rules:
    1. **Movement Check**: Does the content include specific physical exercises or action prompts? If it's just plain text without movement, return status='fail'.
    2. **Engagement**: Is the story exciting for a child?
    3. **Safety**: Are the activities safe to do indoors?
    
    If physical activities are missing or insufficient, return status='fail' and tell the researcher to add more 'Let's Move' sections.
    If the balance between facts and movement is good, return status='pass'.
    """,
    output_schema=JudgeFeedback,
    # Disallow delegation because it should only output the schema
    disallow_transfer_to_parent=True,
    disallow_transfer_to_peers=True,
)

root_agent = judge
