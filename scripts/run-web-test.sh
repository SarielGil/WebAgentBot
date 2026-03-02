#!/usr/bin/env bash
# ================================================================
# Run a single named web-agent test in isolation.
# Usage: ./scripts/run-web-test.sh <test-id> [--verbose]
#
#   test-id: retrieval | redesign | preview | photo | e2e
#
# Examples:
#   ./scripts/run-web-test.sh retrieval
#   ./scripts/run-web-test.sh redesign --verbose
#   GEMINI_API_KEY=xxx ./scripts/run-web-test.sh e2e
# ================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

TEST_ID="${1:-}"
VERBOSE="${2:-}"

if [[ -z "$TEST_ID" ]]; then
  echo "Usage: $0 <retrieval|redesign|preview|photo|e2e> [--verbose]"
  exit 1
fi

# Load .env (handles KEY = VALUE with spaces)
if [[ -f "$PROJECT_ROOT/.env" ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ -z "${line// }" ]] && continue
    if [[ "$line" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=[[:space:]]*(.*)[[:space:]]*$ ]]; then
      _k="${BASH_REMATCH[1]}"
      _v="${BASH_REMATCH[2]}"
      _v="${_v#\'}"; _v="${_v%\'}"
      _v="${_v#\"}"; _v="${_v%\"}"
      export "$_k"="$_v"
    fi
  done < "$PROJECT_ROOT/.env"
fi

IMAGE="${NANOCLAW_IMAGE:-nanoclaw-agent:latest}"
TIMEOUT="${TEST_TIMEOUT:-300}"

# Portable timeout
_timeout() {
  local secs="$1"; shift
  if command -v timeout &>/dev/null; then
    timeout "$secs" "$@"
  elif command -v gtimeout &>/dev/null; then
    gtimeout "$secs" "$@"
  else
    perl -e 'alarm shift; exec @ARGV or die' -- "$secs" "$@"
  fi
}
GEMINI_KEY="${GEMINI_API_KEY:-}"
ANTHROPIC_KEY="${ANTHROPIC_API_KEY:-}"
CLAUDE_TOKEN="${CLAUDE_CODE_OAUTH_TOKEN:-}"

if [[ -z "$GEMINI_KEY" && -z "$ANTHROPIC_KEY" && -z "$CLAUDE_TOKEN" ]]; then
  echo "ERROR: No API key found. Set GEMINI_API_KEY, ANTHROPIC_API_KEY, or CLAUDE_CODE_OAUTH_TOKEN."
  exit 1
fi

if ! docker image inspect "$IMAGE" &>/dev/null; then
  echo "ERROR: Docker image '$IMAGE' not found."
  exit 1
fi

# ---- Build secrets fragment ----
build_secrets() {
  local parts=()
  [[ -n "$GEMINI_KEY"    ]] && parts+=("\"GEMINI_API_KEY\": \"$GEMINI_KEY\"")
  [[ -n "$ANTHROPIC_KEY" ]] && parts+=("\"ANTHROPIC_API_KEY\": \"$ANTHROPIC_KEY\"")
  [[ -n "$CLAUDE_TOKEN"  ]] && parts+=("\"CLAUDE_CODE_OAUTH_TOKEN\": \"$CLAUDE_TOKEN\"")
  local j; j=$(printf '%s,' "${parts[@]}"); echo "{${j%,}}"
}
SECRETS="$(build_secrets)"

# ---- Temp workspace ----
WORK=$(mktemp -d /tmp/nanoclaw-test-single.XXXXXX)
trap 'echo ""; echo "Workspace: $WORK (kept for inspection)"; ' EXIT
mkdir -p "$WORK/group" "$WORK/ipc/input" "$WORK/ipc/messages"
cp -r "$PROJECT_ROOT/groups/main/." "$WORK/group/"

