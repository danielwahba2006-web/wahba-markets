"use strict";
/*
 * Wahba Markets — backend test suite.
 *
 * Spins up:
 *   1. a MOCK Anthropic API (so the full 5-agent loop, manager validation,
 *      rejection/re-prompt, pause_turn continuation, and chat streaming are
 *      all exercised end-to-end without real API spend), and
 *   2. the real app server on a test port, pointed at the mock via
 *      ANTHROPIC_BASE_URL.
 *
 * Market-data tests hit the real Yahoo upstream (that's the point: real data).
 *
 * Run:  node test/run-tests.js
 */

const { spawn } = require("child_process");
const http = require("http");
const path = require("path");
const fs = require("fs");

const MOCK_PORT = 9911;
const APP_PORT = 3277; // off the beaten path — 3179 is used by another project
const BASE = `http://127.0.0.1:${APP_PORT}`;

let passed = 0;
let failed = 0;
const failures = [];

function assert(name, cond, extra = "") {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    failures.push(`${name} ${extra}`);
    console.log(`  FAIL  ${name}  ${extra}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function jget(url) {
  const res = await fetch(BASE + url);
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
async function jpost(url, data) {
  const res = await fetch(BASE + url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: data == null ? undefined : JSON.stringify(data),
  });
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("json")) return { status: res.status, body: await res.json().catch(() => ({})) };
  return { status: res.status, text: await res.text() };
}

// ---------------------------------------------------------------------------
// 1. Mock Anthropic API
// ---------------------------------------------------------------------------
let validationCalls = 0;
let streamingCalls = 0;
let pauseTurnServed = false;

const mock = http.createServer((req, res) => {
  if (req.method !== "POST" || !req.url.startsWith("/v1/messages")) {
    res.writeHead(404, { "Content-Type": "application/json" });
    return res.end('{"type":"error","error":{"type":"not_found_error","message":"mock: unknown route"}}');
  }
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    let j;
    try {
      j = JSON.parse(raw);
    } catch {
      res.writeHead(400);
      return res.end("{}");
    }
    const allText = JSON.stringify(j.messages) + JSON.stringify(j.system || "");

    if (j.stream) {
      streamingCalls++;
      // First hop of a web-search (tools) request pauses, to exercise pause_turn resume.
      const hasTools = Array.isArray(j.tools) && j.tools.length > 0;
      const hasAssistantTurn = j.messages.some((m) => m.role === "assistant");
      const stopReason = hasTools && !hasAssistantTurn ? "pause_turn" : "end_turn";
      if (stopReason === "pause_turn") pauseTurnServed = true;

      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      send("message_start", {
        type: "message_start",
        message: { id: "msg_mock1", type: "message", role: "assistant", model: j.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 0 } },
      });
      send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      const chunks =
        stopReason === "pause_turn"
          ? ["MOCK RESEARCH (searching the web…) "]
          : ["MOCK ", "AGENT REPORT — evidence pack attached. ", "QUESTIONS FOR THE NEXT AGENT: 1) mock question?"];
      for (const c of chunks) send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: c } });
      send("content_block_stop", { type: "content_block_stop", index: 0 });
      send("message_delta", { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 9 } });
      send("message_stop", { type: "message_stop" });
      res.end();
      return;
    }

    // Non-streaming structured-output (JSON) calls
    let text;
    if (allText.includes("You assigned the")) {
      validationCalls++;
      text = JSON.stringify(
        validationCalls === 1
          ? { approved: false, quality_score: 4, feedback: "MOCK REJECTION: cite sources for every figure." }
          : { approved: true, quality_score: 9, feedback: "Solid, grounded work." }
      );
    } else if (allText.includes("final trade card")) {
      text = JSON.stringify({
        signal: "BUY",
        conviction: 7,
        entry_price: "100-105 USD",
        target_price: "130 USD in 12 months",
        invalidation: "Daily close below 90 USD or guidance cut",
        time_horizon: "6-18 months",
        summary: "Mock synthesis: the bull case outweighs the bear case at current prices.",
        key_evidence: ["mock evidence 1", "mock evidence 2", "mock evidence 3"],
        key_risks: ["mock risk 1", "mock risk 2", "mock risk 3"],
        agent_agreement: "All four agents broadly agreed in this mock run.",
      });
    } else if (allText.includes("material")) {
      text = JSON.stringify({ material: false, reason: "Mock: routine commentary.", suggested_action: "NONE" });
    } else {
      text = JSON.stringify({ ok: true });
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({ id: "msg_mockjson", type: "message", role: "assistant", model: j.model, content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 8, output_tokens: 8 } })
    );
  });
});

// ---------------------------------------------------------------------------
// SSE collector for /api/events
// ---------------------------------------------------------------------------
function collectSSE(ms) {
  return new Promise((resolve) => {
    const events = [];
    let buf = "";
    const req = http.get(`${BASE}/api/events`, (res) => {
      res.on("data", (chunk) => {
        buf += chunk.toString();
        const lines = buf.split("\n");
        buf = lines.pop();
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              events.push(JSON.parse(line.slice(6)));
            } catch {}
          }
        }
      });
    });
    req.on("error", () => resolve(events));
    setTimeout(() => {
      req.destroy();
      resolve(events);
    }, ms);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
async function main() {
  await new Promise((r) => mock.listen(MOCK_PORT, "127.0.0.1", r));
  console.log(`mock Anthropic API on :${MOCK_PORT}`);

  // isolated data dirs so tests never touch real ledger/public data
  const os = require("os");
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "wahba-test-"));
  const TEST_DATA = path.join(tmpBase, "data");
  const TEST_PUB = path.join(tmpBase, "pub");
  // never auto-brief or auto-deploy from the test server
  fs.mkdirSync(TEST_DATA, { recursive: true });
  fs.writeFileSync(
    path.join(TEST_DATA, "config.json"),
    JSON.stringify({ watchlist: ["AAPL", "MSFT"], briefTime: "23:59", autoBrief: false, autoDeploy: false })
  );

  const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: {
      ...process.env,
      PORT: String(APP_PORT),
      ANTHROPIC_API_KEY: "sk-ant-test-mock-key",
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
      WAHBA_DATA_DIR: TEST_DATA,
      WAHBA_PUB_DIR: TEST_PUB,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverLog = "";
  child.stdout.on("data", (d) => (serverLog += d));
  child.stderr.on("data", (d) => (serverLog += d));

  try {
    // wait for readiness
    let ready = false;
    for (let i = 0; i < 40; i++) {
      try {
        const h = await jget("/api/health");
        if (h.body.ok) { ready = true; break; }
      } catch {}
      await sleep(250);
    }
    if (!ready) throw new Error("app server never became ready.\n" + serverLog);

    console.log("\n== HEALTH & CONFIG ==");
    const health = (await jget("/api/health")).body;
    assert("health ok", health.ok === true);
    assert("health platform=local", health.platform === "local");
    assert("health model is claude-opus-4-8", health.model === "claude-opus-4-8");
    assert("health hasKey=true (test key)", health.hasKey === true);
    const badKey = await jpost("/api/key", {});
    assert("POST /api/key without key -> 400", badKey.status === 400);

    console.log("\n== REAL MARKET DATA (live Yahoo upstream) ==");
    for (const sym of ["AAPL", "MSFT", "BRK-B", "XOM", "JNJ"]) {
      const { status, body: s } = await jget(`/api/snapshot/${sym}`);
      const ok =
        status === 200 &&
        s.price > 0 &&
        s.prevClose > 0 &&
        Math.abs(s.changePct) < 25 &&
        Array.isArray(s.series) &&
        s.series.length > 150 &&
        s.ma50 > 0 &&
        s.ma200 > 0 &&
        s.lo52 > 0 &&
        s.hi52 >= s.lo52 &&
        s.price >= s.lo52 * 0.9 &&
        s.price <= s.hi52 * 1.1;
      assert(`snapshot ${sym} sane (price=${s.price}, chg=${s.changePct && s.changePct.toFixed(2)}%, pts=${s.series && s.series.length})`, ok, JSON.stringify({ status, price: s.price, chg: s.changePct }));
    }
    const badSnap = await jget("/api/snapshot/NOTAREALTICKER99");
    assert("snapshot invalid ticker -> 502 with error", badSnap.status === 502 && badSnap.body.error);

    const intra = await jget("/api/intraday/AAPL");
    assert("intraday AAPL has series + prevClose", intra.status === 200 && intra.body.series.length > 0 && intra.body.prevClose > 0);

    const t1 = await jget("/api/tick/AAPL");
    const t2 = await jget("/api/tick/AAPL");
    assert("tick AAPL price > 0", t1.body.price > 0);
    assert("tick cache serves rapid repeat (same asOf)", t1.body.asOf === t2.body.asOf, `${t1.body.asOf} vs ${t2.body.asOf}`);

    const news = await jget("/api/news/AAPL");
    assert("news AAPL returns headlines with id+title", news.status === 200 && news.body.length > 0 && news.body[0].id && news.body[0].title);

    const search = await jget("/api/search?q=apple");
    assert("search 'apple' contains AAPL", search.body.some((r) => r.symbol === "AAPL"));
    const emptySearch = await jget("/api/search?q=");
    assert("search empty q -> []", Array.isArray(emptySearch.body) && emptySearch.body.length === 0);

    console.log("\n== S&P 500 LIST ==");
    const sp = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "public", "sp500.json"), "utf8"));
    assert("sp500.json has 503 constituents", sp.length === 503, String(sp.length));
    assert("all entries have symbol/name/sector", sp.every((r) => r.s && r.n && r.sec));
    assert("symbols unique", new Set(sp.map((r) => r.s)).size === sp.length);
    assert("no dot-symbols (Yahoo-friendly)", sp.every((r) => !r.s.includes(".")));
    for (const must of ["AAPL", "MSFT", "NVDA", "BRK-B", "BF-B"]) assert(`contains ${must}`, sp.some((r) => r.s === must));
    // spot-validate a sample of constituents against the real quote API
    const sample = [];
    for (let i = 0; i < sp.length; i += Math.floor(sp.length / 20)) sample.push(sp[i].s);
    if (!sample.includes("BRK-B")) sample.push("BRK-B");
    if (!sample.includes("BF-B")) sample.push("BF-B");
    let liveOk = 0;
    const bad = [];
    for (const sym of sample) {
      const r = await jget(`/api/tick/${sym}`);
      if (r.status === 200 && r.body.price > 0) liveOk++;
      else bad.push(sym);
      await sleep(120);
    }
    assert(`sampled constituents resolve to live quotes (${liveOk}/${sample.length})`, bad.length === 0, "failed: " + bad.join(","));

    console.log("\n== AI LAYER (mock Anthropic) ==");
    const testAi = await jpost("/api/test-ai");
    assert("test-ai returns a reply", testAi.status === 200 && testAi.body.ok && testAi.body.reply.length > 0, JSON.stringify(testAi.body));

    const chatBad = await jpost("/api/chat", { messages: [] });
    assert("chat with empty messages -> 400", chatBad.status === 400);

    const chatRes = await fetch(BASE + "/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "What do you think of AAPL?" }], tickers: ["AAPL"] }),
    });
    const chatText = await chatRes.text();
    assert("chat streams non-empty text", chatRes.status === 200 && chatText.includes("MOCK"), chatText.slice(0, 80));

    const chatMulti = await fetch(BASE + "/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello" },
          { role: "user", content: "compare AAPL and MSFT" },
        ],
        tickers: ["AAPL", "MSFT"],
      }),
    });
    assert("chat multi-turn + 2 tickers works", chatMulti.status === 200 && (await chatMulti.text()).length > 0);

    console.log("\n== FULL AGENT CYCLE (mock, end-to-end) ==");
    const ssePromise = collectSSE(30000);
    await sleep(300);
    const badCycle = await jpost("/api/cycle", { ticker: "NOTAREALTICKER99" });
    assert("cycle with invalid ticker -> 400", badCycle.status === 400);

    const cyc = await jpost("/api/cycle", { ticker: "AAPL" });
    assert("cycle starts", cyc.status === 200 && cyc.body.started === true, JSON.stringify(cyc.body));
    const dup = await jpost("/api/cycle", { ticker: "MSFT" });
    assert("second cycle while running -> 409", dup.status === 409, String(dup.status));

    // wait for completion
    let state = null;
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      state = (await jget("/api/state")).body;
      if (!state.running && state.cycleCount > 0) break;
    }
    assert("cycle completed", state && !state.running && state.cycleCount === 1, JSON.stringify({ running: state && state.running, count: state && state.cycleCount }));
    const v = state.verdict || {};
    assert("verdict signal is BUY (from mock)", v.signal === "BUY");
    assert("verdict has conviction/entry/target/invalidation", v.conviction === 7 && v.entry_price && v.target_price && v.invalidation);
    assert("verdict carries ticker + live price", v.ticker === "AAPL" && v.price_at_verdict > 0);
    const agentStates = Object.entries(state.agents).map(([k, a]) => `${k}:${a.status}`).join(" ");
    assert("all 5 agents reached done", ["researcher", "analyst", "reality", "devil", "manager"].every((k) => state.agents[k] && state.agents[k].status === "done"), agentStates);
    assert("pause_turn continuation exercised (web-search resume)", pauseTurnServed === true);
    assert("manager rejected once and re-prompted (retry path)", validationCalls >= 5, `validationCalls=${validationCalls}`);

    const events = await ssePromise;
    const types = new Set(events.map((e) => e.type));
    assert("SSE saw cycle_start", types.has("cycle_start"));
    assert("SSE saw streaming deltas", events.filter((e) => e.type === "delta").length > 5);
    assert("SSE saw a rejected validation", events.some((e) => e.type === "validation" && e.approved === false));
    assert("SSE saw an approved validation", events.some((e) => e.type === "validation" && e.approved === true));
    assert("SSE saw verdict + cycle_done", types.has("verdict") && types.has("cycle_done"));
    assert("SSE saw price + news broadcast", types.has("price") && types.has("news"));

    console.log("\n== MONITOR LOOP ==");
    const monOn = await jpost("/api/monitor", { enabled: true, ticker: "AAPL", auto: false });
    assert("monitor starts", monOn.status === 200 && monOn.body.monitor.enabled === true);
    await sleep(2500);
    const st2 = (await jget("/api/state")).body;
    assert("monitor state persisted", st2.monitor.enabled === true && st2.monitor.ticker === "AAPL");
    const monOff = await jpost("/api/monitor", { enabled: false });
    assert("monitor stops", monOff.status === 200 && monOff.body.monitor.enabled === false);
    const monBad = await jpost("/api/monitor", { enabled: true });
    assert("monitor without ticker -> 400", monBad.status === 400);

    console.log("\n== MORNING BRIEF + PUBLIC SCOREBOARD (mock AI, real prices) ==");
    const cfgGet = await jget("/api/brief-config");
    assert("brief-config readable (test watchlist)", cfgGet.body.watchlist.join(",") === "AAPL,MSFT" && cfgGet.body.autoDeploy === false);

    const briefStart = await jpost("/api/brief", {});
    assert("brief starts on watchlist", briefStart.status === 200 && briefStart.body.started, JSON.stringify(briefStart.body));
    const briefDup = await jpost("/api/brief", {});
    assert("second brief while running -> 409", briefDup.status === 409, String(briefDup.status));

    let briefDone = false;
    for (let i = 0; i < 120; i++) {
      await sleep(500);
      const today = new Date();
      const p = (n) => String(n).padStart(2, "0");
      const dstr = `${today.getFullYear()}-${p(today.getMonth() + 1)}-${p(today.getDate())}`;
      if (fs.existsSync(path.join(TEST_PUB, "latest.json")) && fs.existsSync(path.join(TEST_DATA, "briefs", `${dstr}.json`))) {
        const st = (await jget("/api/state")).body;
        if (!st.running) { briefDone = true; break; }
      }
    }
    assert("brief completed and published", briefDone);

    const latest = JSON.parse(fs.readFileSync(path.join(TEST_PUB, "latest.json"), "utf8"));
    assert("brief has 2 entries with verdicts", latest.entries.length === 2 && latest.entries.every((e) => e.verdict.signal && e.price > 0));
    assert("brief has SPY/QQQ market pulse", latest.market.spy.price > 0 && latest.market.qqq.price > 0);
    assert("brief headline present", typeof latest.headline === "string" && latest.headline.includes("conviction"));

    const ledger = JSON.parse(fs.readFileSync(path.join(TEST_DATA, "calls.json"), "utf8"));
    assert("ledger recorded 2 calls with price + SPY benchmark", ledger.length === 2 && ledger.every((c) => c.price_at_call > 0 && c.spy_at_call > 0));

    const sbRes = await jget("/api/scoreboard");
    const sb = sbRes.body;
    assert("scoreboard endpoint returns fresh evaluation", sbRes.status === 200 && sb.totals.calls === 2 && sb.totals.evaluated === 2);
    assert("scoreboard calls carry return/alpha/hit", sb.calls.every((c) => c.current_price > 0 && c.return_pct != null && c.alpha != null && typeof c.hit === "boolean"));
    assert("scoreboard win rate is 0-100", sb.totals.winRate >= 0 && sb.totals.winRate <= 100);
    assert("scoreboard.json published", fs.existsSync(path.join(TEST_PUB, "scoreboard.json")));
    assert("briefs-index.json published", JSON.parse(fs.readFileSync(path.join(TEST_PUB, "briefs-index.json"), "utf8")).length === 1);
    const rssPath = path.join(path.dirname(TEST_PUB), "feed.xml");
    assert("RSS feed generated with brief item", fs.existsSync(rssPath) && fs.readFileSync(rssPath, "utf8").includes("Morning Brief"));

    // idempotent re-run same day: ledger must not duplicate
    await jpost("/api/brief", { tickers: ["AAPL"] });
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      const st = (await jget("/api/state")).body;
      if (!st.running && st.cycleCount >= 4) break;
    }
    const ledger2 = JSON.parse(fs.readFileSync(path.join(TEST_DATA, "calls.json"), "utf8"));
    assert("same-day re-run upserts (no duplicate calls)", ledger2.length === 2, `ledger=${ledger2.length}`);
  } catch (err) {
    failed++;
    failures.push("SUITE ERROR: " + err.message);
    console.error("SUITE ERROR:", err);
  } finally {
    child.kill();
    mock.close();
  }

  try {
    await testClaudeCodeEngine(tmpBase);
  } catch (err) {
    failed++;
    failures.push("CLAUDE CODE SUITE ERROR: " + err.message);
    console.error("CLAUDE CODE SUITE ERROR:", err);
  }

  console.log(`\n================================`);
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log("Failures:");
    failures.forEach((f) => console.log("  - " + f));
  }
  process.exit(failed ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Claude Code engine (subscription, no API key) — via a protocol-faithful fake CLI
// ---------------------------------------------------------------------------
function startServer(port, extraEnv) {
  const env = { ...process.env, PORT: String(port), ...extraEnv };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ANTHROPIC_BASE_URL;
  return spawn(process.execPath, [path.join(__dirname, "..", "server.js")], { env, stdio: ["ignore", "pipe", "pipe"] });
}

async function waitReady(base) {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(base + "/api/health?refresh=1");
      if (r.ok) return (await r.json());
    } catch {}
    await sleep(250);
  }
  throw new Error("server never became ready at " + base);
}

async function testClaudeCodeEngine(tmpBase) {
  console.log("\n== CLAUDE CODE ENGINE (Claude subscription, NO API key) ==");
  const PORT = 3278;
  const base = `http://127.0.0.1:${PORT}`;
  const fake = path.join(__dirname, "fake-claude.js");
  const log = path.join(tmpBase, "fake-claude.log");
  const state = path.join(tmpBase, "fake-claude.state");
  const dataDir = path.join(tmpBase, "cc-data");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({ watchlist: ["AAPL"], briefTime: "23:59", autoBrief: false, autoDeploy: false }));

  const server = startServer(PORT, {
    WAHBA_CLAUDE_PATH: fake,
    FAKE_CLAUDE_LOG: log,
    FAKE_CLAUDE_STATE: state,
    WAHBA_DATA_DIR: dataDir,
    WAHBA_PUB_DIR: path.join(tmpBase, "cc-pub"),
    CLAUDECODE: "1", // simulate launching from inside a Claude Code session
  });
  try {
    const h = await waitReady(base);
    assert("engine auto-selects claude-code with no API key", h.provider === "claude-code" && h.hasKey === true, JSON.stringify(h));
    assert("health reports CLI installed + logged in", h.claudeCode && h.claudeCode.installed && h.claudeCode.loggedIn);

    const t = await (await fetch(base + "/api/test-ai", { method: "POST" })).json();
    assert("test-ai answers through Claude Code", t.ok && t.provider === "claude-code" && t.reply.includes("FAKE"), JSON.stringify(t));
    const h2 = await (await fetch(base + "/api/health")).json();
    assert("model label comes from the CLI session", h2.model === "claude-fake-subscription", h2.model);

    const chatRes = await fetch(base + "/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello" },
          { role: "user", content: "thoughts on AAPL?" },
        ],
        tickers: ["AAPL"],
      }),
    });
    const chatText = await chatRes.text();
    assert("AI Studio chat streams via Claude Code (multi-turn)", chatRes.status === 200 && chatText.includes("FAKE CC REPORT"), chatText.slice(0, 80));

    const start = await (await fetch(base + "/api/cycle", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ticker: "AAPL" }) })).json();
    assert("full desk cycle starts with no API key", start.ok && start.started, JSON.stringify(start));
    let st = null;
    for (let i = 0; i < 80; i++) {
      await sleep(500);
      st = await (await fetch(base + "/api/state")).json();
      if (!st.running && st.cycleCount > 0) break;
    }
    assert("cycle completes on the subscription engine", st && !st.running && st.cycleCount === 1, JSON.stringify(st && st.agents));
    assert("all 5 agents reached done", ["researcher", "analyst", "reality", "devil", "manager"].every((k) => st.agents[k] && st.agents[k].status === "done"));
    const v = st.verdict || {};
    assert("verdict parsed from fenced JSON text (fallback path)", v.signal === "BUY" && v.conviction === 6 && v.invalidation === "Close below 90", JSON.stringify(v));
    assert("verdict carries live price", v.price_at_verdict > 0);

    const calls = fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const researcher = calls.filter((c) => c.tools === "WebSearch,WebFetch");
    assert("researcher gets WebSearch + WebFetch (auto-allowed)", researcher.length >= 1 && researcher.every((c) => c.allowedTools === "WebSearch,WebFetch"));
    assert("all other agents run with tools disabled", calls.filter((c) => c.tools !== "WebSearch,WebFetch").every((c) => c.tools === ""));
    assert("manager rejection + re-prompt works on this engine", Number(fs.readFileSync(state, "utf8")) >= 5);
    assert("JSON calls pass --json-schema", calls.some((c) => c.hasSchema));
    assert("API key never reaches the CLI (no billing path)", calls.every((c) => !c.sawApiKey));
    assert("nested-session env var stripped", calls.every((c) => !c.sawClaudeCodeEnv));
    assert("agents run in an isolated sandbox folder", calls.every((c) => /wahba-claude-code-sandbox/i.test(c.cwd)), calls[0] && calls[0].cwd);
    assert("prompts go over stdin (large prompts intact)", calls.some((c) => c.promptChars > 3000));
  } finally {
    server.kill();
  }

  // Direct adapter check: multi-turn output must not be glued together.
  process.env.WAHBA_CLAUDE_PATH = fake;
  process.env.FAKE_CLAUDE_MULTI = "1";
  try {
    const cc = require("../claude-code");
    let streamedUi = "";
    const out = await cc.run({ system: "s", prompt: "p", onDelta: (d) => (streamedUi += d) });
    assert("multi-turn text separated (headings render)", streamedUi === "Narration.\n\n# Report", JSON.stringify(streamedUi));
    assert("final report = last turn only", out.text === "# Report", JSON.stringify(out.text));
  } finally {
    delete process.env.FAKE_CLAUDE_MULTI;
  }

  // Logged-out CLI: the app must report offline and refuse cleanly.
  const PORT2 = 3279 + 100;
  const base2 = `http://127.0.0.1:${PORT2}`;
  const server2 = startServer(PORT2, { WAHBA_CLAUDE_PATH: fake, FAKE_CLAUDE_LOGGED_OUT: "1", WAHBA_DATA_DIR: dataDir, WAHBA_PUB_DIR: path.join(tmpBase, "cc-pub") });
  try {
    const h = await waitReady(base2);
    assert("logged-out CLI → AI offline", h.provider === "none" && h.hasKey === false, JSON.stringify(h));
    const r = await fetch(base2 + "/api/cycle", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ticker: "AAPL" }) });
    const b = await r.json();
    assert("cycle refused with login instructions", r.status === 400 && /claude auth login/.test(b.error), b.error);
  } finally {
    server2.kill();
  }
}

main();
