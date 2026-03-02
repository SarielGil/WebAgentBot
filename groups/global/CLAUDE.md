# Shared Capabilities

This file is automatically included for all non-main bots. It defines shared tools and formatting rules.

## Available Tools

- **Browse the web** with `agent-browser` — open pages, click, fill forms, take screenshots, extract data
  - `agent-browser open <url>` → then `agent-browser snapshot -i` to see interactive elements
- **Web search** — use Brave Search API for live search results
- **Bash** — run shell commands. `$GITHUB_TOKEN`, `$GH_TOKEN`, and `$BRAVE_API_KEY` are available in the environment
- **Files** — read, write, edit files in `/workspace/group/`
- **Schedule** — schedule tasks to run later or on a recurring basis
- **Send messages** — use `mcp__nanoclaw__send_message` to send an immediate reply while still working (useful to acknowledge before long tasks)
- **Photos** — user photos arrive at `/workspace/media/<filename>`

## GitHub & Deployment

GitHub CLI (`gh`) and `git` are available. `$GITHUB_TOKEN` / `$GH_TOKEN` are pre-set.

To create a repo and deploy via GitHub Pages:
```
# 1. Create repo
gh repo create REPO_NAME --public --description "DESC"

# 2. Clone, add files, push
cd /tmp
git config --global user.email "bot@nanoclaw.ai"
git config --global user.name "NanoClaw Bot"
git clone https://x-access-token:$GITHUB_TOKEN@github.com/SarielGil/REPO_NAME.git
cd REPO_NAME
# copy site files here
git add . && git commit -m "deploy" && git push

# 3. Enable GitHub Pages
sleep 2
gh api repos/SarielGil/REPO_NAME/pages -X POST -f "source[branch]=main" -f "source[path]=/"
```
Live URL is always: `https://sarielgil.github.io/REPO_NAME` (takes ~1 min). Never make up a URL.

## Communication Style

Use `mcp__nanoclaw__send_message` to acknowledge long tasks before starting them.

Wrap internal reasoning in `<internal>` tags — this is logged but NOT sent to the user:
```
<internal>Checking project status before replying...</internal>
Here's what I found...
```

When working as a sub-agent, only use `send_message` if instructed by the main agent.

## Message Formatting

NEVER use markdown. Only WhatsApp/Telegram formatting:
- *bold* with single asterisks (NEVER **double**)
- _italic_ with underscores
- • bullet points
- ```code blocks``` with triple backticks

No ## headings. No [links](url). No **double stars**.

## Workspace & Memory

Files persist in `/workspace/group/`. The `conversations/` folder has searchable history from past sessions — check it for context before asking the user to repeat themselves.

When learning something important:
- Save structured data as files (`customers.md`, `projects/NAME/README.md`, etc.)
- Split files over 500 lines into sub-folders
- Keep an index of what you've stored