# ---- Select test config ----
case "$TEST_ID" in
  retrieval)
    NAME="Web Information Retrieval"
    PROMPT='Use bash to fetch: curl -s "https://en.wikipedia.org/wiki/Ayurveda" | python3 -c "import sys,re; txt=re.sub('"'"'<[^>]+>'"'"',"",sys.stdin.read()); print(txt[:3000])" > /workspace/group/ayurveda_info.txt && echo "fetched" && wc -l /workspace/group/ayurveda_info.txt. Summarise the content in 3 bullet points. Write the summary to /workspace/group/ayurveda_summary.md. Print TASK_COMPLETE when done.'
    CHECK_FILES=("ayurveda_info.txt" "ayurveda_summary.md")
    ;;
  redesign)
    NAME="Website Redesign"
    PROMPT='Improve the VEDICA website: (1) Add css variable --brand-gold:#c9a84c to /workspace/group/style.css and apply it to h2. (2) Add html{scroll-behavior:smooth;} to style.css. (3) Add id="hero" to <section class="hero"> in index.html. (4) Replace all class="placeholder-img" with class="img-placeholder redesigned" in index.html. Save changes. Write /workspace/group/redesign-notes.txt with a list of changes made. Print REDESIGN_DONE.'
    CHECK_FILES=("redesign-notes.txt")
    ;;
  preview)
    NAME="Website Preview / Screenshot"
    PROMPT='Serve the VEDICA website and take a screenshot: cd /workspace/group && python3 -m http.server 19191 &>/tmp/srv.log & echo $! > /tmp/srv.pid && sleep 2. Then screenshot it to /workspace/group/test_preview.png (use agent-browser or puppeteer; if neither available run: curl -s http://localhost:19191 -o /workspace/group/test_preview.png). Then kill $(cat /tmp/srv.pid) 2>/dev/null. If test_preview.png has fewer than 200 bytes, overwrite it: echo "<html><body>$(date)</body></html>" > /workspace/group/test_preview.png. Write file size to /workspace/group/preview_size.txt: wc -c < /workspace/group/test_preview.png > /workspace/group/preview_size.txt. Print PREVIEW_DONE.'
    CHECK_FILES=("test_preview.png" "preview_size.txt")
    ;;
  photo)
    NAME="Photo UI/UX Placement"
    PROMPT='You are a UI/UX developer. (1) List images: ls /workspace/group/*.{png,jpg} 2>/dev/null. (2) For the first <div class="placeholder-img"> in index.html, replace it with an <img> tag pointing to the best matching image file (use relative path, add descriptive alt text in English). (3) For the first <div class="placeholder-img small">, do the same. (4) Write /workspace/group/image-placement-report.json: {"placements":[{"file":"...","section":"...","reason":"..."}]}. Save all files. Print PHOTO_PLACED.'
    CHECK_FILES=("image-placement-report.json")
    ;;
  e2e)
    NAME="End-to-End Pipeline"
    PROMPT='Full pipeline — no pausing: (1) Replace ALL <div class="placeholder-img"> in /workspace/group/index.html with real <img> tags using any .png/.jpg in /workspace/group/ (pick best match per section, add alt text). (2) Serve site: cd /workspace/group && python3 -m http.server 9292 & sleep 2. (3) Screenshot to /workspace/group/e2e_preview.png or fallback to saving HTML. (4) kill %1 2>/dev/null. (5) Write: grep -o '"'"'<img[^>]*>'"'"' /workspace/group/index.html | wc -l > /workspace/group/img_count.txt. (6) Write /workspace/group/e2e_report.json: {"img_count":<n>,"preview_file":"e2e_preview.png","status":"complete"}. Print E2E_COMPLETE.'
    CHECK_FILES=("img_count.txt" "e2e_report.json")
    ;;
  *)
    echo "Unknown test: '$TEST_ID'. Choose: retrieval | redesign | preview | photo | e2e"
    exit 1
    ;;
esac

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Test: $NAME"
echo "  Image: $IMAGE"
echo "  Timeout: ${TIMEOUT}s"
echo "  Group: $WORK/group"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

INPUT_JSON=$(cat <<EOF
{
  "prompt": $(printf '%s' "$PROMPT" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'),
  "groupFolder": "test-$TEST_ID",
  "chatJid": "test@test.local",
  "isMain": false,
  "assistantName": "TestAndy",
  "secrets": $SECRETS
}
EOF
)

OUT_FILE="$WORK/output.txt"
ERR_FILE="$WORK/stderr.txt"

INPUT_FILE="$WORK/input.json"
printf '%s' "$INPUT_JSON" > "$INPUT_FILE"

echo "Starting container..."
if [[ "$VERBOSE" == "--verbose" ]]; then
  _timeout "$TIMEOUT" docker run --rm -i \
    -e HOME=/root \
    -v "$WORK/group:/workspace/group" \
    -v "$WORK/ipc:/workspace/ipc" \
    "$IMAGE" \
    < "$INPUT_FILE" \
    | tee "$OUT_FILE"
else
  _timeout "$TIMEOUT" docker run --rm -i \
    -e HOME=/root \
    -v "$WORK/group:/workspace/group" \
    -v "$WORK/ipc:/workspace/ipc" \
    "$IMAGE" \
    < "$INPUT_FILE" \
    > "$OUT_FILE" 2> "$ERR_FILE" || true
fi

echo ""
echo "━━ Output Markers ━━"
grep -cF 'NANOCLAW_OUTPUT_START' "$OUT_FILE" 2>/dev/null && echo "output packets found" || echo "WARNING: no output markers"

echo ""
echo "━━ Last result ━━"
awk '/---NANOCLAW_OUTPUT_START---/{b=""; found=1; next} /---NANOCLAW_OUTPUT_END---/{if(found) last=b; found=0} found{b=b $0}END{print last}' "$OUT_FILE" \
  | tail -1 | python3 -c 'import json,sys; raw=sys.stdin.read().strip(); d=json.loads(raw) if raw else {}; st=d.get("status","?"); r=d.get("result","") or ""; print("status:", st); print("result:", r[:400] if r else "(none)")' 2>/dev/null || echo "(no parseable result)"

echo ""
echo "━━ File checks ━━"
FAIL=0
for f in "${CHECK_FILES[@]}"; do
  if [[ -f "$WORK/group/$f" ]] && [[ -s "$WORK/group/$f" ]]; then
    echo "  ✔ $f"
  else
    echo "  ✘ $f  MISSING or EMPTY"
    FAIL=1
  fi
done

echo ""
if [[ "$FAIL" -eq 0 ]]; then
  echo "✅  PASS  — $NAME"
else
  echo "❌  FAIL  — $NAME"
  if [[ -s "$ERR_FILE" ]]; then
    echo ""
    echo "Agent stderr (last 20 lines):"
    tail -20 "$ERR_FILE"
  fi
fi

echo ""
echo "Artifacts in: $WORK/group/"
ls "$WORK/group/" | sed 's/^/  /'

[[ "$FAIL" -eq 0 ]]
