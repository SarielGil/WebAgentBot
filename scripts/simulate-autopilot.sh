#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

MODE="${1:-smoke}" # smoke | full
TS="$(date +%Y%m%d-%H%M%S)"
REPORT_DIR="$ROOT_DIR/logs"
REPORT_FILE="$REPORT_DIR/autopilot-${TS}.md"
mkdir -p "$REPORT_DIR"

PASS=0
FAIL=0
SKIP=0

log() { printf "%s\n" "$*" | tee -a "$REPORT_FILE"; }

run_step() {
  local name="$1"
  local cmd="$2"
  log ""
  log "## ${name}"
  log ""
  log '```bash'
  log "$cmd"
  log '```'
  if bash -lc "$cmd" >>"$REPORT_FILE" 2>&1; then
    PASS=$((PASS + 1))
    log ""
    log "- Result: PASS"
    return 0
  fi
  FAIL=$((FAIL + 1))
  log ""
  log "- Result: FAIL"
  return 1
}

skip_step() {
  local name="$1"
  local reason="$2"
  SKIP=$((SKIP + 1))
  log ""
  log "## ${name}"
  log ""
  log "- Result: SKIP"
  log "- Reason: ${reason}"
}

log "# NanoClaw Autopilot Simulation"
log ""
log "- Started: $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
log "- Mode: ${MODE}"
log "- Root: ${ROOT_DIR}"

run_step "Build" "npm run -s build" || true
run_step "Core Reliability Tests" "npm test -- --run src/group-queue.test.ts src/ipc-auth.test.ts src/container-runner.test.ts src/channels/telegram.test.ts" || true

if [[ "${MODE}" == "full" ]]; then
  if [[ -z "${GEMINI_API_KEY:-}" ]]; then
    skip_step "Flow E2E" "GEMINI_API_KEY not set"
  else
    run_step "Flow E2E" "npm run -s test:e2e -- --verbose" || true
  fi

  if docker image inspect nanoclaw-agent:latest >/dev/null 2>&1; then
    if [[ -z "${GEMINI_API_KEY:-}" && -z "${ANTHROPIC_API_KEY:-}" && -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]]; then
      skip_step "Web Agent E2E" "No LLM key found for web-agent tests"
    else
      run_step "Web Agent E2E" "npm run -s test:web:e2e" || true
    fi
  else
    skip_step "Web Agent E2E" "nanoclaw-agent:latest image not found"
  fi
else
  run_step "Greeting E2E (Stage 1)" "npm run -s test:e2e -- --stage 1" || true
fi

log ""
log "## Summary"
log ""
log "- PASS: ${PASS}"
log "- FAIL: ${FAIL}"
log "- SKIP: ${SKIP}"
log "- Report: ${REPORT_FILE}"

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi

