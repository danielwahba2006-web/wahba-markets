"use strict";
// The public layer: Morning Brief generation, the call ledger, and the
// accuracy scoreboard. Every verdict the desk issues is recorded permanently
// and re-priced against real market data — wins AND losses stay public.

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const market = require("./market");

const DATA_DIR = process.env.WAHBA_DATA_DIR || path.join(__dirname, "data");
const PUB_DIR = process.env.WAHBA_PUB_DIR || path.join(__dirname, "public", "data");
const SITE_URL = process.env.WAHBA_SITE_URL || "https://wahbamarkets.netlify.app";

const DEFAULT_CONFIG = {
  watchlist: ["NVDA", "AAPL", "MSFT"],
  briefTime: "08:30", // local time, weekdays
  autoBrief: true, // only fires when the server is running AND a key is configured
  autoDeploy: true, // push public/ to Netlify after each brief (requires netlify CLI login)
  netlifySiteId: "0eff93b3-13d9-497b-a7cb-c94977b7f64c",
};

// HOLD calls count as correct when the stock stays within ±HOLD_BAND_PCT.
const HOLD_BAND_PCT = 5;

function ensureDirs() {
  for (const d of [DATA_DIR, path.join(DATA_DIR, "briefs"), PUB_DIR]) fs.mkdirSync(d, { recursive: true });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function loadConfig() {
  return { ...DEFAULT_CONFIG, ...readJson(path.join(DATA_DIR, "config.json"), {}) };
}
function saveConfig(cfg) {
  ensureDirs();
  writeJson(path.join(DATA_DIR, "config.json"), cfg);
}
function loadState() {
  return readJson(path.join(DATA_DIR, "state.json"), {});
}
function saveState(state) {
  ensureDirs();
  writeJson(path.join(DATA_DIR, "state.json"), state);
}
function loadLedger() {
  return readJson(path.join(DATA_DIR, "calls.json"), []);
}

function todayStr(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ---------------------------------------------------------------------------
// Morning Brief generation — runs the full 5-agent desk on each ticker.
// ---------------------------------------------------------------------------
async function generateBrief({ desk, tickers, log = () => {} }) {
  ensureDirs();
  const date = todayStr();
  const list = [...new Set(tickers.map((t) => String(t).trim().toUpperCase()).filter(Boolean))].slice(0, 5);
  if (!list.length) throw new Error("No tickers supplied for the brief.");
  log(`=== MORNING BRIEF ${date} — ${list.join(", ")} ===`);

  // Market pulse + benchmark (SPY is the scoreboard benchmark).
  const pulse = {};
  for (const [key, sym] of [["spy", "SPY"], ["qqq", "QQQ"], ["vix", "^VIX"]]) {
    try {
      const q = await market.intraday(sym);
      pulse[key] = { symbol: sym, price: q.price, changePct: q.changePct };
    } catch {
      pulse[key] = { symbol: sym, price: null, changePct: null };
    }
  }
  if (pulse.spy.price == null) throw new Error("Could not price the SPY benchmark — aborting brief.");

  const entries = [];
  const errors = [];
  for (const t of list) {
    try {
      log(`Brief: opening desk cycle on ${t}…`);
      const v = await desk.runCycle(t, "morning-brief");
      entries.push({
        ticker: v.ticker,
        price: v.price_at_verdict,
        currency: v.currency,
        verdict: v,
      });
    } catch (err) {
      errors.push({ ticker: t, error: err.message });
      log(`Brief: cycle on ${t} failed — ${err.message}`, "error");
    }
  }
  if (!entries.length) throw new Error("Every cycle failed — no brief generated. Errors: " + JSON.stringify(errors));

  const counts = {};
  for (const e of entries) counts[e.verdict.signal] = (counts[e.verdict.signal] || 0) + 1;
  const top = [...entries].sort((a, b) => b.verdict.conviction - a.verdict.conviction)[0];
  const headline =
    Object.entries(counts).map(([s, n]) => `${n} ${s}`).join(" · ") +
    ` — top conviction: ${top.ticker} ${top.verdict.signal} (${top.verdict.conviction}/10)`;

  const brief = { date, generatedAt: Date.now(), headline, market: pulse, entries, errors };
  writeJson(path.join(DATA_DIR, "briefs", `${date}.json`), brief);

  // Record every verdict in the permanent call ledger (upsert per date+ticker).
  const ledger = loadLedger();
  for (const e of entries) {
    const id = `${date}-${e.ticker}`;
    const call = {
      id,
      date,
      ticker: e.ticker,
      signal: e.verdict.signal,
      conviction: e.verdict.conviction,
      price_at_call: e.price,
      spy_at_call: pulse.spy.price,
      currency: e.currency,
      target_price: e.verdict.target_price,
      invalidation: e.verdict.invalidation,
      time_horizon: e.verdict.time_horizon,
      summary: e.verdict.summary,
    };
    const i = ledger.findIndex((c) => c.id === id);
    if (i >= 0) ledger[i] = call;
    else ledger.push(call);
  }
  writeJson(path.join(DATA_DIR, "calls.json"), ledger);
  log(`Brief saved: ${entries.length} call(s) recorded in the public ledger.`);

  await publishPublicData(log);
  return brief;
}

// ---------------------------------------------------------------------------
// Evaluation — re-price every past call with REAL current prices.
// Methodology (shown publicly): BUY correct if return > 0; SELL/AVOID correct
// if return < 0; HOLD correct if the move stayed within ±5%. Alpha = call
// return minus SPY return over the same period.
// ---------------------------------------------------------------------------
async function evaluateCalls(log = () => {}) {
  const ledger = loadLedger();
  const evaluated = [];
  let spyNow = null;
  try {
    spyNow = (await market.tick("SPY")).price;
  } catch {}

  const priceCache = {};
  for (const call of ledger) {
    let cur = null;
    try {
      if (!(call.ticker in priceCache)) priceCache[call.ticker] = (await market.tick(call.ticker)).price;
      cur = priceCache[call.ticker];
    } catch (err) {
      log(`Scoreboard: could not price ${call.ticker} — ${err.message}`, "warn");
    }
    const ret = cur != null && call.price_at_call ? ((cur - call.price_at_call) / call.price_at_call) * 100 : null;
    const spyRet = spyNow != null && call.spy_at_call ? ((spyNow - call.spy_at_call) / call.spy_at_call) * 100 : null;
    const alpha = ret != null && spyRet != null ? ret - spyRet : null;
    let hit = null;
    if (ret != null) {
      if (call.signal === "BUY") hit = ret > 0;
      else if (call.signal === "SELL" || call.signal === "AVOID") hit = ret < 0;
      else if (call.signal === "HOLD") hit = Math.abs(ret) <= HOLD_BAND_PCT;
    }
    const daysOpen = Math.max(0, Math.round((Date.now() - new Date(call.date + "T12:00:00").getTime()) / 86400000));
    evaluated.push({ ...call, current_price: cur, return_pct: ret, spy_return_pct: spyRet, alpha, hit, days_open: daysOpen });
  }

  const scored = evaluated.filter((c) => c.hit != null);
  const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
  const bySignal = {};
  for (const sig of ["BUY", "SELL", "HOLD", "AVOID"]) {
    const group = scored.filter((c) => c.signal === sig);
    if (group.length)
      bySignal[sig] = {
        calls: group.length,
        wins: group.filter((c) => c.hit).length,
        winRate: (group.filter((c) => c.hit).length / group.length) * 100,
        avgReturn: avg(group.map((c) => c.return_pct)),
        avgAlpha: avg(group.map((c) => c.alpha).filter((v) => v != null)),
      };
  }

  return {
    updatedAt: Date.now(),
    methodology: `Every call the desk publishes is recorded at its live price and never edited. BUY is correct if the price is up since the call; SELL/AVOID if down; HOLD if the move stayed within ±${HOLD_BAND_PCT}%. Alpha = call return minus SPY return over the same period. Losses stay on the board.`,
    totals: {
      calls: ledger.length,
      evaluated: scored.length,
      wins: scored.filter((c) => c.hit).length,
      winRate: scored.length ? (scored.filter((c) => c.hit).length / scored.length) * 100 : null,
      avgReturn: avg(scored.map((c) => c.return_pct)),
      avgAlpha: avg(scored.map((c) => c.alpha).filter((v) => v != null)),
    },
    bySignal,
    calls: evaluated.sort((a, b) => (a.date < b.date ? 1 : -1)),
  };
}

// ---------------------------------------------------------------------------
// Publish: copy briefs + fresh scoreboard + RSS into public/data.
// ---------------------------------------------------------------------------
async function publishPublicData(log = () => {}) {
  ensureDirs();
  const briefsDir = path.join(DATA_DIR, "briefs");
  const dates = fs.existsSync(briefsDir)
    ? fs.readdirSync(briefsDir).filter((f) => f.endsWith(".json")).map((f) => f.replace(".json", "")).sort().reverse()
    : [];
  for (const d of dates) {
    fs.copyFileSync(path.join(briefsDir, `${d}.json`), path.join(PUB_DIR, `brief-${d}.json`));
  }
  writeJson(path.join(PUB_DIR, "briefs-index.json"), dates);
  if (dates.length) fs.copyFileSync(path.join(briefsDir, `${dates[0]}.json`), path.join(PUB_DIR, "latest.json"));

  const scoreboard = await evaluateCalls(log);
  writeJson(path.join(PUB_DIR, "scoreboard.json"), scoreboard);

  // RSS feed — the "newsletter": subscribe in any RSS reader.
  const esc = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const items = dates.slice(0, 30).map((d) => {
    const b = readJson(path.join(briefsDir, `${d}.json`), {});
    const tickers = (b.entries || []).map((e) => `${e.verdict.signal} ${e.ticker} (${e.verdict.conviction}/10)`).join(", ");
    return `  <item>
    <title>Morning Brief ${d} — ${esc(b.headline || "")}</title>
    <link>${SITE_URL}/brief.html?date=${d}</link>
    <guid isPermaLink="false">wahba-brief-${d}</guid>
    <pubDate>${new Date(b.generatedAt || d).toUTCString()}</pubDate>
    <description>${esc(tickers)}</description>
  </item>`;
  });
  const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
  <title>Wahba Markets — Morning Brief</title>
  <link>${SITE_URL}/brief.html</link>
  <description>Daily AI trading-desk briefs with a public, never-edited accuracy record.</description>
${items.join("\n")}
</channel>
</rss>`;
  fs.writeFileSync(path.join(path.dirname(PUB_DIR), "feed.xml"), rss);
  log(`Public data published (${dates.length} brief(s), scoreboard, RSS).`);
  return scoreboard;
}

// ---------------------------------------------------------------------------
// Optional: push the public site to Netlify after a brief.
// ---------------------------------------------------------------------------
function deployToNetlify(siteId, log = () => {}) {
  return new Promise((resolve) => {
    log("Deploying updated public site to Netlify…");
    const child = spawn("netlify", ["deploy", "--prod", "--site", siteId], {
      cwd: __dirname,
      shell: true,
      env: process.env,
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => {
      if (code === 0) log("Netlify deploy complete — the public scoreboard is live.");
      else log(`Netlify deploy failed (exit ${code}). Run 'netlify deploy --prod' manually. ${out.slice(-300)}`, "error");
      resolve(code === 0);
    });
    child.on("error", (err) => {
      log(`Netlify CLI not available: ${err.message}`, "warn");
      resolve(false);
    });
  });
}

module.exports = {
  DATA_DIR,
  PUB_DIR,
  loadConfig,
  saveConfig,
  loadState,
  saveState,
  loadLedger,
  todayStr,
  generateBrief,
  evaluateCalls,
  publishPublicData,
  deployToNetlify,
};
