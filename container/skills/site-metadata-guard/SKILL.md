---
name: site-metadata-guard
description: Generate and maintain site metadata files from actual website content and routes. Use when building, redesigning, or deploying websites to ensure sitemap.xml, robots.txt, and llms.txt reflect the real pages and page content.
---

# Site Metadata Guard

Keep metadata files synchronized with the current website before deploy.

## Required Outputs

- `sitemap.xml`: include every public HTML page URL.
- `robots.txt`: allow crawl and point to sitemap URL.
- `llms.txt`: concise AI-readable summary of the site using real title/description/pages/topics.

## Workflow

1. Enumerate public pages from the deploy root (all `.html` files that are not hidden/system files).
2. Build canonical URLs from the final public base URL.
3. Regenerate metadata files from current pages and visible content.
4. Overwrite stale metadata files rather than appending.
5. Validate consistency:
   - every sitemap URL exists in the deploy set
   - `robots.txt` references the correct sitemap URL
   - `llms.txt` includes the canonical URL and key pages/topics

## Guardrails

- Do not invent routes not present in the deploy output.
- Do not leave placeholder text in metadata files.
- Prefer deterministic generation from files over free-form prose.
