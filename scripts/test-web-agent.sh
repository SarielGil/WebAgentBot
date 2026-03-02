#!/usr/bin/env bash
# ============================================================
# NanoClaw Web Agent Test Suite
# Tests website redesign, preview, web-info retrieval and
# photo UI/UX placement - all run inside nanoclaw-agent:latest
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ---- Colors ----
C_RESET='\033[0m'
C_GREEN='\033[0;32m'
C_RED='\033[0;31m'
C_YELLOW='\033[1;33m'
C_CYAN='\033[0;36m'
C_BOLD='\033[1m'

PASS=0
FAIL=0
SKIP=0

pass()  { echo -e "  ${C_GREEN}✔ PASS${C_RESET}  $1"; PASS=$((PASS+1));  }
fail()  { echo -e "  ${C_RED}✘ FAIL${C_RESET}  $1"; FAIL=$((FAIL+1));  }
skip()  { echo -e "  ${C_YELLOW}⊘ SKIP${C_RESET}  $1"; SKIP=$((SKIP+1)); }
header(){ echo -e "\n${C_CYAN}${C_BOLD}══ $1 ══${C_RESET}"; }

# ---- Resolve API keys ----
# Accept from environment; fall back to .env in project root
source_env() {
  local env_file="$PROJECT_ROOT/.env"
  if [[ -f "$env_file" ]]; then
    while IFS= read -r line || [[ -n "$line" ]]; do
      # Skip comments and blank lines
      [[ "$line" =~ ^[[:space:]]*# ]] && continue
      [[ -z "${line// }" ]] && continue
      # Strip spaces around = and export
      if [[ "$line" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=[[:space:]]*(.*)[[:space:]]*$ ]]; then
        local key="${BASH_REMATCH[1]}"
        local val="${BASH_REMATCH[2]}"
        # Strip surrounding quotes
        val="${val#\'}"; val="${val%\'}"
        val="${val#\"}"; val="${val%\"}"
        export "$key"="$val"
      fi
    done < "$env_file"
  fi
}
source_env

GEMINI_KEY="${GEMINI_API_KEY:-}"
ANTHROPIC_KEY="${ANTHROPIC_API_KEY:-}"
CLAUDE_TOKEN="${CLAUDE_CODE_OAUTH_TOKEN:-}"

# Must have at least one backend key
if [[ -z "$GEMINI_KEY" && -z "$ANTHROPIC_KEY" && -z "$CLAUDE_TOKEN" ]]; then
  echo -e "${C_RED}ERROR: Set GEMINI_API_KEY or ANTHROPIC_API_KEY before running tests.${C_RESET}"
  exit 1
fi

# ---- Docker image check ----
IMAGE="${NANOCLAW_IMAGE:-nanoclaw-agent:latest}"
if ! docker image inspect "$IMAGE" &>/dev/null; then
  echo -e "${C_RED}ERROR: Docker image '$IMAGE' not found. Run: docker build -t nanoclaw-agent:latest container/${C_RESET}"
  exit 1
fi

# ---- Temp workspace ----
TMPDIR_BASE=$(mktemp -d /tmp/nanoclaw-web-tests.XXXXXX)
trap 'rm -rf "$TMPDIR_BASE"' EXIT

GROUP_DIR="$TMPDIR_BASE/group"
IPC_DIR="$TMPDIR_BASE/ipc"
mkdir -p "$GROUP_DIR" "$IPC_DIR/input" "$IPC_DIR/output" "$IPC_DIR/messages"

# Copy the real VEDICA website into the test group folder so tests operate on real content
cp -r "$PROJECT_ROOT/groups/main/." "$GROUP_DIR/"
# Copy any existing images
for img in "$PROJECT_ROOT/groups/main"/*.png "$PROJECT_ROOT/groups/main"/*.jpg; do
  [[ -f "$img" ]] && cp "$img" "$GROUP_DIR/" 2>/dev/null || true
done

TIMEOUT="${TEST_TIMEOUT:-300}"  # seconds per test (5 min default)

# Portable timeout wrapper: use GNU timeout, gtimeout, or perl fallback
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

# ---- Build secrets JSON fragment ----
build_secrets_json() {
  local parts=()
  [[ -n "$GEMINI_KEY"    ]] && parts+=("\"GEMINI_API_KEY\": \"$GEMINI_KEY\"")
  [[ -n "$ANTHROPIC_KEY" ]] && parts+=("\"ANTHROPIC_API_KEY\": \"$ANTHROPIC_KEY\"")
  [[ -n "$CLAUDE_TOKEN"  ]] && parts+=("\"CLAUDE_CODE_OAUTH_TOKEN\": \"$CLAUDE_TOKEN\"")
  local joined
  joined=$(printf '%s,' "${parts[@]}")
  echo "{${joined%,}}"
}
SECRETS_JSON="$(build_secrets_json)"

# ---- Run a single agent invocation ----
# Usage: run_agent <test_name> <prompt> [<extra_mount_args>...]
# Writes raw output to $TMPDIR_BASE/<test_name>.out
# Returns 0 on success marker found, 1 on timeout/error
run_agent() {
  local test_name="$1"
  local prompt="$2"
  shift 2
  local extra_mounts=("$@")

  local group_dir="$TMPDIR_BASE/group_${test_name}"
  # Each test gets its own copy so they don't clobber each other
  cp -r "$GROUP_DIR" "$group_dir"

  local out_file="$TMPDIR_BASE/${test_name}.out"
  local err_file="$TMPDIR_BASE/${test_name}.err"

  local input_json
  input_json=$(cat <<EOF
{
  "prompt": $(printf '%s' "$prompt" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'),
  "groupFolder": "test-${test_name}",
  "chatJid": "test@test.local",
  "isMain": false,
  "assistantName": "TestAndy",
  "secrets": $SECRETS_JSON
}
EOF
)

  local docker_args=(
    run --rm -i
    -e "HOME=/root"
    -v "${group_dir}:/workspace/group"
    -v "${IPC_DIR}:/workspace/ipc"
    "$IMAGE"
  )

  if [[ "${#extra_mounts[@]}" -gt 0 ]]; then
    docker_args=(
      run --rm -i
      -e "HOME=/root"
      -v "${group_dir}:/workspace/group"
      -v "${IPC_DIR}:/workspace/ipc"
      "${extra_mounts[@]}"
      "$IMAGE"
    )
  fi

  local input_file="$TMPDIR_BASE/${test_name}.input.json"
  printf '%s' "$input_json" > "$input_file"

  if ! _timeout "$TIMEOUT" docker "${docker_args[@]}" \
       < "$input_file" \
       > "$out_file" 2> "$err_file"; then
    echo "  [TIMEOUT/ERROR for $test_name — see $err_file]" >&2
    return 1
  fi

  # Check output marker exists
  grep -qF 'NANOCLAW_OUTPUT_START' "$out_file"
}

# ---- Extract JSON result from output ----
extract_result() {
  local out_file="$1"
  awk '/NANOCLAW_OUTPUT_START/{found=1; next} /NANOCLAW_OUTPUT_END/{found=0} found' "$out_file" \
    | head -1
}

# ---- Grab the last successful result text ----
get_result_text() {
  local out_file="$1"
  # Print each line between markers, use head -1 to get the JSON line, then parse
  awk '/NANOCLAW_OUTPUT_START/{found=1; next} /NANOCLAW_OUTPUT_END/{found=0; next} found{print}' "$out_file" \
    | tail -1 \
    | python3 -c 'import json,sys; raw=sys.stdin.read().strip(); d=json.loads(raw) if raw else {}; print(d.get("result","") or "")' 2>/dev/null || true
}

group_dir_for() { echo "$TMPDIR_BASE/group_${1}"; }

# ==============================================================
# TEST 1 — Web Information Retrieval
# ==============================================================
header "T1 · Web Information Retrieval"
echo "  Asking the agent to fetch info from a live URL and save it locally..."

T1_PROMPT="Do the following steps with no questions:
1. Use bash to run: curl -s 'https://en.wikipedia.org/wiki/Ayurveda' | python3 -c \"import sys,re; txt=re.sub('<[^>]+>','',sys.stdin.read()); print(txt[:3000])\" > /workspace/group/ayurveda_info.txt
2. Read the file and summarise the key points in 3 bullet points.
3. Write the summary to /workspace/group/ayurveda_summary.md
When done, print: TASK_COMPLETE"

if run_agent "t1_web_retrieval" "$T1_PROMPT"; then
  G="$(group_dir_for t1_web_retrieval)"
  result_text="$(get_result_text "$TMPDIR_BASE/t1_web_retrieval.out")"

  if [[ -f "$G/ayurveda_info.txt" ]] && [[ -s "$G/ayurveda_info.txt" ]]; then
    pass "ayurveda_info.txt created and non-empty"
  else
    fail "ayurveda_info.txt missing or empty"
  fi

  if [[ -f "$G/ayurveda_summary.md" ]] && [[ -s "$G/ayurveda_summary.md" ]]; then
    pass "ayurveda_summary.md written by agent"
  else
    fail "ayurveda_summary.md missing or empty"
  fi

  if echo "$result_text" | grep -qi "TASK_COMPLETE\|summary\|bullet\|ayurveda\|ancient"; then
    pass "Agent output references summary content"
  else
    fail "Agent output did not mention summary content (got: ${result_text:0:200})"
  fi
else
  fail "T1 container exited with error/timeout"
  skip "ayurveda_info.txt check"
  skip "ayurveda_summary.md check"
  skip "Agent output content check"
fi


# ==============================================================
# TEST 2 — Website Redesign
# ==============================================================
header "T2 · Website Redesign"
echo "  Asking the agent to improve CSS and modernise the hero section..."

T2_PROMPT="You are a web developer. Improve the VEDICA website hero section (in /workspace/group/index.html and /workspace/group/style.css):
1. In style.css: add a CSS variable --brand-gold: #c9a84c and apply it to the hero h2 text.
2. In style.css: add a smooth scroll behaviour: html { scroll-behavior: smooth; }
3. In index.html: add id=\"hero\" to the <section class=\"hero\"> element so it can be anchor-linked.
4. In index.html: replace every occurrence of class=\"placeholder-img\" with class=\"img-placeholder redesigned\" so the change is traceable.
5. Write a file /workspace/group/redesign-notes.txt listing the 4 changes made.
Do not ask questions. When done print: REDESIGN_DONE"

if run_agent "t2_redesign" "$T2_PROMPT"; then
  G="$(group_dir_for t2_redesign)"

  if grep -q 'scroll-behavior' "$G/style.css" 2>/dev/null; then
    pass "smooth scroll added to style.css"
  else
    fail "scroll-behavior not found in style.css"
  fi

  if grep -q '\-\-brand-gold\|brand.gold\|#c9a84c' "$G/style.css" 2>/dev/null; then
    pass "CSS variable --brand-gold added to style.css"
  else
    fail "--brand-gold CSS variable missing in style.css"
  fi

  if grep -q 'id="hero"\|id=.hero.' "$G/index.html" 2>/dev/null; then
    pass "id=\"hero\" anchor added to index.html"
  else
    fail "id=\"hero\" anchor missing in index.html"
  fi

  if grep -q 'img-placeholder redesigned\|img-placeholder.*redesigned' "$G/index.html" 2>/dev/null; then
    pass "placeholder-img classes replaced with redesigned variant"
  else
    fail "placeholder-img classes not replaced in index.html"
  fi

  if [[ -f "$G/redesign-notes.txt" ]] && [[ -s "$G/redesign-notes.txt" ]]; then
    pass "redesign-notes.txt written"
  else
    fail "redesign-notes.txt missing or empty"
  fi
else
  fail "T2 container exited with error/timeout"
  skip "smooth scroll check"
  skip "--brand-gold check"
  skip "hero anchor check"
  skip "placeholder class check"
  skip "redesign notes check"
fi


# ==============================================================
# TEST 3 — Website Preview (Screenshot)
# ==============================================================
header "T3 · Website Preview via Screenshot"
echo "  Asking the agent to serve the site and screenshot it..."

T3_PROMPT="Take a screenshot of the VEDICA website:
1. Start a local python HTTP server in /workspace/group on a free port:
   PORT=19191
   cd /workspace/group && python3 -m http.server \$PORT &>/tmp/srv.log &
   echo \$! > /tmp/srv.pid
   sleep 2
   # verify server started
   curl -s http://localhost:\$PORT/ -o /dev/null && echo server_ok || echo server_failed
2. Take a screenshot:
   If agent-browser is available: agent-browser open http://localhost:\$PORT && agent-browser wait --load networkidle && agent-browser screenshot /workspace/group/test_preview.png --full
   Else try puppeteer: node -e \"const p=require('puppeteer');(async()=>{const b=await p.launch({args:['--no-sandbox']});const pg=await b.newPage();await pg.goto('http://localhost:\$PORT',{waitUntil:'networkidle0'});await pg.screenshot({path:'/workspace/group/test_preview.png',fullPage:true});await b.close()})()\" 2>/dev/null
   If neither is available: curl -s http://localhost:\$PORT/ > /workspace/group/test_preview.png
3. Kill the server: kill \$(cat /tmp/srv.pid) 2>/dev/null || true
4. Verify the file: ls -la /workspace/group/test_preview.png && stat -c%s /workspace/group/test_preview.png > /workspace/group/preview_size.txt
Print: PREVIEW_DONE when finished."

if run_agent "t3_preview" "$T3_PROMPT"; then
  G="$(group_dir_for t3_preview)"

  if [[ -f "$G/test_preview.png" ]]; then
    SIZE=$(wc -c < "$G/test_preview.png")
    if [[ "$SIZE" -gt 100 ]]; then
      pass "test_preview.png created (${SIZE} bytes)"
    else
      fail "test_preview.png exists but suspiciously small (${SIZE} bytes)"
    fi
  else
    fail "test_preview.png not created"
  fi

  if [[ -f "$G/preview_size.txt" ]] && [[ -s "$G/preview_size.txt" ]]; then
    pass "preview_size.txt written by agent"
  else
    fail "preview_size.txt missing"
  fi
else
  fail "T3 container exited with error/timeout"
  skip "test_preview.png check"
  skip "preview_size.txt check"
fi


# ==============================================================
# TEST 4 — Photo Discovery & UI/UX Placement
# ==============================================================
header "T4 · Photo Discovery & UI/UX Placement"
echo "  Asking the agent to find images and embed them in the right HTML sections..."

T4_PROMPT="You are a UI/UX developer. The VEDICA website has placeholder divs instead of real images.
Do the following:
1. List all .png and .jpg files in /workspace/group/ using bash: ls /workspace/group/*.{png,jpg} 2>/dev/null
2. For each image found, inspect its filename and decide the best HTML section it belongs to (hero, podcast, services, footer).
3. In /workspace/group/index.html, replace the FIRST occurrence of <div class=\"placeholder-img\"> (the podcast image placeholder) with a proper <img> tag pointing to the most relevant image you found. Use a relative path (just the filename). Add alt text in Hebrew or English describing it.
4. In /workspace/group/index.html, replace the FIRST occurrence of <div class=\"placeholder-img small\"> (first service card) with a proper <img> tag pointing to the second most relevant image (or the same one if only one exists). Add CSS class \"service-img\" to the img.
5. Append a JSON mapping to /workspace/group/image-placement-report.json in the format: {\"placements\":[{\"file\":\"...\",\"section\":\"...\",\"reason\":\"...\"}]}
Print: PHOTO_PLACED when done."

if run_agent "t4_photo_uiux" "$T4_PROMPT"; then
  G="$(group_dir_for t4_photo_uiux)"

  if grep -qi '<img' "$G/index.html" 2>/dev/null; then
    pass "<img> tag(s) present in index.html after placement"
  else
    fail "<img> tag not found in index.html — photos not embedded"
  fi

  if grep -qi 'alt=' "$G/index.html" 2>/dev/null; then
    pass "alt attribute present on embedded images (accessibility)"
  else
    fail "No alt attribute found — images missing accessibility text"
  fi

  if grep -qi 'placeholder-img' "$G/index.html" 2>/dev/null; then
    REMAINING=$(grep -c 'placeholder-img' "$G/index.html" || true)
    ORIGINAL=$(grep -c 'placeholder-img' "$GROUP_DIR/index.html" || true)
    if [[ "$REMAINING" -lt "$ORIGINAL" ]]; then
      pass "At least one placeholder-img replaced ($((ORIGINAL - REMAINING)) of $ORIGINAL)"
    else
      fail "placeholder-img count unchanged — no images were placed"
    fi
  else
    pass "All placeholder-img divs replaced with real images"
  fi

  if [[ -f "$G/image-placement-report.json" ]] && [[ -s "$G/image-placement-report.json" ]]; then
    if python3 -c "import json,sys; d=json.load(open('$G/image-placement-report.json')); assert 'placements' in d" 2>/dev/null; then
      pass "image-placement-report.json valid JSON with 'placements' key"
    else
      fail "image-placement-report.json malformed or missing 'placements'"
    fi
  else
    fail "image-placement-report.json missing or empty"
  fi
else
  fail "T4 container exited with error/timeout"
  skip "<img> tag check"
  skip "alt attribute check"
  skip "placeholder replacement check"
  skip "placement report check"
fi


# ==============================================================
# TEST 5 — End-to-End: Redesign + Screenshot + Photo Validation
# ==============================================================
header "T5 · End-to-End: Redesign → Preview → Validate"
echo "  Full pipeline: redesign site, screenshot it, confirm photo placement is visible..."

T5_PROMPT="Full pipeline test — complete ALL steps without pausing:

STEP 1 — REDESIGN:
- Open /workspace/group/index.html
- Find all <div class=\"placeholder-img\"> elements and replace them with <img> elements using any .png/.jpg files found in /workspace/group/. Pick the most visually relevant file for each section.
- Save the modified index.html

STEP 2 — PREVIEW:
- Serve the updated site: cd /workspace/group && python3 -m http.server 9292 &>/tmp/srv5.log & echo \$! > /tmp/srv5.pid && sleep 2
- Screenshot: use agent-browser or puppeteer to capture http://localhost:9292 → /workspace/group/e2e_preview.png
  Fallback: curl -s http://localhost:9292/index.html -o /workspace/group/e2e_preview.html && echo FALLBACK > /workspace/group/e2e_preview.png
- kill \$(cat /tmp/srv5.pid) 2>/dev/null || true

STEP 3 — VALIDATION:
- Run: grep -o '<img[^>]*>' /workspace/group/index.html | wc -l > /workspace/group/img_count.txt
- Run: grep -o 'alt=\"[^\"]*\"' /workspace/group/index.html | head -5 >> /workspace/group/img_count.txt

STEP 4 — REPORT:
- Write /workspace/group/e2e_report.json: {\"img_count\": <number>, \"preview_file\": \"e2e_preview.png\", \"status\": \"complete\"}

Print: E2E_COMPLETE"

if run_agent "t5_e2e" "$T5_PROMPT"; then
  G="$(group_dir_for t5_e2e)"

  IMG_COUNT_BEFORE=$(grep -c 'placeholder-img' "$GROUP_DIR/index.html" 2>/dev/null || echo 0)
  IMG_TAGS_AFTER=$(grep -c '<img' "$G/index.html" 2>/dev/null || echo 0)

  if [[ "$IMG_TAGS_AFTER" -gt 0 ]]; then
    pass "index.html now contains $IMG_TAGS_AFTER <img> tag(s) (had $IMG_COUNT_BEFORE placeholders)"
  else
    fail "No <img> tags in index.html after E2E run"
  fi

  if [[ -f "$G/e2e_preview.png" ]] || [[ -f "$G/e2e_preview.html" ]]; then
    pass "Preview artifact created (png or html fallback)"
  else
    fail "e2e_preview.* not found"
  fi

  if [[ -f "$G/img_count.txt" ]] && [[ -s "$G/img_count.txt" ]]; then
    COUNTED=$(head -1 "$G/img_count.txt" | tr -dc '0-9')
    pass "img_count.txt written (agent counted $COUNTED <img> tags)"
  else
    fail "img_count.txt missing"
  fi

  if [[ -f "$G/e2e_report.json" ]]; then
    if python3 -c "import json,sys; d=json.load(open('$G/e2e_report.json')); assert d.get('status')=='complete'" 2>/dev/null; then
      pass "e2e_report.json valid with status=complete"
    else
      fail "e2e_report.json missing 'status: complete'"
    fi
  else
    fail "e2e_report.json not created"
  fi
else
  fail "T5 container exited with error/timeout"
  skip "<img> count check"
  skip "preview artifact check"
  skip "img_count.txt check"
  skip "e2e_report.json check"
fi


# ==============================================================
# Summary
# ==============================================================
TOTAL=$((PASS + FAIL + SKIP))
echo ""
echo -e "${C_BOLD}══════════════════════════════════════${C_RESET}"
echo -e "${C_BOLD}  Results: ${C_GREEN}${PASS} passed${C_RESET} · ${C_RED}${FAIL} failed${C_RESET} · ${C_YELLOW}${SKIP} skipped${C_RESET} / ${TOTAL} total"
echo -e "${C_BOLD}══════════════════════════════════════${C_RESET}"

if [[ "$FAIL" -eq 0 ]]; then
  echo -e "\n${C_GREEN}${C_BOLD}ALL TESTS PASSED${C_RESET}"
  exit 0
else
  echo -e "\n${C_RED}${C_BOLD}${FAIL} TEST(S) FAILED${C_RESET}"
  echo ""
  echo "Debug logs:"
  for f in "$TMPDIR_BASE"/*.err; do
    [[ -s "$f" ]] && echo "  $(basename "$f"):" && tail -5 "$f" && echo ""
  done
  exit 1
fi
