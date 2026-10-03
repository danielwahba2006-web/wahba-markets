"use strict";
const path = require("path");
const fs = require("fs");

// Minimal .env loader (no dependency): KEY=VALUE lines, existing env wins.
(function loadEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
})();

const express = require("express");
const market = require("./market");
const agentsMod = require("./agents");
const { Orchestrator } = require("./orchestrator");
const briefMod = require("./brief");

const PORT = process.env.PORT || 3178;
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const desk = new Orchestrator();

// ---------------------------------------------------------------------------
// SSE event stream
// ---------------------------------------------------------------------------
const sseClients = new Set();

function broadcast(evt) {
  const payload = `data: ${JSON.stringify(evt)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }
}
desk.on("event", broadcast);

app.get("/api/events", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ type: "state", state: desk.publicState() })}\n\n`);
  sseClients.add(res);
  const ping = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      /* closed */
    }
  }, 25000);
  req.on("close", () => {
    clearInterval(ping);
    sseClients.delete(res);
  });
});

// ---------------------------------------------------------------------------
// Config / health
// ---------------------------------------------------------------------------
app.get("/api/health", async (req, res) => {
  if (req.query.refresh) await agentsMod.claudeCode.refreshStatus();
  res.json({
    ok: true,
    platform: "local",
    provider: agentsMod.provider(),
    model: agentsMod.modelLabel(),
    hasKey: agentsMod.hasKeyConfigured(),
    claudeCode: { installed: Boolean(agentsMod.claudeCode.cliPath()), loggedIn: agentsMod.claudeCode.getStatus().loggedIn },
    running: desk.state.running,
    monitor: desk.state.monitor,
  });
});

app.get("/api/state", (req, res) => res.json(desk.publicState()));

app.post("/api/key", (req, res) => {
  const key = (req.body && req.body.apiKey ? String(req.body.apiKey) : "").trim();
  if (!key) return res.status(400).json({ ok: false, error: "apiKey is required" });
  process.env.ANTHROPIC_API_KEY = key;
  desk.log("Anthropic API key configured (stored in server memory only).");
  broadcast({ type: "state", at: Date.now(), state: desk.publicState() });
  res.json({ ok: true });
});

