FROM python:3.12-slim

# Install uv
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

# Prepare virtual environment path
ENV VIRTUAL_ENV=/app/.venv
ENV PATH="/app/.venv/bin:$PATH"
ENV PYTHONUNBUFFERED=1

WORKDIR /app

# Install dependencies first for better caching
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-install-project --no-dev

# Copy the rest of the application
COPY . /app

# Final sync to install the project
RUN uv sync --frozen --no-dev

# Set host and port
ENV HOST 0.0.0.0
# Cloud Run expects 8080
EXPOSE 8080

# Use 'uv run' to guarantee the correct environment is active
CMD ["uv", "run", "adk_app.py", "--host", "0.0.0.0", "--port", "8080", "--trace_to_cloud", "--a2a", "."]
