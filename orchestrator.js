"use strict";
// The desk loop: Manager -> Researcher -> Analyst -> Reality Check -> Devil's Advocate -> Manager verdict.
// Every specialist output is validated by the Manager; failed outputs are re-prompted with feedback.
// A live monitor watches real prices + real news and (optionally) auto-triggers a new cycle on material news.

const { EventEmitter } = require("events");
const market = require("./market");
const agents = require("./agents");

const MONITOR_INTERVAL_MS = 60 * 1000; // real price + news poll
const AUTO_RERUN_COOLDOWN_MS = 10 * 60 * 1000; // don't burn tokens re-running more than every 10 min

class Orchestrator extends EventEmitter {
  constructor() {
    super();
    this.state = {
      running: false,
      ticker: null,
      stage: null,
      cycleCount: 0,
      lastCycleAt: null,
      agents: {}, // key -> { status, note }
      verdict: null,
      verdictTicker: null,
      monitor: { enabled: false, auto: false, ticker: null },
    };
    this._monitorTimer = null;
    this._seenNews = new Set();
    this._lastAutoRun = 0;
    this._log = [];
  }

  send(type, payload = {}) {
    const evt = { type, at: Date.now(), ...payload };
    if (type === "log") {
      this._log.push(evt);
      if (this._log.length > 200) this._log.shift();
    }
    this.emit("event", evt);
  }

  log(message, level = "info") {
    this.send("log", { message, level });
  }

  publicState() {
    return { ...this.state, model: agents.MODEL, hasKey: agents.hasKeyConfigured(), log: this._log.slice(-50) };
  }

  setAgent(key, status, note = "") {
    this.state.agents[key] = { status, note };
    this.send("agent", { agent: key, status, note });
  }

  // Run one specialist with manager validation + one feedback-driven retry.
  async runValidated(key, roleName, briefSummary, execFn) {
    this.setAgent(key, "working", "");
    this.log(`Manager → ${roleName}: prompt dispatched.`);
    let out = await execFn(null);

    this.setAgent(key, "validating", "Manager is reviewing this output…");
    let review = null;
    try {
      review = await agents.validateOutput(roleName, briefSummary, out.text);
    } catch (err) {
      this.log(`Manager validation of ${roleName} failed (${err.message}) — accepting output as-is.`, "warn");
    }

    if (review) {
      this.send("validation", { agent: key, approved: review.approved, score: review.quality_score, feedback: review.feedback });
      if (!review.approved) {
        this.log(`Manager rejected ${roleName}'s output (score ${review.quality_score}/10). Re-prompting with feedback.`, "warn");
        this.setAgent(key, "retry", review.feedback);
        this.send("agent_reset", { agent: key });
        out = await execFn(review.feedback);
        this.setAgent(key, "validating", "Manager is reviewing the re-run…");
        try {
          const second = await agents.validateOutput(roleName, briefSummary, out.text);
          this.send("validation", { agent: key, approved: second.approved, score: second.quality_score, feedback: second.feedback, attempt: 2 });
          if (!second.approved) this.log(`Manager still unsatisfied with ${roleName} (score ${second.quality_score}/10) — proceeding with best effort.`, "warn");
        } catch {
          /* accept */
        }
      } else {
        this.log(`Manager approved ${roleName}'s output (score ${review.quality_score}/10).`);
      }
    }

    this.setAgent(key, "done", review ? `Manager score: ${review.quality_score}/10` : "");
    return out.text;
  }

