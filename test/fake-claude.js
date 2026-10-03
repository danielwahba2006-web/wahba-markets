"use strict";
// Stand-in for the Claude Code CLI used by the test suite. Speaks the same
// headless protocol (`-p --output-format stream-json --include-partial-messages`)
// and records every invocation to FAKE_CLAUDE_LOG for assertions.

const fs = require("fs");

const args = process.argv.slice(2);
const logFile = process.env.FAKE_CLAUDE_LOG;
const stateFile = process.env.FAKE_CLAUDE_STATE;
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

if (args[0] === "auth" && args[1] === "status") {
  const loggedIn = process.env.FAKE_CLAUDE_LOGGED_OUT !== "1";
  out({ loggedIn, authMethod: loggedIn ? "claude.ai" : "none", apiProvider: "firstParty" });
  process.exit(loggedIn ? 0 : 1);
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  const record = {
    tools: flag("--tools"),
    allowedTools: flag("--allowedTools"),
    hasSystem: Boolean(flag("--system-prompt")),
    hasSchema: Boolean(flag("--json-schema")),
    sawApiKey: Boolean(process.env.ANTHROPIC_API_KEY),
    sawClaudeCodeEnv: Boolean(process.env.CLAUDECODE),
    cwd: process.cwd(),
    promptChars: input.length,
  };
  if (logFile) fs.appendFileSync(logFile, JSON.stringify(record) + "\n");

  out({ type: "system", subtype: "init", model: "claude-fake-subscription", tools: (record.tools || "").split(",").filter(Boolean) });

  const blockStart = () => out({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } });
  const delta = (t) => out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } } });

  if (process.env.FAKE_CLAUDE_MULTI === "1") {
    // Two assistant turns (narration, tool call, final report) — like a web-search run.
    blockStart();
    delta("Narration.");
    blockStart();
    delta("# Report");
    out({ type: "result", subtype: "success", is_error: false, result: "# Report", stop_reason: "end_turn" });
    return;
  }

  let text = "";
  let structured;
  if (input.includes("You assigned the")) {
    let n = 0;
    try {
      n = Number(fs.readFileSync(stateFile, "utf8")) || 0;
    } catch {}
    fs.writeFileSync(stateFile, String(n + 1));
    structured =
      n === 0
        ? { approved: false, quality_score: 4, feedback: "FAKE REJECTION: cite sources." }
        : { approved: true, quality_score: 9, feedback: "Good." };
    text = JSON.stringify(structured);
  } else if (input.includes("final trade card")) {
    // No structured_output here on purpose: exercises the text-parsing fallback.
    text =
      "```json\n" +
      JSON.stringify({
        signal: "BUY",
        conviction: 6,
        entry_price: "100 USD",
        target_price: "120 USD",
        invalidation: "Close below 90",
        time_horizon: "6-18 months",
        summary: "Fake subscription verdict.",
        key_evidence: ["e1", "e2", "e3"],
        key_risks: ["r1", "r2", "r3"],
        agent_agreement: "Agreed.",
      }) +
      "\n```";
  } else if (input.includes("material")) {
    structured = { material: false, reason: "Fake: routine.", suggested_action: "NONE" };
    text = JSON.stringify(structured);
  } else {
    text = "FAKE CC REPORT — evidence attached. QUESTIONS FOR THE NEXT AGENT: 1) fake?";
  }

  // Stream the text in chunks like --include-partial-messages does.
  blockStart();
  for (const piece of text.match(/.{1,24}/gs) || []) delta(piece);
  const result = { type: "result", subtype: "success", is_error: false, result: text, stop_reason: "end_turn" };
  if (structured !== undefined) result.structured_output = structured;
  out(result);
});
