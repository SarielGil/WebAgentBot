---
name: render-local-html
description: Render a local HTML file or local site folder, capture one or more screenshots, and send them to the user as photos. Use this for website previews before deployment or when the user asks to see how local HTML looks.
allowed-tools: Bash(agent-browser:*)
---

# Render Local HTML and Send Preview Photos

Use this skill when a user wants to preview a local HTML page, a generated static site, or a redesign before deployment.

## What this skill does

1. Opens a local HTML page in the browser
2. Waits for the page to finish rendering
3. Captures a screenshot into `/tmp/`
4. Sends the screenshot back to the user as a photo

## Choose the right preview mode

### Mode A — Direct file preview

Use this when the page is plain static HTML/CSS/JS and assets are referenced relatively.

```bash
agent-browser open file:///absolute/path/to/index.html
agent-browser wait --load networkidle
agent-browser screenshot /tmp/page-preview.png --full
```

Then send the image with `mcp__nanoclaw__send_photo`.

Best for:
- single `index.html` files
- static mockups in `/tmp/`
- local HTML previews with relative CSS/images

### Mode B — Local HTTP server preview

Use this when the page relies on module loading, `fetch()`, local JSON, or other browser behavior that breaks under `file://`.

```bash
cd /path/to/site-folder
python3 -m http.server 8080 &
SERVER_PID=$!
sleep 1
agent-browser open http://127.0.0.1:8080
agent-browser wait --load networkidle
agent-browser screenshot /tmp/page-preview.png --full
kill $SERVER_PID 2>/dev/null || true
```

If the page entry file is not `index.html`, open the specific route instead.

## Screenshot rules

- Always save screenshots to `/tmp/`, not `/workspace/media/`
- Prefer full-page screenshots for landing pages: `agent-browser screenshot /tmp/name.png --full`
- If the user only needs the hero/above-the-fold, a normal screenshot is fine
- Use clear filenames, e.g.:
  - `/tmp/home-preview.png`
  - `/tmp/about-preview.png`
  - `/tmp/option-2-preview.png`

## Sending the preview

After capturing the screenshot, send it with `mcp__nanoclaw__send_photo`.

Suggested caption patterns:
- `<Project Name> — local preview`
- `<Project Name> — homepage draft`
- `<Project Name> — redesign option 2`

## Recommended workflow

### Preview one page

```bash
agent-browser open file:///tmp/my-site/index.html
agent-browser wait --load networkidle
agent-browser screenshot /tmp/my-site-preview.png --full
```

Then send `/tmp/my-site-preview.png` to the user.

### Preview a generated site folder

```bash
cd /tmp/my-site
python3 -m http.server 8080 &
SERVER_PID=$!
sleep 1
agent-browser open http://127.0.0.1:8080
agent-browser wait --load networkidle
agent-browser screenshot /tmp/my-site-home.png --full
kill $SERVER_PID 2>/dev/null || true
```

### Preview multiple pages

```bash
cd /tmp/my-site
python3 -m http.server 8080 &
SERVER_PID=$!
sleep 1

agent-browser open http://127.0.0.1:8080
agent-browser wait --load networkidle
agent-browser screenshot /tmp/home.png --full

agent-browser open http://127.0.0.1:8080/about.html
agent-browser wait --load networkidle
agent-browser screenshot /tmp/about.png --full

kill $SERVER_PID 2>/dev/null || true
```

Then send one or both screenshots.

## Troubleshooting

### CSS or images are missing
- Check relative paths first
- If using `file://`, retry with a local HTTP server

### The screenshot is blank or incomplete
- Wait a bit longer: `agent-browser wait 1500`
- Then take the screenshot again

### Dynamic content does not appear
- Use local server mode instead of `file://`
- Wait for network idle or specific text before screenshoting

### Need a mobile-ish preview
- Capture just the top section if a full mobile emulation is not needed
- If available in the page itself, use responsive CSS and inspect the result visually before sending

## Important notes

- Do not deploy just to preview a page
- Prefer local preview first for faster iteration
- Use this skill when the user says things like:
  - “show me the page”
  - “render the HTML”
  - “send a screenshot”
  - “preview this locally”
  - “how does the page look?”