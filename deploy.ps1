$ErrorActionPreference = "Stop"

$SCRIPT_DIR = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location $SCRIPT_DIR

if (Test-Path ".env") {
    Write-Host "Loading .env file..."
    Get-Content ".env" | Where-Object { $_ -match '=' -and -not $_.StartsWith('#') } | ForEach-Object {
        $name, $value = $_.Split('=', 2)
        $name = $name.Trim()
        $value = $value.Trim()
        [System.Environment]::SetEnvironmentVariable($name, $value, "Process")
        Set-Item -Path "Env:\$name" -Value $value
    }
}

$GOOGLE_CLOUD_PROJECT = $env:GOOGLE_CLOUD_PROJECT
if (-not $GOOGLE_CLOUD_PROJECT) {
    $GOOGLE_CLOUD_PROJECT = (gcloud config get-value project -q)
}
if (-not $GOOGLE_CLOUD_PROJECT) {
    Write-Host "ERROR: Run 'gcloud config set project' command to set active project, or set GOOGLE_CLOUD_PROJECT environment variable." -ForegroundColor Red
    exit 1
}

$REGION = $env:GOOGLE_CLOUD_LOCATION
if ($REGION -eq "global" -or -not $REGION) {
    $REGION = (gcloud config get-value compute/region -q)
    if (-not $REGION) {
        $REGION = "us-central1"
        Write-Host "WARNING: Using default region $REGION." -ForegroundColor Yellow
    }
}

Write-Host "Using project: $GOOGLE_CLOUD_PROJECT"
Write-Host "Using region: $REGION"

$agents = @("researcher", "judge", "content_builder", "orchestrator")

try {
    Write-Host "Preparing shared files..." -ForegroundColor Cyan
    foreach ($agent in $agents) {
        if (Test-Path "agents\$agent") {
            Get-ChildItem -Path "shared" | ForEach-Object {
                $dest = "agents\$agent\shared"
                if (-not (Test-Path $dest)) { New-Item -ItemType Directory -Path $dest -Force }
                Copy-Item -Path $_.FullName -Destination $dest -Force -Recurse
            }
            # Also copy adk_app.py to the agent root as before
            Copy-Item -Path "shared\adk_app.py", "shared\a2a_utils.py" -Destination "agents\$agent\" -Force
        }
    }

    Write-Host "`n--- Deploying Researcher ---" -ForegroundColor Cyan
    gcloud run deploy researcher `
        --source "agents\researcher" `
        --project $GOOGLE_CLOUD_PROJECT `
        --region $REGION `
        --no-allow-unauthenticated `
        --set-env-vars GOOGLE_CLOUD_PROJECT="$GOOGLE_CLOUD_PROJECT" `
        --set-env-vars GOOGLE_GENAI_USE_VERTEXAI="true"
    $RESEARCHER_URL = (gcloud run services describe researcher --region $REGION --format='value(status.url)')

    Write-Host "`n--- Deploying Content Builder ---" -ForegroundColor Cyan
    gcloud run deploy content-builder `
        --source "agents\content_builder" `
        --project $GOOGLE_CLOUD_PROJECT `
        --region $REGION `
        --no-allow-unauthenticated `
        --set-env-vars GOOGLE_CLOUD_PROJECT="$GOOGLE_CLOUD_PROJECT" `
        --set-env-vars GOOGLE_GENAI_USE_VERTEXAI="true"
    $CONTENT_BUILDER_URL = (gcloud run services describe content-builder --region $REGION --format='value(status.url)')

    Write-Host "`n--- Deploying Judge ---" -ForegroundColor Cyan
    gcloud run deploy judge `
        --source "agents\judge" `
        --project $GOOGLE_CLOUD_PROJECT `
        --region $REGION `
        --no-allow-unauthenticated `
        --set-env-vars GOOGLE_CLOUD_PROJECT="$GOOGLE_CLOUD_PROJECT" `
        --set-env-vars GOOGLE_GENAI_USE_VERTEXAI="true"
    $JUDGE_URL = (gcloud run services describe judge --region $REGION --format='value(status.url)')

    Write-Host "`n--- Deploying Orchestrator ---" -ForegroundColor Cyan
    gcloud run deploy orchestrator `
        --source "agents\orchestrator" `
        --project $GOOGLE_CLOUD_PROJECT `
        --region $REGION `
        --no-allow-unauthenticated `
        --set-env-vars RESEARCHER_AGENT_CARD_URL="$RESEARCHER_URL/a2a/agent/.well-known/agent-card.json" `
        --set-env-vars JUDGE_AGENT_CARD_URL="$JUDGE_URL/a2a/agent/.well-known/agent-card.json" `
        --set-env-vars BUILDER_AGENT_CARD_URL="$CONTENT_BUILDER_URL/a2a/agent/.well-known/agent-card.json" `
        --set-env-vars GOOGLE_CLOUD_PROJECT="$GOOGLE_CLOUD_PROJECT" `
        --set-env-vars GOOGLE_GENAI_USE_VERTEXAI="true"
    $ORCHESTRATOR_URL = (gcloud run services describe orchestrator --region $REGION --format='value(status.url)')

    Write-Host "`n--- Deploying Frontend (App) ---" -ForegroundColor Cyan
    gcloud run deploy gemini-tales `
        --source "app" `
        --project $GOOGLE_CLOUD_PROJECT `
        --region $REGION `
        --allow-unauthenticated `
        --set-env-vars AGENT_SERVER_URL="$ORCHESTRATOR_URL" `
        --set-env-vars GOOGLE_CLOUD_PROJECT="$GOOGLE_CLOUD_PROJECT"

    Write-Host "`nDEPLOYMENT COMPLETE!" -ForegroundColor Green
    Write-Host "Frontend URL: $(gcloud run services describe gemini-tales --region $REGION --format='value(status.url)')"
}
finally {
    Write-Host "`nCleaning up shared files..."
    foreach ($agent in $agents) {
        Remove-Item -Path "agents\$agent\adk_app.py", "agents\$agent\a2a_utils.py" -ErrorAction SilentlyContinue
        Remove-Item -Path "agents\$agent\shared" -Recurse -Force -ErrorAction SilentlyContinue
    }
}
