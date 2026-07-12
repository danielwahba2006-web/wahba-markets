"use strict";
// Re-price every recorded call against live market data and refresh the public
// scoreboard (no AI, no key needed):
//   node scripts/update-scoreboard.js
//   node scripts/update-scoreboard.js --deploy

const briefMod = require("../brief");

async function main() {
  const sb = await briefMod.publishPublicData((m, l) => console.log(`[${l || "info"}] ${m}`));
  const t = sb.totals;
  console.log(`\nSCOREBOARD: ${t.calls} call(s) tracked, ${t.evaluated} scored.`);
  if (t.winRate != null) console.log(`  win rate ${t.winRate.toFixed(1)}% | avg return ${t.avgReturn.toFixed(2)}% | avg alpha vs SPY ${t.avgAlpha == null ? "n/a" : t.avgAlpha.toFixed(2) + "%"}`);
  if (process.argv.includes("--deploy")) {
    const cfg = briefMod.loadConfig();
    await briefMod.deployToNetlify(cfg.netlifySiteId, (m, l) => console.log(`[${l || "info"}] ${m}`));
  }
}

main().catch((err) => {
  console.error("Scoreboard update failed:", err.message);
  process.exit(1);
});