// Tiny end-to-end AI check (1 short message) so users can verify their key works.
app.post("/api/test-ai", async (req, res) => {
  try {
    const out = await agentsMod.runAgent({
      system: "You are a connectivity check. Reply with exactly: DESK ONLINE",
      prompt: "Status check.",
      maxTokens: 3000,
    });
    res.json({ ok: true, provider: agentsMod.provider(), model: agentsMod.modelLabel(), reply: out.text.trim().slice(0, 100) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Real market data (no AI, no key needed)
// ---------------------------------------------------------------------------
app.get("/api/snapshot/:symbol", async (req, res) => {
  try {
    res.json(await market.snapshot(req.params.symbol));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get("/api/intraday/:symbol", async (req, res) => {
  try {
    res.json(await market.intradaySeries(req.params.symbol));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Lightweight quote for the 1-second live chart tick (server-side cached).
app.get("/api/tick/:symbol", async (req, res) => {
  try {
    res.json(await market.tick(req.params.symbol));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get("/api/news/:symbol", async (req, res) => {
  try {
    res.json(await market.news(req.params.symbol));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get("/api/search", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    if (!q) return res.json([]);
    res.json(await market.search(q));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// The AI desk
// ---------------------------------------------------------------------------
app.post("/api/cycle", async (req, res) => {
  const ticker = (req.body && req.body.ticker ? String(req.body.ticker) : "").trim();
  if (!ticker) return res.status(400).json({ ok: false, error: "ticker is required" });
  if (desk.state.running) return res.status(409).json({ ok: false, error: `A cycle is already running on ${desk.state.ticker}` });
  if (!agentsMod.hasKeyConfigured())
    return res.status(400).json({ ok: false, error: "AI engine offline. Log in to Claude Code with your Claude subscription (claude auth login --claudeai), or add an API key in Settings." });

  // Validate the ticker against real data before burning tokens.
  try {
    await market.intraday(ticker);
  } catch (err) {
    return res.status(400).json({ ok: false, error: `Unknown ticker "${ticker}": ${err.message}` });
  }

  desk.runCycle(ticker, "manual").catch(() => {});
  res.json({ ok: true, started: true, ticker: ticker.toUpperCase() });
});

// AI Studio chat — streams plain-text chunks. Body: { messages:[{role,content}], tickers:["AAPL","MSFT"] }
app.post("/api/chat", async (req, res) => {
  try {
    const body = req.body || {};
    const messages = Array.isArray(body.messages) ? body.messages.slice(-16) : [];
    if (!messages.length || messages[messages.length - 1].role !== "user")
      return res.status(400).json({ ok: false, error: "messages must end with a user message" });
    if (!agentsMod.hasKeyConfigured())
      return res.status(400).json({ ok: false, error: "AI engine offline. Log in to Claude Code with your Claude subscription (claude auth login --claudeai), or add an API key in Settings." });

    // Build live context for up to 2 tickers.
    const tickers = (Array.isArray(body.tickers) ? body.tickers : []).slice(0, 2).map((t) => String(t).trim().toUpperCase()).filter(Boolean);
    const blocks = [];
    for (const t of tickers) {
      try {
        const [snap, headlines] = await Promise.all([market.snapshot(t), market.news(t).catch(() => [])]);
        blocks.push(market.describeSnapshot(snap, headlines.slice(0, 8)));
      } catch (err) {
        blocks.push(`(Could not load live data for ${t}: ${err.message})`);
      }
    }
    if (desk.state.verdict && tickers.includes(desk.state.verdictTicker)) {
      const v = desk.state.verdict;
      blocks.push(
        `DESK'S LATEST TRADE CARD ON ${v.ticker}: ${v.signal} (conviction ${v.conviction}/10). Entry: ${v.entry_price}. Target: ${v.target_price}. Invalidation: ${v.invalidation}. Summary: ${v.summary}`
      );
    }
    const contextBlock = blocks.length ? `=== LIVE MARKET CONTEXT ===\n${blocks.join("\n\n")}\n=== END CONTEXT ===` : "";

    res.set({ "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" });
    res.flushHeaders();
    await agentsMod.chatStream({
      messages,
      contextBlock,
      onDelta: (delta) => res.write(delta),
    });
    res.end();
  } catch (err) {
    if (res.headersSent) {
      res.write(`\n\n[error: ${err.message}]`);
      res.end();
    } else {
      res.status(500).json({ ok: false, error: err.message });
    }
  }
});

// ---------------------------------------------------------------------------
// Morning Brief + public scoreboard
// ---------------------------------------------------------------------------
let briefRunning = false;

async function runBrief(tickers, trigger) {
  briefRunning = true;
  try {
    const cfg = briefMod.loadConfig();
    await briefMod.generateBrief({ desk, tickers, log: (m, l) => desk.log(m, l) });
    briefMod.saveState({ ...briefMod.loadState(), lastBriefDate: briefMod.todayStr() });
    desk.send("brief_done", { date: briefMod.todayStr(), trigger });
    if (cfg.autoDeploy) await briefMod.deployToNetlify(cfg.netlifySiteId, (m, l) => desk.log(m, l));
  } finally {
    briefRunning = false;
  }
}

app.post("/api/brief", (req, res) => {
  if (desk.state.running || briefRunning)
    return res.status(409).json({ ok: false, error: "The desk is busy (a cycle or brief is already running)." });
  if (!agentsMod.hasKeyConfigured())
    return res.status(400).json({ ok: false, error: "AI engine offline. Log in to Claude Code with your Claude subscription (claude auth login --claudeai), or add an API key in Settings." });
  const cfg = briefMod.loadConfig();
  const tickers = Array.isArray(req.body && req.body.tickers) && req.body.tickers.length ? req.body.tickers : cfg.watchlist;
  runBrief(tickers, "manual").catch((err) => desk.log(`Brief failed: ${err.message}`, "error"));
  res.json({ ok: true, started: true, tickers });
});

app.get("/api/scoreboard", async (req, res) => {
  try {
    res.json(await briefMod.publishPublicData((m, l) => desk.log(m, l)));
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/brief-config", (req, res) => res.json(briefMod.loadConfig()));
app.post("/api/brief-config", (req, res) => {
  const cfg = { ...briefMod.loadConfig(), ...(req.body || {}) };
  briefMod.saveConfig(cfg);
  desk.log(`Brief config updated: watchlist ${cfg.watchlist.join(", ")} at ${cfg.briefTime} (auto: ${cfg.autoBrief}).`);
  res.json({ ok: true, config: cfg });
});

// Daily scheduler: publish the Morning Brief on weekdays at cfg.briefTime.
setInterval(() => {
  try {
    const cfg = briefMod.loadConfig();
    if (!cfg.autoBrief || !agentsMod.hasKeyConfigured()) return;
    const now = new Date();
    if (now.getDay() === 0 || now.getDay() === 6) return;
    const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    if (hhmm < cfg.briefTime) return;
    if (briefMod.loadState().lastBriefDate === briefMod.todayStr()) return;
    if (desk.state.running || briefRunning) return;
    desk.log(`Scheduler: ${cfg.briefTime} reached — generating today's Morning Brief (${cfg.watchlist.join(", ")}).`);
    runBrief(cfg.watchlist, "scheduled").catch((err) => desk.log(`Scheduled brief failed: ${err.message}`, "error"));
  } catch {
    /* never let the scheduler crash the server */
  }
}, 60 * 1000);

app.post("/api/monitor", (req, res) => {
  const { enabled, ticker, auto } = req.body || {};
  if (enabled) {
    if (!ticker) return res.status(400).json({ ok: false, error: "ticker is required" });
    desk.startMonitor(String(ticker), { auto: Boolean(auto) });
  } else {
    desk.stopMonitor();
  }
  res.json({ ok: true, monitor: desk.state.monitor });
});

app.listen(PORT, () => {
  console.log(`Wahba Markets — AI Trading Desk`);
  console.log(`  → http://localhost:${PORT}`);
  agentsMod.claudeCode.refreshStatus().then(() => {
    const p = agentsMod.provider();
    const how = p === "claude-code" ? "Claude subscription via Claude Code (no API key)" : p === "anthropic" ? "Anthropic API key" : "none — log in with `claude auth login --claudeai` or add an API key";
    console.log(`  AI engine: ${how}`);
  });
});
