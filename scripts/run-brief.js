"use strict";
// Generate today's Morning Brief from the command line (no server needed):
//   node scripts/run-brief.js NVDA AAPL MSFT
//   node scripts/run-brief.js --deploy          (uses the saved watchlist, then deploys)
// Requires ANTHROPIC_API_KEY (env or ../.env).

const path = require("path");
const fs = require("fs");

// load .env like the server does
const envPath = path.join(__dirname, "..", ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const agents = require("../agents");
const briefMod = require("../brief");
const { Orchestrator } = require("../orchestrator");

async function main() {
  if (!agents.hasKeyConfigured()) {
    console.error("No ANTHROPIC_API_KEY configured (set it in .env or the environment).");
    process.exit(1);
  }
  const args = process.argv.slice(2);
  const deploy = args.includes("--deploy");
  const tickers = args.filter((a) => !a.startsWith("--"));
  const cfg = briefMod.loadConfig();
  const list = tickers.length ? tickers : cfg.watchlist;

  const desk = new Orchestrator();
  desk.on("event", (e) => {
    if (e.type === "log") console.log(`[${e.level || "info"}] ${e.message}`);
    if (e.type === "agent") console.log(`  agent ${e.agent}: ${e.status}`);
  });

  const brief = await briefMod.generateBrief({ desk, tickers: list, log: (m, l) => console.log(`[${l || "info"}] ${m}`) });
  briefMod.saveState({ ...briefMod.loadState(), lastBriefDate: briefMod.todayStr() });
  console.log("\nBRIEF:", brief.headline);
  for (const e of brief.entries) console.log(`  ${e.verdict.signal} ${e.ticker} @ ${e.price} (conviction ${e.verdict.conviction}/10)`);

  if (deploy || cfg.autoDeploy) {
    await briefMod.deployToNetlify(cfg.netlifySiteId, (m, l) => console.log(`[${l || "info"}] ${m}`));
  }
}

main().catch((err) => {
  console.error("Brief failed:", err.message);
  process.exit(1);
});