  async runCycle(ticker, trigger = "manual") {
    if (this.state.running) throw new Error(`A cycle is already running on ${this.state.ticker}.`);
    ticker = ticker.trim().toUpperCase();

    this.state.running = true;
    this.state.ticker = ticker;
    this.state.verdict = null;
    this.state.agents = {};
    for (const k of ["researcher", "analyst", "reality", "devil", "manager"]) this.setAgent(k, "queued", "");
    this.send("cycle_start", { ticker, trigger });
    this.log(`=== Cycle #${this.state.cycleCount + 1} opened on ${ticker} (${trigger}) ===`);

    try {
      // 0. Real market data + real news
      this.state.stage = "data";
      this.send("stage", { stage: "data" });
      this.log(`Pulling live market data and news feed for ${ticker}…`);
      const [snap, headlines] = await Promise.all([market.snapshot(ticker), market.news(ticker).catch(() => [])]);
      headlines.forEach((h) => this._seenNews.add(h.id));
      const dataBlock = market.describeSnapshot(snap, headlines);
      this.send("price", { snapshot: snap });
      this.send("news", { items: headlines, ticker });
      this.log(`Live data locked: ${snap.symbol} @ ${snap.price} ${snap.currency} (${headlines.length} headlines).`);

      const onDelta = (agent) => (delta) => this.send("delta", { agent, text: delta });

      // 1. Researcher (web search — real evidence)
      this.state.stage = "researcher";
      this.send("stage", { stage: "researcher" });
      const researcherOut = await this.runValidated(
        "researcher",
        "News & Evidence Researcher",
        "Build a sourced, dated evidence pack: verify price context, latest earnings, valuation multiples, market-moving news with buy/sell/wait direction, upcoming catalysts, and 3-4 closest competitors. End with an EVIDENCE PACK and handoff questions for the equity analyst.",
        (feedback) =>
          agents.runAgent({
            system: agents.systems.researcher,
            prompt: agents.prompts.researcherPrompt(ticker, dataBlock, feedback),
            useWebSearch: true,
            maxTokens: 10000,
            onDelta: onDelta("researcher"),
          })
      );

      // 2. Equity analyst (deep dive card)
      this.state.stage = "analyst";
      this.send("stage", { stage: "analyst" });
      const analystOut = await this.runValidated(
        "analyst",
        "Equity Analyst",
        agents.cards.CARD_DEEP_DIVE(ticker) + " Must use only the supplied live data + evidence pack, answer the researcher's handoff questions, and end with handoff questions for the peer-comparison specialist.",
        (feedback) =>
          agents.runAgent({
            system: agents.systems.analyst,
            prompt: agents.prompts.analystPrompt(ticker, dataBlock, researcherOut, feedback),
            maxTokens: 9000,
            onDelta: onDelta("analyst"),
          })
      );

      // 3. Reality check (peer comparison card)
      this.state.stage = "reality";
      this.send("stage", { stage: "reality" });
      const realityOut = await this.runValidated(
        "reality",
        "Peer-Comparison Specialist (Reality Check)",
        agents.cards.CARD_REALITY_CHECK(ticker) + " Must ground every number in the supplied evidence, answer the analyst's handoff questions, and end with handoff questions for the devil's advocate.",
        (feedback) =>
          agents.runAgent({
            system: agents.systems.reality,
            prompt: agents.prompts.realityPrompt(ticker, dataBlock, researcherOut, analystOut, feedback),
            maxTokens: 8000,
            onDelta: onDelta("reality"),
          })
      );

      // 4. Devil's advocate (bear case card)
      this.state.stage = "devil";
      this.send("stage", { stage: "devil" });
      const devilOut = await this.runValidated(
        "devil",
        "Devil's Advocate",
        agents.cards.CARD_DEVILS_ADVOCATE(ticker) + " Must answer the reality-check agent's handoff questions and end with the hardest questions for the desk manager.",
        (feedback) =>
          agents.runAgent({
            system: agents.systems.devil,
            prompt: agents.prompts.devilPrompt(ticker, dataBlock, researcherOut, analystOut, realityOut, feedback),
            maxTokens: 8000,
            onDelta: onDelta("devil"),
          })
      );

      // 5. Manager verdict
      this.state.stage = "manager";
      this.send("stage", { stage: "manager" });
      this.setAgent("manager", "working", "Weighing bull vs bear, issuing the trade card…");
      this.log("Manager is weighing all four reports and issuing the final trade card…");
      const verdict = await agents.finalVerdict(ticker, dataBlock, researcherOut, analystOut, realityOut, devilOut);
      verdict.ticker = ticker;
      verdict.price_at_verdict = snap.price;
      verdict.currency = snap.currency;
      verdict.issued_at = Date.now();

      this.state.verdict = verdict;
      this.state.verdictTicker = ticker;
      this.setAgent("manager", "done", `Signal: ${verdict.signal} (${verdict.conviction}/10)`);
      this.send("verdict", { verdict });
      this.log(`=== VERDICT: ${verdict.signal} ${ticker} — conviction ${verdict.conviction}/10. Invalidation: ${verdict.invalidation} ===`);

      this.state.cycleCount += 1;
      this.state.lastCycleAt = Date.now();
      this.send("cycle_done", { ticker, verdict });
      return verdict;
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      this.log(`Cycle failed: ${message}`, "error");
      if (this.state.stage && this.state.agents[this.state.stage]) this.setAgent(this.state.stage, "error", message);
      this.send("cycle_error", { ticker, message });
      throw err;
    } finally {
      this.state.running = false;
      this.state.stage = null;
    }
  }

