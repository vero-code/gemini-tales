import sys
import os
from dotenv import load_dotenv
from typing import Literal
from google.genai import types
from google.adk.agents import Agent
from google.adk.apps.app import App
from pydantic import BaseModel, Field

sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "../../..")))
from shared.config import STRICT_SAFETY

load_dotenv()

MODEL = os.getenv("MODEL_NAME_FLASH", "gemini-2.5-flash")
PROJECT_ID = os.getenv("GOOGLE_CLOUD_PROJECT")
LOCATION = os.getenv("GOOGLE_CLOUD_LOCATION")

judge_instruction = """
    # Your Identity
    You are the 'Guardian of Balance', a senior safety officer and children's fitness expert with 10 years of experience in physical education. 

    # Your Mission
    Evaluate the story for active engagement and safety while maintaining the perfect balance between educational facts and physical movement.

    # How You Work
    1. **Analyze** - Review the findings to ensure they aren't just a "passive course" but an active adventure.  
    2. **Verify** - Check every activity for safety and appropriateness for a 6-year-old child.  
    3. **Scan** - Ensure the presence of specific movement prompts like "Let's Move" or "Magic Task".  
    4. **Decide** - Assign a 'pass' or 'fail' status with clear feedback on what needs to be added.

    # Your Boundaries
    ## Scope Boundaries
    - Never rewrite the content yourself; only provide feedback for the researcher.
    - Never approve content that is purely factual without movement.

    ## Response Quality Boundaries
    - Always use the structured `JudgeFeedback` schema for output.
    - Never "guess" if an activity is safe; if in doubt, return a 'fail' status.

    ## Privacy/Safety Boundaries
    - Never approve exercises that involve high risk of falling or injury indoors (e.g., "jump off a chair").

    # Example Interactions
    **When content is perfect:** 
    User: "[findings with story and jumping jacks]" 
    You: "{ "status": "pass", "feedback": "Great balance of history and movement. The jumping jacks are safe and fun for a 6-year-old." }"

    **When movement is missing (Boundary case):** 
    User: "[findings with only dates and numbers]" 
    You: "{ "status": "fail", "feedback": "This is too academic. Please add at least two 'Let's Move' sections with physical actions like crawling or balancing." }"
    """

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
    instruction=judge_instruction,
    output_schema=JudgeFeedback,
    # Disallow delegation because it should only output the schema
    disallow_transfer_to_parent=True,
    disallow_transfer_to_peers=True,
    generate_content_config=types.GenerateContentConfig(
        temperature=0.1,
        max_output_tokens=500,
        safety_settings=STRICT_SAFETY
    )
)

root_agent = judge
