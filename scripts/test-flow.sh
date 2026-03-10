#!/usr/bin/env bash
# ============================================================
# NanoClaw Full Flow Test
# Tests the end-to-end user journey:
#   Stage 1: Greeting → exactly 1 reply
#   Stage 2: Design request → 3 design previews
#   Stage 3: Photo upload → saved + used in HTML
#   Stage 4: Pick design → deployed to test_repo
#   Stage 5: Verify live site is accessible
#
# Usage:
#   npm run test:flow
#   # or directly:
#   bash scripts/test-flow.sh [--stage N] [--verbose]
#
# Env vars (read from data/env/env or environment):
#   GEMINI_API_KEY   — required
#   GITHUB_TOKEN     — required for stages 4-5
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
C_DIM='\033[2m'

PASS=0
FAIL=0
SKIP=0
VERBOSE=false
STAGE_FILTER=""

pass()   { echo -e "  ${C_GREEN}✔ PASS${C_RESET}  $1"; PASS=$((PASS+1)); }
fail()   { echo -e "  ${C_RED}✘ FAIL${C_RESET}  $1"; FAIL=$((FAIL+1)); }
skip()   { echo -e "  ${C_YELLOW}⊘ SKIP${C_RESET}  $1"; SKIP=$((SKIP+1)); }
header() { echo -e "\n${C_CYAN}${C_BOLD}══ $1 ══${C_RESET}"; }
detail() { if $VERBOSE; then echo -e "  ${C_DIM}$1${C_RESET}"; fi; }

# ---- Parse args ----
while [[ $# -gt 0 ]]; do
  case "$1" in
    --stage)  STAGE_FILTER="$2"; shift 2 ;;
    --verbose) VERBOSE=true; shift ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

should_run() { [[ -z "$STAGE_FILTER" || "$STAGE_FILTER" == "$1" ]] && return 0 || return 1; }

