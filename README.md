# Wahba Markets — AI Trading Desk

A multi-agent stock analysis platform inspired by AmplifyME's Finance Accelerator news desk — but running on **real stocks, real prices, and real news**.

## The agent loop

Five Claude agents (model: `claude-opus-4-8`) work in a supervised loop. Each agent receives the previous agents' output and must end with **handoff questions** for the next agent — that's how they keep prompting each other. The **Desk Manager** validates every output and re-prompts an agent with feedback when the work isn't grounded in evidence.

| # | Agent | Job |
|---|-------|-----|
| 1 | **News & Evidence Researcher** | Web-search agent. Verifies real, current facts: earnings, valuation multiples, market-moving news (each tagged BUY / SELL / WAIT), upcoming catalysts, closest competitors. Everything sourced and dated. |
| 2 | **Equity Analyst** | The deep dive: business model, financials (growth, margins, debt, cash flow), forward outlook, valuation vs its own history, catalysts and risks for 6–18 months, score 1–10. |
| 3 | **Reality Check** | Compares the stock to its 3–4 closest competitors on growth, margins, and valuation multiples. Cheap / fair / expensive — value opportunity or value trap. |
| 4 | **Devil's Advocate** | Argues the bear case as hard as possible and gives a specific **invalidation level**: the exact price or condition where the thesis breaks and you should exit. |
| M | **Desk Manager** | Validates every agent's output (rejects + re-prompts with feedback when needed), then weighs bull vs bear and issues the final trade card: BUY / HOLD / SELL / AVOID with entry, target, invalidation, conviction, evidence, and risks. |

## The news loop (AmplifyME-style)

Turn on **Live monitor** and the desk polls real prices and the real news feed every 60 seconds. Fresh headlines are triaged by the Manager (material / not material). With **Auto re-run** enabled, material news automatically triggers a full new analysis cycle (10-minute cooldown so it can't run away with your tokens).

## More features

- **AI Studio** (right column tab) — chat with the AI about any stock; the live price, stats, and headlines of your selected ticker(s) are attached to every message as real context.
- **S&P 500 browser** (☰ button) — all 503 constituents, filterable by name/ticker/sector; click any row to load it, or `+cmp` to add it to a comparison.
- **Compare** (⇄ button) — any two stocks side by side: normalized 1-year performance chart plus a full metric table with winners highlighted, and an "Ask AI to compare" hand-off into AI Studio.
- **Live chart** — the 1D chart polls a real quote every second (server-side cached so the upstream is never hammered); 1Y view is one click away.

## Deploying to Netlify

See [DEPLOY.md](DEPLOY.md) — the project ships with `netlify.toml` and a serverless `/api` function. Live data, S&P 500, compare, and AI Studio all work on Netlify; the multi-agent desk loop runs on the local server.

## The public layer: Morning Brief + Accuracy Scoreboard

The desk publishes a daily **Morning Brief** ([brief.html](public/brief.html)) — full agent cycles on a watchlist of 3–5 tickers — and every call goes into a permanent, never-edited ledger. The **Accuracy Scoreboard** ([scoreboard.html](public/scoreboard.html)) re-prices every past call against live market data: win rate, average return, and alpha vs SPY over the same period. Losses stay on the board — that's the point. An RSS feed (`feed.xml`) makes it a subscribable newsletter.

- **Fully automatic (cloud):** two GitHub Actions run with no computer on — `morning-brief.yml` (weekdays 12:30 UTC ≈ 8:30 AM ET) runs the full agent cycles, commits the ledger, and deploys; `scoreboard.yml` (weekdays 21:15 UTC, after the close) re-prices every call for free. Requires two repo secrets: `ANTHROPIC_API_KEY` and `NETLIFY_AUTH_TOKEN` (Netlify → User settings → Applications → Personal access tokens). Edit the watchlist in `data/config.json`.
- **Manual / local:** `npm run brief -- NVDA AAPL MSFT` generates a brief; `npm run scoreboard` re-prices all calls (no AI/key needed); add `--deploy` to either to push to Netlify. A local scheduler also exists (`autoBrief` in `data/config.json`) but is off by default now that the cloud owns publishing.
- **Scoring methodology (public):** BUY correct if up since the call, SELL/AVOID if down, HOLD if within ±5%; alpha = call return − SPY return. Cost note: each brief = one full agent cycle per ticker.

## Data sources

- **Prices / history / stats**: Yahoo Finance public chart API (no key needed)
- **News**: Yahoo Finance RSS feed (no key needed)
- **Evidence & research**: Claude's server-side web search tool (real web, cited sources)

## Run it

```bash
cd "Wahba Markets"
npm install
node server.js
# open http://localhost:3178
```

Set your Anthropic API key either:
- in a `.env` file next to `server.js`: `ANTHROPIC_API_KEY=sk-ant-...`
- or in the UI: **⚙ Settings → paste key → Save** (kept in server memory only)

Market data and news work with **no key at all** — the key is only needed for the AI agents.

## Cost note

A full cycle runs 4 large agent calls (one with web search) + 4-6 manager calls on Claude Opus 4.8. Expect roughly $0.50–$2.00 per cycle depending on ticker news volume. Auto re-run has a 10-minute cooldown for this reason.

---

*Educational research tool. AI-generated analysis of real market data — not financial advice.*
