# Deploying Wahba Markets to Netlify

The zip contains the whole project, already wired for Netlify (`netlify.toml` + `netlify/functions/api.mjs`).

## What works where

| Feature | Local (`node server.js`) | Netlify |
|---|---|---|
| Live prices, charts, 1-second updates | ✅ | ✅ (5-second tick, to respect function quotas) |
| S&P 500 browser (all 503 stocks) | ✅ | ✅ |
| Compare 2 stocks | ✅ | ✅ |
| News tape | ✅ | ✅ |
| AI Studio chat | ✅ | ✅ (needs `ANTHROPIC_API_KEY` env var) |
| 5-agent desk cycle + live monitor loop | ✅ | ❌ (multi-minute SSE loop — runs locally only) |

## Recommended: deploy with functions (full features)

Netlify's drag-and-drop does **not** build serverless functions, so use one of these:

**Option A — Netlify CLI (fastest):**
```bash
npm install -g netlify-cli
cd wahba-markets          # the unzipped folder
netlify login
netlify deploy --prod     # accept defaults; publish dir is read from netlify.toml
```

**Option B — GitHub:**
1. Push the unzipped folder to a GitHub repo.
2. Netlify → *Add new site → Import an existing project* → pick the repo.
3. Build settings are read from `netlify.toml` automatically. Deploy.

**Then set the AI key:** Site settings → *Environment variables* → add `ANTHROPIC_API_KEY` = your key → redeploy. AI Studio chat now works on the live site.

## Drag-and-drop (static only)

If you just drag the `public/` folder onto https://app.netlify.com/drop you get the UI and the S&P 500 list, but market data and AI will not work (they need the serverless function). Use Option A or B instead.

## Cost / quota notes

- The live tick runs every 5 s per open browser tab on Netlify (each tick is a function invocation). Free tier includes 125k invocations/month.
- AI Studio uses Claude Opus 4.8 — each chat reply costs real API credits on your Anthropic account.