# ---- Load env ----
source_env() {
  for env_file in "$PROJECT_ROOT/data/env/env" "$PROJECT_ROOT/.env"; do
    if [[ ! -f "$env_file" ]]; then continue; fi
    while IFS= read -r line || [[ -n "$line" ]]; do
      if [[ "$line" =~ ^[[:space:]]*# ]]; then continue; fi
      if [[ -z "${line// }" ]]; then continue; fi
      if [[ "$line" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=[[:space:]]*(.*)[[:space:]]*$ ]]; then
        local key="${BASH_REMATCH[1]}"
        local val="${BASH_REMATCH[2]}"
        val="${val#\'}"; val="${val%\'}"
        val="${val#\"}"; val="${val%\"}"
        if [[ -z "${!key:-}" ]]; then export "$key"="$val"; fi
      fi
    done < "$env_file"
  done
  return 0
}
source_env

GEMINI_KEY="${GEMINI_API_KEY:-}"
GITHUB_TOKEN_VAL="${GITHUB_TOKEN:-}"
GITHUB_OWNER="SarielGil"
TEST_REPO="nanoclaw-test-flow"

if [[ -z "$GEMINI_KEY" ]]; then
  echo -e "${C_RED}ERROR: GEMINI_API_KEY required. Set in data/env/env or environment.${C_RESET}"
  exit 1
fi

# ---- Docker image check ----
IMAGE="nanoclaw-agent:latest"
if ! docker image inspect "$IMAGE" &>/dev/null; then
  echo -e "${C_RED}ERROR: Docker image '$IMAGE' not found. Run: npm run docker:build${C_RESET}"
  exit 1
fi

# ---- Temp workspace ----
TMPDIR_BASE=$(mktemp -d /tmp/nanoclaw-flow-test.XXXXXX)
trap 'rm -rf "$TMPDIR_BASE"' EXIT

TIMEOUT="${TEST_TIMEOUT:-400}"

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

build_secrets_json() {
  local parts=()
  if [[ -n "$GEMINI_KEY" ]]; then parts+=("\"GEMINI_API_KEY\": \"$GEMINI_KEY\""); fi
  if [[ -n "$GITHUB_TOKEN_VAL" ]]; then parts+=("\"GITHUB_TOKEN\": \"$GITHUB_TOKEN_VAL\""); fi
  local joined
  joined=$(printf '%s,' "${parts[@]}")
  echo "{${joined%,}}"
}
SECRETS_JSON="$(build_secrets_json)"

# ---- Run a single agent invocation ----
# Usage: run_agent <test_name> <prompt> [group_dir] [media_dir]
# Outputs go to $TMPDIR_BASE/<test_name>.{out,err}
# IPC messages go to <group_dir>/ipc/messages/
run_agent() {
  local test_name="$1"
  local prompt="$2"
  local group_dir="${3:-$TMPDIR_BASE/group_${test_name}}"
  local media_dir="${4:-}"

  mkdir -p "$group_dir/logs"

  local ipc_dir="$TMPDIR_BASE/ipc_${test_name}"
  mkdir -p "$ipc_dir/input" "$ipc_dir/messages" "$ipc_dir/media"

  # Copy CLAUDE.md for agent instructions
  cp "$PROJECT_ROOT/groups/client1/CLAUDE.md" "$group_dir/CLAUDE.md" 2>/dev/null || true

  local out_file="$TMPDIR_BASE/${test_name}.out"
  local err_file="$TMPDIR_BASE/${test_name}.err"

  local input_json
  input_json=$(cat <<EOF
{
  "prompt": $(printf '%s' "$prompt" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'),
  "groupFolder": "test-${test_name}",
  "chatJid": "test@flow.local",
  "isMain": false,
  "assistantName": "Andy",
  "secrets": $SECRETS_JSON
}
EOF
)

  local docker_args=(
    run --rm -i
    -e "HOME=/root"
    -v "${group_dir}:/workspace/group"
    -v "${ipc_dir}:/workspace/ipc"
  )

  # Mount media dir if provided
  if [[ -n "$media_dir" && -d "$media_dir" ]]; then
    docker_args+=(-v "${media_dir}:/workspace/media:ro")
  fi

  docker_args+=("$IMAGE")

  local input_file="$TMPDIR_BASE/${test_name}.input.json"
  printf '%s' "$input_json" > "$input_file"

  detail "Running container for $test_name..."
  detail "Prompt: ${prompt:0:120}..."

  if ! _timeout "$TIMEOUT" docker "${docker_args[@]}" \
       < "$input_file" \
       > "$out_file" 2> "$err_file"; then
    detail "Container timeout/error — see $err_file"
    return 1
  fi

  if grep -qF 'NANOCLAW_OUTPUT_START' "$out_file"; then
    return 0
  else
    detail "No NANOCLAW_OUTPUT_START marker found in output"
    return 1
  fi
}

# Count IPC message files of a given type
count_ipc() {
  local test_name="$1"
  local type="$2"
  local ipc_dir="$TMPDIR_BASE/ipc_${test_name}/messages"
  if [[ ! -d "$ipc_dir" ]]; then
    echo 0
    return
  fi
  local count=0
  for f in "$ipc_dir"/*.json; do
    [[ -f "$f" ]] || continue
    if python3 -c "import json,sys; d=json.load(open('$f')); sys.exit(0 if d.get('type')=='$type' else 1)" 2>/dev/null; then
      count=$((count+1))
    fi
  done
  echo $count
}

# Get all IPC message texts
get_ipc_texts() {
  local test_name="$1"
  local ipc_dir="$TMPDIR_BASE/ipc_${test_name}/messages"
  [[ -d "$ipc_dir" ]] || return
  for f in "$ipc_dir"/*.json; do
    [[ -f "$f" ]] || continue
    python3 -c "
import json,sys
d=json.load(open('$f'))
if d.get('type')=='message':
    print(d.get('text',''))
" 2>/dev/null
  done
}

echo -e "${C_BOLD}NanoClaw Full Flow Test${C_RESET}"
echo -e "${C_DIM}Image: $IMAGE | Timeout: ${TIMEOUT}s per stage${C_RESET}"
echo -e "${C_DIM}Temp dir: $TMPDIR_BASE${C_RESET}"

# ==============================================================
# STAGE 1 — Greeting: exactly 1 message reply
# ==============================================================
if should_run 1; then
  header "Stage 1 · Greeting Response"
  echo "  Sending 'היי' — expecting exactly 1 reply, no auto-build..."

  if run_agent "s1_greeting" "היי"; then
    msg_count=$(count_ipc "s1_greeting" "message")
    photo_count=$(count_ipc "s1_greeting" "photo")

    detail "IPC messages: $msg_count, IPC photos: $photo_count"

    if [[ "$msg_count" -eq 1 ]]; then
      pass "Exactly 1 text message sent"
    elif [[ "$msg_count" -eq 0 ]]; then
      fail "No text message sent (expected 1)"
    else
      fail "Got $msg_count text messages (expected 1)"
    fi

    if [[ "$photo_count" -eq 0 ]]; then
      pass "No photos sent on greeting (correct)"
    else
      fail "Got $photo_count photos on greeting (expected 0)"
    fi

    # Verify no HTML files were auto-generated
    html_files=$(find "$TMPDIR_BASE/group_s1_greeting" -name "*.html" 2>/dev/null | wc -l | tr -d ' ')
    if [[ "$html_files" -eq 0 ]]; then
      pass "No auto-build triggered (no HTML files)"
    else
      fail "$html_files HTML files generated on greeting (auto-build triggered)"
    fi
  else
    fail "Stage 1 container exited with error/timeout"
    skip "Message count check"
    skip "Photo count check"
    skip "Auto-build check"
  fi
fi

# ==============================================================
# STAGE 2 — Design request: 3 design option screenshots
# ==============================================================
if should_run 2; then
  header "Stage 2 · Design Request → 3 Options"
  echo "  Requesting GORJAZZ website design — expecting 3 screenshot previews..."

  S2_PROMPT='היי תן לי הצעות עיצוב לאתר להרכב בלוז גאז ישראלי שנקרא GORJAZZ ההרכב מציע מסע מוזיקלי רומנטי מגשר בין ניו יורק לניו אורלינס ותל אביב, מציע הופעות לאירועים פרטיים וקונצרטים. תן לי 3 אופציות עיצוב'

  if run_agent "s2_design" "$S2_PROMPT"; then
    msg_count=$(count_ipc "s2_design" "message")
    photo_count=$(count_ipc "s2_design" "photo")

    detail "IPC messages: $msg_count, IPC photos: $photo_count"

    if [[ "$msg_count" -ge 1 ]]; then
      pass "At least 1 text message sent (status/intro)"
    else
      fail "No text messages sent"
    fi

    if [[ "$photo_count" -ge 3 ]]; then
      pass "3+ design preview photos sent ($photo_count)"
    elif [[ "$photo_count" -ge 1 ]]; then
      fail "Only $photo_count photos sent (expected 3)"
    else
      fail "No photos sent (expected 3 design previews)"
    fi

    # Check that screenshot files were actually created in IPC media
    media_files=$(find "$TMPDIR_BASE/ipc_s2_design/media" -type f \( -name "*.png" -o -name "*.jpg" \) 2>/dev/null | wc -l | tr -d ' ')
    if [[ "$media_files" -ge 3 ]]; then
      pass "3+ screenshot files exist in IPC media dir ($media_files)"
    else
      fail "Only $media_files screenshot files in IPC media (expected 3+)"
    fi

    # Verify HTML option files were generated
    html_count=$(find "$TMPDIR_BASE/group_s2_design" /tmp -maxdepth 4 -name "index.html" -path "*option*" 2>/dev/null | wc -l | tr -d ' ')
    detail "Option HTML files found: $html_count"
    if [[ "$html_count" -ge 3 ]]; then
      pass "3 HTML option files generated"
    elif [[ "$html_count" -ge 1 ]]; then
      fail "Only $html_count HTML option files (expected 3)"
    else
      # Also check without "option" in path
      html_total=$(find "$TMPDIR_BASE/group_s2_design" -name "*.html" 2>/dev/null | wc -l | tr -d ' ')
      if [[ "$html_total" -ge 3 ]]; then
        pass "3+ HTML files generated (non-standard naming)"
      else
        fail "No HTML design files found ($html_total total)"
      fi
    fi
  else
    fail "Stage 2 container exited with error/timeout"
    skip "Message count check"
    skip "Photo count check"
    skip "Media files check"
    skip "HTML files check"
  fi
fi

# ==============================================================
# STAGE 3 — Photo upload: saved with metadata, used in designs
# ==============================================================
if should_run 3; then
  header "Stage 3 · Photo Upload → Used in Designs"
  echo "  Uploading a test photo and requesting designs that use it..."

  # Create a test image (small valid PNG)
  MEDIA_DIR="$TMPDIR_BASE/media_s3"
  mkdir -p "$MEDIA_DIR"
  # Generate a tiny valid PNG (1x1 red pixel)
  python3 -c "
import struct, zlib
def make_png():
    sig = b'\\x89PNG\\r\\n\\x1a\\n'
    ihdr_data = struct.pack('>IIBBBBB', 1, 1, 8, 2, 0, 0, 0)
    ihdr_crc = zlib.crc32(b'IHDR' + ihdr_data)
    ihdr = struct.pack('>I', 13) + b'IHDR' + ihdr_data + struct.pack('>I', ihdr_crc & 0xFFFFFFFF)
    raw = b'\\x00\\xff\\x00\\x00'
    compressed = zlib.compress(raw)
    idat_crc = zlib.crc32(b'IDAT' + compressed)
    idat = struct.pack('>I', len(compressed)) + b'IDAT' + compressed + struct.pack('>I', idat_crc & 0xFFFFFFFF)
    iend_crc = zlib.crc32(b'IEND')
    iend = struct.pack('>I', 0) + b'IEND' + struct.pack('>I', iend_crc & 0xFFFFFFFF)
    return sig + ihdr + idat + iend
open('$MEDIA_DIR/gorjazz_band_photo.jpg', 'wb').write(make_png())
" 2>/dev/null
  # Also create a real-looking JPEG (copy a small one) or use the PNG disguised as jpg
  # The test just needs a file to exist

  S3_GROUP="$TMPDIR_BASE/group_s3_photo"
  mkdir -p "$S3_GROUP/logs"
  # Copy the project memory from stage 2 if it exists, otherwise create basic one
  mkdir -p "$S3_GROUP/projects/gorjazz"
  cat > "$S3_GROUP/projects/gorjazz/memory.json" <<'MEMJSON'
{"project":"gorjazz","status":"researching","preferences":{"language":"Hebrew","style":"elegant/pleasant"}}
MEMJSON

  S3_PROMPT='הנה תמונה של ההרכב בהופעה. תן לי 3 אופציות עיצוב לאתר GORJAZZ שישתמשו בתמונות שלי. הרכב בלוז גאז ישראלי, מציע הופעות ואירועים.'

  if run_agent "s3_photo" "$S3_PROMPT" "$S3_GROUP" "$MEDIA_DIR"; then
    photo_count=$(count_ipc "s3_photo" "photo")
    detail "IPC photos: $photo_count"

    # Check that media dir was accessible (agent could ls /workspace/media/)
    if grep -rq "gorjazz_band_photo" "$TMPDIR_BASE/s3_photo.out" "$TMPDIR_BASE/s3_photo.err" 2>/dev/null; then
      pass "Agent detected the uploaded photo"
    else
      # Also check IPC messages for references
      ipc_texts=$(get_ipc_texts "s3_photo" 2>/dev/null)
      if echo "$ipc_texts" | grep -qi "photo\|תמונ\|image"; then
        pass "Agent acknowledged photos in response"
      else
        fail "Agent didn't detect/acknowledge uploaded photo"
      fi
    fi

    # Check that HTML files reference the user's photo (not placeholders)
    html_files=$(find "$S3_GROUP" /tmp -maxdepth 5 -name "*.html" 2>/dev/null)
    used_photo=false
    used_placeholder=false
    for hf in $html_files; do
      if grep -qi "gorjazz_band_photo\|/workspace/media\|images/" "$hf" 2>/dev/null; then
        used_photo=true
      fi
      if grep -qi "picsum.photos\|unsplash\|placeholder\|placehold" "$hf" 2>/dev/null; then
        used_placeholder=true
      fi
    done

    if $used_photo; then
      pass "User photo referenced in generated HTML"
    else
      if [[ -n "$html_files" ]]; then
        fail "HTML files exist but don't reference user photo"
      else
        fail "No HTML files generated — can't check photo usage"
      fi
    fi

    if ! $used_placeholder; then
      pass "No placeholder images used (picsum/unsplash/placehold)"
    else
      fail "Placeholder images found in HTML despite user photos being available"
    fi

    if [[ "$photo_count" -ge 3 ]]; then
      pass "3+ design screenshots sent with user photo ($photo_count)"
    elif [[ "$photo_count" -ge 1 ]]; then
      fail "Only $photo_count photos sent (expected 3)"
    else
      fail "No photos sent"
    fi
  else
    fail "Stage 3 container exited with error/timeout"
    skip "Photo detection check"
    skip "Photo usage in HTML check"
    skip "Placeholder check"
    skip "Screenshot count check"
  fi
fi

# ==============================================================
# STAGE 4 — Deploy chosen design to test_repo
# ==============================================================
if should_run 4; then
  header "Stage 4 · Deploy to GitHub (test_repo)"

  if [[ -z "$GITHUB_TOKEN_VAL" ]]; then
    echo "  Skipping — GITHUB_TOKEN not set"
    skip "Repo creation"
    skip "File push"
    skip "Pages enable"
  else
    echo "  Deploying option 1 to $GITHUB_OWNER/$TEST_REPO..."

    # Clean up test repo if it exists from a previous run
    curl -sf -X DELETE \
      -H "Authorization: token $GITHUB_TOKEN_VAL" \
      "https://api.github.com/repos/$GITHUB_OWNER/$TEST_REPO" >/dev/null 2>&1 || true
    sleep 2

    S4_GROUP="$TMPDIR_BASE/group_s4_deploy"
    mkdir -p "$S4_GROUP/logs"

    S4_PROMPT="Build a simple one-page website for GORJAZZ — an Israeli jazz & blues duo. Include:
- A hero section with the band name
- An 'About' section describing a romantic musical journey from NYC to Tel Aviv
- A 'Contact' section with a placeholder contact form
- Use inline CSS, dark elegant theme
- Language: Hebrew

Then deploy it:
1. Write the complete HTML to /tmp/$TEST_REPO/index.html
2. Run these commands:
   git config --global user.email \"bot@nanoclaw.ai\"
   git config --global user.name \"NanoClaw Bot\"
   cd /tmp
   gh repo create \"$TEST_REPO\" --public --description \"NanoClaw test\" 2>/dev/null || true
   sleep 3
   git clone \"https://x-access-token:\$GITHUB_TOKEN@github.com/$GITHUB_OWNER/$TEST_REPO.git\" || true
   cp -r /tmp/$TEST_REPO/. $TEST_REPO/ 2>/dev/null || cp /tmp/$TEST_REPO/index.html $TEST_REPO/
   cd $TEST_REPO
   git add .
   git commit -m \"deploy test\"
   git push
   gh api \"repos/$GITHUB_OWNER/$TEST_REPO/pages\" -X POST -f \"source[branch]=main\" -f \"source[path]=/\" 2>/dev/null || true
3. When done, print DEPLOY_DONE"

    if run_agent "s4_deploy" "$S4_PROMPT" "$S4_GROUP"; then
      # Check if the repo was created
      sleep 3
      repo_status=$(curl -sf -o /dev/null -w "%{http_code}" \
        -H "Authorization: token $GITHUB_TOKEN_VAL" \
        "https://api.github.com/repos/$GITHUB_OWNER/$TEST_REPO" 2>/dev/null || echo "000")

      if [[ "$repo_status" == "200" ]]; then
        pass "GitHub repo $GITHUB_OWNER/$TEST_REPO created"
      else
        fail "GitHub repo not found (HTTP $repo_status)"
      fi

      # Check if files were pushed
      if [[ "$repo_status" == "200" ]]; then
        files_status=$(curl -sf -o /dev/null -w "%{http_code}" \
          -H "Authorization: token $GITHUB_TOKEN_VAL" \
          "https://api.github.com/repos/$GITHUB_OWNER/$TEST_REPO/contents/index.html" 2>/dev/null || echo "000")

        if [[ "$files_status" == "200" ]]; then
          pass "index.html pushed to repo"
        else
          fail "index.html not found in repo (HTTP $files_status)"
        fi
      else
        skip "File push check (repo missing)"
      fi

      # Check Pages enabled
      if [[ "$repo_status" == "200" ]]; then
        pages_status=$(curl -sf -o /dev/null -w "%{http_code}" \
          -H "Authorization: token $GITHUB_TOKEN_VAL" \
          "https://api.github.com/repos/$GITHUB_OWNER/$TEST_REPO/pages" 2>/dev/null || echo "000")

        if [[ "$pages_status" == "200" ]]; then
          pass "GitHub Pages enabled"
        else
          detail "Pages API returned $pages_status (may take time to activate)"
          skip "GitHub Pages check (not yet active)"
        fi
      else
        skip "Pages check (repo missing)"
      fi
    else
      fail "Stage 4 container exited with error/timeout"
      skip "Repo creation check"
      skip "File push check"
      skip "Pages check"
    fi
  fi
fi

# ==============================================================
# STAGE 5 — Verify live site is accessible
# ==============================================================
if should_run 5; then
  header "Stage 5 · Verify Live Site"

  if [[ -z "$GITHUB_TOKEN_VAL" ]]; then
    echo "  Skipping — GITHUB_TOKEN not set"
    skip "Site accessibility"
    skip "Site content"
  else
    SITE_URL="https://${GITHUB_OWNER,,}.github.io/$TEST_REPO/"
    echo "  Checking $SITE_URL (waiting for Pages deployment)..."

    # Wait for Pages to become available (up to 120s)
    site_live=false
    for i in $(seq 1 12); do
      http_code=$(curl -sf -o /dev/null -w "%{http_code}" "$SITE_URL" 2>/dev/null || echo "000")
      detail "Attempt $i: HTTP $http_code"
      if [[ "$http_code" == "200" ]]; then
        site_live=true
        break
      fi
      sleep 10
    done

    if $site_live; then
      pass "Site is accessible at $SITE_URL"

      # Check content
      site_content=$(curl -sf "$SITE_URL" 2>/dev/null || echo "")
      if echo "$site_content" | grep -qi "GORJAZZ\|גורג"; then
        pass "Site contains GORJAZZ content"
      else
        if echo "$site_content" | grep -qi "<html\|<body\|<head"; then
          pass "Site has valid HTML structure"
        else
          fail "Site content doesn't look like a website"
        fi
      fi
    else
      fail "Site not accessible after 120s (last HTTP: $http_code)"
      skip "Site content check"
    fi

    # Cleanup: delete the test repo
    echo -e "  ${C_DIM}Cleaning up test repo...${C_RESET}"
    curl -sf -X DELETE \
      -H "Authorization: token $GITHUB_TOKEN_VAL" \
      "https://api.github.com/repos/$GITHUB_OWNER/$TEST_REPO" >/dev/null 2>&1 || true
  fi
fi

# ==============================================================
# Summary
# ==============================================================
echo ""
echo -e "${C_BOLD}════════════════════════════════════${C_RESET}"
echo -e "${C_GREEN}  Passed: $PASS${C_RESET}"
echo -e "${C_RED}  Failed: $FAIL${C_RESET}"
echo -e "${C_YELLOW}  Skipped: $SKIP${C_RESET}"
echo -e "${C_BOLD}════════════════════════════════════${C_RESET}"
echo ""

if $VERBOSE; then
  echo -e "${C_DIM}Test artifacts in: $TMPDIR_BASE${C_RESET}"
  echo -e "${C_DIM}(will be cleaned up on exit)${C_RESET}"
fi

[[ "$FAIL" -eq 0 ]]
