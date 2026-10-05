#!/bin/bash
# Per-job runner: fetches rendered prompts from API, invokes Claude CLI per field, posts outputs back.
# Usage: seo-backfill-generate.sh <job-uuid>

set -euo pipefail

JOB_ID="${1:-}"
if [ -z "$JOB_ID" ]; then
  echo "Usage: $0 <job-uuid>" >&2
  exit 1
fi

REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
API_URL="${API_URL:-http://localhost:8080}"
MAX_RETRIES="${SEO_BACKFILL_MAX_RETRIES:-3}"
CLAUDE_TIMEOUT="${SEO_BACKFILL_CLAUDE_TIMEOUT:-300}"

# Add claude CLI to PATH in case this script is invoked directly without poll script's env
export PATH="$HOME/.local/bin:$PATH"
for claude_dir in "$HOME"/.vscode/extensions/anthropic.claude-code-*/resources/native-binary; do
  [ -d "$claude_dir" ] && export PATH="$claude_dir:$PATH" && break
done

log() { echo "[$(date '+%H:%M:%S')] [$JOB_ID] $*"; }
# shellcheck source=infra/scripts/claude-isolated.sh
source "$REPO_DIR/infra/scripts/claude-isolated.sh"

fail_job() {
  local err="$1"
  log "FAIL: $err"
  local escaped
  escaped=$(printf '%s' "$err" | python3 -c 'import sys,json; sys.stdout.write(json.dumps(sys.stdin.read()))' 2>/dev/null || echo "\"$err\"")
  curl -sS -X POST "$API_URL/internal/seo/jobs/$JOB_ID/fail" \
    -H "Content-Type: application/json" \
    -d "{\"error\":$escaped}" >/dev/null || true
}

# Fetch job context (rendered prompts + schemas).
CTX=$(curl -sS "$API_URL/internal/seo/jobs/$JOB_ID/context" || true)
if [ -z "$CTX" ]; then
  fail_job "Failed to GET context"
  exit 1
fi

# The context response is JSON: { jobId, entityType, entityId, prompts: [{fieldType, prompt, outputSchema, model, maxTokens, temperature}, ...] }
# Pull each prompt out with jq. If jq missing, fail cleanly.
if ! command -v jq >/dev/null 2>&1; then
  fail_job "jq not installed on host — required for context parsing"
  exit 1
fi

NUM=$(echo "$CTX" | jq '.prompts | length')
if [ "$NUM" = "0" ] || [ -z "$NUM" ]; then
  fail_job "Context returned no prompts"
  exit 1
fi

log "Processing $NUM fields"

OUTPUTS_JSON="{}"
for ((i=0; i<NUM; i++)); do
  FIELD=$(echo "$CTX" | jq -r ".prompts[$i].fieldType")
  PROMPT=$(echo "$CTX" | jq -r ".prompts[$i].prompt")
  # outputSchema is not read here: jq cannot validate a JSON schema, so the API does it on apply (SeoContentValidator).
  MODEL=$(echo "$CTX" | jq -r ".prompts[$i].model")

  log "Field '$FIELD' via $MODEL"

  # Retry loop with error feedback injected into subsequent prompts
  ATTEMPT=0
  RETRY_PROMPT="$PROMPT"
  RAW_OUTPUT=""
  SUCCESS=false

  while [ "$ATTEMPT" -lt "$MAX_RETRIES" ]; do
    ATTEMPT=$((ATTEMPT + 1))

    if ! RAW_OUTPUT=$(claude_isolated "$CLAUDE_TIMEOUT" -p --model "$MODEL" --permission-mode default "$RETRY_PROMPT" 2>&1); then
      log "  Attempt $ATTEMPT: Claude CLI error"
      RETRY_PROMPT="$PROMPT

Previous attempt failed (CLI error). Return ONLY valid JSON matching the schema — no markdown, no explanation."
      continue
    fi

    # Strip markdown fences if Claude wraps output
    CLEANED=$(echo "$RAW_OUTPUT" | sed -E 's/^```(json)?//; s/```$//' | tr -d '\r')

    # Validate JSON parseability
    if echo "$CLEANED" | jq empty >/dev/null 2>&1; then
      RAW_OUTPUT="$CLEANED"
      SUCCESS=true
      break
    fi

    log "  Attempt $ATTEMPT: output not valid JSON"
    RETRY_PROMPT="$PROMPT

Previous attempt returned invalid JSON. Return ONLY valid JSON matching the schema — no prose, no code fences."
  done

  if [ "$SUCCESS" != "true" ]; then
    fail_job "Field '$FIELD' failed after $MAX_RETRIES attempts"
    exit 1
  fi

  # Add to OUTPUTS_JSON as {fieldName: rawJsonString}. We stringify the raw JSON (API parses it again + validates vs schema).
  OUTPUTS_JSON=$(jq --arg f "$FIELD" --arg v "$RAW_OUTPUT" '. + {($f): $v}' <<<"$OUTPUTS_JSON")
done

# Post apply
APPLY_BODY=$(jq -n --argjson outs "$OUTPUTS_JSON" '{fieldOutputs: $outs}')
APPLY_RESULT=$(curl -sS -X POST "$API_URL/internal/seo/jobs/$JOB_ID/apply" \
  -H "Content-Type: application/json" \
  --data-binary "$APPLY_BODY" || true)

STATUS=$(echo "$APPLY_RESULT" | jq -r '.status // empty')
if [ -z "$STATUS" ]; then
  fail_job "Apply endpoint returned unexpected response: $APPLY_RESULT"
  exit 1
fi

log "Apply result: $STATUS"
