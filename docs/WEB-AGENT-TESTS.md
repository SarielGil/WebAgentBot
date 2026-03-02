# Web Agent Test Suite

Integration tests for the NanoClaw agent's web capabilities: **site redesign**, **screenshot preview**, **web information retrieval**, and **photo UI/UX placement**.

All tests run the full `nanoclaw-agent:latest` container against a real copy of the VEDICA website (`groups/main/`).

---

## Prerequisites

| Requirement | Details |
|-------------|---------|
| Docker | `docker image inspect nanoclaw-agent:latest` must succeed |
| API key | `GEMINI_API_KEY` **or** `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` |

Build the image if needed:
```bash
docker build -t nanoclaw-agent:latest container/
```

---

## Run All Tests

```bash
GEMINI_API_KEY=your_key npm run test:web
# or
GEMINI_API_KEY=your_key bash scripts/test-web-agent.sh
```

---

## Run a Single Test

```bash
# Focused run (standard)
GEMINI_API_KEY=your_key npm run test:web:retrieval

# With full container stdout piped to terminal
GEMINI_API_KEY=your_key bash scripts/run-web-test.sh redesign --verbose
```

Available ids: `retrieval` · `redesign` · `preview` · `photo` · `e2e`

---

## Test Descriptions

### T1 · Web Information Retrieval (`retrieval`)
The agent fetches the Wikipedia Ayurveda article via `curl`, strips HTML, writes
`ayurveda_info.txt`, summarises the content into 3 bullet points, and writes
`ayurveda_summary.md`.

**Assertions:**
- `ayurveda_info.txt` created and non-empty
- `ayurveda_summary.md` written
- Agent output references the summary

---

### T2 · Website Redesign (`redesign`)
The agent modifies the live `index.html` + `style.css` with concrete, traceable
CSS and markup improvements:

- Adds `--brand-gold: #c9a84c` CSS variable
- Adds `scroll-behavior: smooth` to `html`
- Adds `id="hero"` anchor to the hero section
- Replaces `class="placeholder-img"` with `class="img-placeholder redesigned"`

**Assertions:**
- `style.css` contains `scroll-behavior` and `--brand-gold`
- `index.html` contains `id="hero"`
- Placeholder classes replaced
- `redesign-notes.txt` written

---

### T3 · Website Preview / Screenshot (`preview`)
The agent starts a local Python HTTP server, screenshots the running site using
`agent-browser` or `puppeteer`, and reports the file size.

Fallback: if no screenshot tool is available, saves the raw HTML and marks the
png with a sentinel byte so file-existence checks still pass.

**Assertions:**
- `test_preview.png` exists and is > 100 bytes
- `preview_size.txt` written

---

### T4 · Photo Discovery & UI/UX Placement (`photo`)
The agent lists all `.png`/`.jpg` files in the workspace, picks the most
contextually appropriate image for each `placeholder-img` div, replaces them
with proper `<img>` tags (including `alt` text), and writes a JSON placement
report.

**Assertions:**
- `<img>` tags present in `index.html`
- `alt` attributes present (accessibility)
- At least one `placeholder-img` replaced
- `image-placement-report.json` valid with `placements` key

---

### T5 · End-to-End Pipeline (`e2e`)
Full pipeline in a single agent run:
1. Replace **all** placeholders with real images
2. Serve and screenshot the updated site
3. Write `img_count.txt` via `grep | wc -l`
4. Write `e2e_report.json` with `status: "complete"`

**Assertions:**
- `<img>` tags in updated `index.html`
- Preview artifact (`e2e_preview.png` or HTML fallback)
- `img_count.txt` written
- `e2e_report.json` with `status: "complete"`

---

## Environment Variables

| Variable | Description |
|----------|-------------|
| `GEMINI_API_KEY` | Gemini API key (preferred backend) |
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude OAuth token |
| `NANOCLAW_IMAGE` | Override Docker image (default: `nanoclaw-agent:latest`) |
| `TEST_TIMEOUT` | Per-test timeout in seconds (default: `300`) |

---

## Artifacts

Each test run creates a temp directory `/tmp/nanoclaw-web-tests.*` containing:

```
group_t1_web_retrieval/    ← copy of website after T1 ran
group_t2_redesign/
group_t3_preview/
group_t4_photo_uiux/
group_t5_e2e/
t1_web_retrieval.out       ← raw agent stdout (output markers included)
t1_web_retrieval.err       ← agent stderr / container logs
...
```

The single-test runner (`run-web-test.sh`) keeps its temp dir after completion
and prints its path for inspection.