  // ------------------------------------------------------------------
  // Live monitor: real prices every minute + real news; the manager
  // triages fresh headlines and can auto-trigger a new analysis cycle.
  // ------------------------------------------------------------------
  startMonitor(ticker, { auto = false } = {}) {
    this.stopMonitor(false);
    ticker = ticker.trim().toUpperCase();
    this.state.monitor = { enabled: true, auto, ticker };
    this.send("monitor", { ...this.state.monitor });
    this.log(`Live monitor started on ${ticker} (auto re-run: ${auto ? "ON" : "OFF"}, poll: ${MONITOR_INTERVAL_MS / 1000}s).`);

    const tick = async () => {
      try {
        const quote = await market.intraday(ticker);
        this.send("price_tick", { quote });
      } catch (err) {
        this.log(`Monitor price poll failed: ${err.message}`, "warn");
      }
      try {
        const items = await market.news(ticker);
        const fresh = items.filter((h) => !this._seenNews.has(h.id));
        if (fresh.length) {
          fresh.forEach((h) => this._seenNews.add(h.id));
          this.send("news", { items, ticker, freshIds: fresh.map((f) => f.id) });
          this.log(`${fresh.length} new headline(s) on the tape for ${ticker}.`);
          await this.triageNews(ticker, fresh);
        }
      } catch (err) {
        this.log(`Monitor news poll failed: ${err.message}`, "warn");
      }
    };

    tick();
    this._monitorTimer = setInterval(tick, MONITOR_INTERVAL_MS);
  }

  async triageNews(ticker, freshItems) {
    if (!agents.hasKeyConfigured()) return; // can't triage without the AI
    if (this.state.running) return;
    const verdictContext =
      this.state.verdict && this.state.verdictTicker === ticker
        ? `${this.state.verdict.signal} (conviction ${this.state.verdict.conviction}/10). Invalidation: ${this.state.verdict.invalidation}`
        : null;
    for (const h of freshItems.slice(0, 3)) {
      try {
        const call = await agents.assessNews(ticker, h, verdictContext);
        this.send("news_triage", { headline: h, ...call });
        this.log(`Manager on "${h.title.slice(0, 80)}…": ${call.material ? "MATERIAL" : "not material"} — ${call.reason}`, call.material ? "warn" : "info");
        if (call.material && call.suggested_action === "RE_RUN_ANALYSIS" && this.state.monitor.auto) {
          const now = Date.now();
          if (now - this._lastAutoRun > AUTO_RERUN_COOLDOWN_MS && !this.state.running) {
            this._lastAutoRun = now;
            this.log(`Material news — auto re-running the full analysis cycle on ${ticker}.`, "warn");
            this.runCycle(ticker, "news-trigger").catch(() => {});
          } else {
            this.log("Material news, but auto re-run is on cooldown or a cycle is running.", "warn");
          }
          break;
        }
      } catch (err) {
        this.log(`News triage failed: ${err.message}`, "warn");
      }
    }
  }

  stopMonitor(announce = true) {
    if (this._monitorTimer) clearInterval(this._monitorTimer);
    this._monitorTimer = null;
    if (this.state.monitor.enabled && announce) this.log(`Live monitor stopped.`);
    this.state.monitor = { enabled: false, auto: false, ticker: null };
    if (announce) this.send("monitor", { ...this.state.monitor });
  }
}

module.exports = { Orchestrator };
