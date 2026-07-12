"use strict";
// The 5 AI agents of the desk, powered by the Anthropic API (Claude Opus 4.8).
//  1. researcher      — web-search agent: real news + real evidence (AmplifyME-style news desk)
//  2. analyst         — "The deep dive" (equity analyst) — prompt card #1
//  3. realityCheck    — "The reality check" (vs peers) — prompt card #2
//  4. devilsAdvocate  — "Devil's advocate" (bear case + invalidation level) — prompt card #3
//  5. manager         — desk manager: validates every output, re-prompts on failure, issues the final trade card

const AnthropicMod = require("@anthropic-ai/sdk");
const Anthropic = AnthropicMod.Anthropic || AnthropicMod.default || AnthropicMod;

const MODEL = process.env.WAHBA_MODEL || "claude-opus-4-8";

let cachedClient = null;
let cachedKey = null;
function getClient() {
  const key = process.env.ANTHROPIC_API_KEY || null;
  if (!cachedClient || cachedKey !== key) {
    cachedClient = key ? new Anthropic({ apiKey: key }) : new Anthropic();
    cachedKey = key;
  }
  return cachedClient;
}

function hasKeyConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

// ---------------------------------------------------------------------------
// System prompts
// ---------------------------------------------------------------------------

const RESEARCHER_SYSTEM = `You are the News & Evidence Researcher on an AI trading desk.
Your job mirrors the news component of a live-markets trading simulation: you watch the tape and the wires so the analysts and the desk manager know what is moving the stock and when the picture changes.
Rules:
- Use web search to verify real, current facts. Prefer primary sources (company filings/IR, exchange data, major financial press).
- Every important number must carry a source and a date. Never invent figures — if something cannot be verified, say "unverified".
- Be direction-oriented: for each piece of news, say whether it argues for buying, selling, or waiting, and why.`;

const ANALYST_SYSTEM = `You are a senior equity analyst on an AI trading desk.
You write institutional-quality deep dives. You are rigorous with numbers and never invent data: you rely on the live market data block and the researcher's evidence pack supplied in the request. If a figure is missing, say so explicitly instead of guessing.`;

const REALITY_SYSTEM = `You are the comparative-valuation specialist on an AI trading desk.
Your specialty is peer analysis: relative growth, margins, and valuation multiples. You are blunt about whether a stock is cheap, fair, or expensive, and you never invent data — you rely on the evidence supplied and clearly flag anything unverified.`;

const DEVIL_SYSTEM = `You are the risk officer / devil's advocate on an AI trading desk.
Your only job is to attack long theses as hard as possible and to define precise invalidation levels. You are adversarial but factual: every attack must be grounded in the supplied data or clearly flagged as a scenario.`;

const MANAGER_SYSTEM = `You are the Desk Manager of an AI trading desk.
You supervise four specialist agents (researcher, equity analyst, peer-comparison specialist, devil's advocate). You validate their work against their briefs, send work back when it is not grounded in evidence, and you alone issue the desk's final trade decision. You are conservative: real money follows your calls, so every price level must trace back to the supplied data.`;

// ---------------------------------------------------------------------------
// The three prompt cards (verbatim from the reference material)
// ---------------------------------------------------------------------------

const CARD_DEEP_DIVE = (t) =>
  `Act as an equity analyst. Give me a full deep dive on ${t}: business model, financials (growth, margins, debt, cash flow), forward outlook, valuation vs its own history, plus key catalysts and risks for the next 6-18 months. End with an overall score from 1-10 and one line explaining it. Use current data.`;

const CARD_REALITY_CHECK = (t) =>
  `Compare ${t} to its 3-4 closest competitors on growth, margins, and valuation multiples. Tell me if it's cheap, fair, or expensive vs the peer group — and whether it's a real value opportunity or a value trap. What has to be true for today's price to make sense?`;

const CARD_DEVILS_ADVOCATE = (t) =>
  `Play devil's advocate on a long position in ${t}. Argue the bear case as hard as you can — what breaks the thesis, what's priced in, what I'm ignoring. Then give me a specific invalidation level: the exact price or condition where the thesis breaks and I should exit.`;

// ---------------------------------------------------------------------------
// Core call helpers
// ---------------------------------------------------------------------------

// Streaming text agent. Handles pause_turn continuation for server-side web search.
async function runAgent({ system, prompt, useWebSearch = false, onDelta = () => {}, maxTokens = 8000 }) {
  const client = getClient();
  const tools = useWebSearch ? [{ type: "web_search_20260209", name: "web_search", max_uses: 6 }] : undefined;
  let messages = [{ role: "user", content: prompt }];
  let fullText = "";

  for (let hop = 0; hop < 6; hop++) {
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      thinking: { type: "adaptive" },
      ...(tools ? { tools } : {}),
      messages,
    });
    stream.on("text", (delta) => {
      fullText += delta;
      onDelta(delta);
    });
    const msg = await stream.finalMessage();
    if (msg.stop_reason === "pause_turn") {
      // Server-side tool loop paused — re-send with the partial assistant turn to resume.
      messages = [...messages, { role: "assistant", content: msg.content }];
      continue;
    }
    return { text: fullText, stopReason: msg.stop_reason };
  }
  return { text: fullText, stopReason: "pause_turn_limit" };
}

// Structured (JSON) agent call for validation / verdict / materiality decisions.
async function runJsonAgent({ system, prompt, schema, maxTokens = 3000, effort = "high" }) {
  const client = getClient();
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    system,
    thinking: { type: "adaptive" },
    output_config: { format: { type: "json_schema", schema }, effort },
    messages: [{ role: "user", content: prompt }],
  });
  if (resp.stop_reason === "refusal") throw new Error("Model refused the request.");
  const text = resp.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  return JSON.parse(text);
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const VALIDATION_SCHEMA = {
  type: "object",
  properties: {
    approved: { type: "boolean", description: "true if the output fulfils the brief and is grounded in the supplied data" },
    quality_score: { type: "integer", description: "1 (unusable) to 10 (excellent)" },
    feedback: { type: "string", description: "If not approved: precise instructions for the re-run. If approved: one-line assessment." },
  },
  required: ["approved", "quality_score", "feedback"],
  additionalProperties: false,
};

const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    signal: { type: "string", enum: ["BUY", "HOLD", "SELL", "AVOID"] },
    conviction: { type: "integer", description: "1-10 conviction in the signal" },
    entry_price: { type: "string", description: "Suggested entry price or zone in the stock's currency, or 'n/a'" },
    target_price: { type: "string", description: "Price target with time horizon, or 'n/a'" },
    invalidation: { type: "string", description: "The devil's advocate's invalidation level: exact price or condition where the thesis breaks and one should exit" },
    time_horizon: { type: "string", description: "e.g. '6-18 months'" },
    summary: { type: "string", description: "4-8 sentence plain-English synthesis of all four agents' findings" },
    key_evidence: { type: "array", items: { type: "string" }, description: "3-6 concrete, sourced facts supporting the signal" },
    key_risks: { type: "array", items: { type: "string" }, description: "3-5 biggest risks from the bear case" },
    agent_agreement: { type: "string", description: "One sentence: where the agents agreed and where they clashed" },
  },
  required: ["signal", "conviction", "entry_price", "target_price", "invalidation", "time_horizon", "summary", "key_evidence", "key_risks", "agent_agreement"],
  additionalProperties: false,
};

const MATERIALITY_SCHEMA = {
  type: "object",
  properties: {
    material: { type: "boolean", description: "true if this news likely moves the stock or changes the thesis" },
    reason: { type: "string" },
    suggested_action: { type: "string", enum: ["NONE", "RE_RUN_ANALYSIS"] },
  },
  required: ["material", "reason", "suggested_action"],
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// Prompt builders — each agent receives the previous agents' output and must
// end with handoff questions, so the agents keep prompting each other.
// ---------------------------------------------------------------------------

const HANDOFF_RULE = (nextAgent) =>
  `\n\nEnd your reply with a section titled "QUESTIONS FOR THE ${nextAgent.toUpperCase()}" containing 2-4 pointed questions the ${nextAgent} must answer. This is how the desk's agents prompt each other.`;

function researcherPrompt(ticker, dataBlock, feedback) {
  return [
    `The desk manager has opened a cycle on ${ticker}. Build the evidence pack the other agents will work from.`,
    "",
    dataBlock,
    "",
    `Tasks (use web search — real, current data only):`,
    `1. Verify the price context above and note anything unusual (gaps, halts, abnormal volume).`,
    `2. Latest reported quarter: revenue growth, margins, EPS vs expectations, and guidance — with source + date.`,
    `3. Current valuation multiples (P/E, forward P/E, EV/EBITDA or P/S as appropriate) and how they compare to the company's own history.`,
    `4. The 3-5 most market-moving news items of the last two weeks: for each, date, source, and whether it argues BUY / SELL / WAIT.`,
    `5. Upcoming catalysts (next earnings date, product events, regulatory decisions, macro prints that matter).`,
    `6. Name the 3-4 closest listed competitors (the reality-check agent will need them) with a headline multiple for each if findable.`,
    "",
    `Finish with a section titled "EVIDENCE PACK" that condenses everything into tight bullet points with sources and dates.`,
    HANDOFF_RULE("equity analyst"),
    feedback ? `\n\nDESK MANAGER FEEDBACK ON YOUR PREVIOUS ATTEMPT — fix all of this:\n${feedback}` : "",
  ].join("\n");
}

function analystPrompt(ticker, dataBlock, researcherOut, feedback) {
  return [
    CARD_DEEP_DIVE(ticker),
    "",
    `"Current data" means ONLY: (a) the live market data block below, and (b) the researcher's evidence pack below. Do not invent figures; flag anything you cannot support.`,
    `You must also answer the researcher's handoff questions.`,
    "",
    dataBlock,
    "",
    `=== RESEARCHER'S REPORT ===\n${researcherOut}`,
    HANDOFF_RULE("peer-comparison specialist"),
    feedback ? `\n\nDESK MANAGER FEEDBACK ON YOUR PREVIOUS ATTEMPT — fix all of this:\n${feedback}` : "",
  ].join("\n");
}

function realityPrompt(ticker, dataBlock, researcherOut, analystOut, feedback) {
  return [
    CARD_REALITY_CHECK(ticker),
    "",
    `Ground every number in the evidence below; flag anything unverified. Answer the equity analyst's handoff questions.`,
    "",
    dataBlock,
    "",
    `=== RESEARCHER'S REPORT ===\n${researcherOut}`,
    "",
    `=== EQUITY ANALYST'S DEEP DIVE ===\n${analystOut}`,
    HANDOFF_RULE("devil's advocate"),
    feedback ? `\n\nDESK MANAGER FEEDBACK ON YOUR PREVIOUS ATTEMPT — fix all of this:\n${feedback}` : "",
  ].join("\n");
}

function devilPrompt(ticker, dataBlock, researcherOut, analystOut, realityOut, feedback) {
  return [
    CARD_DEVILS_ADVOCATE(ticker),
    "",
    `Attack the work below. Answer the peer-comparison specialist's handoff questions. Your invalidation level must reference the live price data (e.g. a concrete price, a moving average, or a dated event).`,
    "",
    dataBlock,
    "",
    `=== RESEARCHER'S REPORT ===\n${researcherOut}`,
    "",
    `=== EQUITY ANALYST'S DEEP DIVE ===\n${analystOut}`,
    "",
    `=== PEER COMPARISON / REALITY CHECK ===\n${realityOut}`,
    `\n\nEnd your reply with a section titled "QUESTIONS FOR THE DESK MANAGER" containing the 2-3 hardest unresolved questions the manager must weigh before issuing a verdict.`,
    feedback ? `\n\nDESK MANAGER FEEDBACK ON YOUR PREVIOUS ATTEMPT — fix all of this:\n${feedback}` : "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Manager operations
// ---------------------------------------------------------------------------

async function validateOutput(role, brief, output) {
  return runJsonAgent({
    system: MANAGER_SYSTEM,
    maxTokens: 1500,
    effort: "low",
    schema: VALIDATION_SCHEMA,
    prompt: [
      `You assigned the ${role} this brief:`,
      `--- BRIEF ---\n${brief}\n--- END BRIEF ---`,
      "",
      `They produced:`,
      `--- OUTPUT ---\n${output}\n--- END OUTPUT ---`,
      "",
      `Judge: (1) does it fulfil every part of the brief, (2) is every number grounded in the supplied data or explicitly sourced/flagged, (3) did it answer the handoff questions and end with its own handoff questions where required.`,
      `Set approved=false ONLY if a re-run with your feedback would materially improve it.`,
    ].join("\n"),
  });
}

async function finalVerdict(ticker, dataBlock, researcherOut, analystOut, realityOut, devilOut) {
  return runJsonAgent({
    system: MANAGER_SYSTEM,
    maxTokens: 4000,
    effort: "high",
    schema: VERDICT_SCHEMA,
    prompt: [
      `All four agents have reported on ${ticker}. Weigh the bull case against the bear case, answer the devil's advocate's questions to you internally, and issue the desk's final trade card.`,
      `Every price level (entry, target, invalidation) must be consistent with the live market data. If the evidence is too weak or conflicting for a directional call, use HOLD or AVOID.`,
      "",
      dataBlock,
      "",
      `=== RESEARCHER ===\n${researcherOut}`,
      "",
      `=== EQUITY ANALYST ===\n${analystOut}`,
      "",
      `=== REALITY CHECK ===\n${realityOut}`,
      "",
      `=== DEVIL'S ADVOCATE ===\n${devilOut}`,
    ].join("\n"),
  });
}

async function assessNews(ticker, headline, verdictContext) {
  return runJsonAgent({
    system: MANAGER_SYSTEM,
    maxTokens: 800,
    effort: "low",
    schema: MATERIALITY_SCHEMA,
    prompt: [
      `Live news just hit the tape for ${ticker}:`,
      `"${headline.title}" (${headline.pubDate || "just now"})`,
      headline.description ? `Summary: ${headline.description}` : "",
      "",
      verdictContext
        ? `The desk's current stance on ${ticker}:\n${verdictContext}`
        : `The desk has no current stance on ${ticker}.`,
      "",
      `Decide if this headline is material — i.e. likely to move the stock or change the desk's thesis (earnings, guidance, M&A, regulatory action, analyst up/downgrades from major banks, litigation, macro shocks). Routine commentary and listicles are NOT material.`,
    ].join("\n"),
  });
}

// ---------------------------------------------------------------------------
// AI Studio — free-form chat about any stock(s), grounded in live data.
// ---------------------------------------------------------------------------

const STUDIO_SYSTEM = `You are the AI Studio analyst on the Wahba Markets trading desk — a conversational market analyst the user can ask anything about stocks, sectors, and the desk's research.
Rules:
- Ground every number in the LIVE MARKET CONTEXT supplied with each message. It is real data. If a figure isn't in the context and you aren't confident, say so rather than inventing it.
- Be direct and practical. Short answers for short questions; deep analysis when asked.
- When comparing stocks, cover growth, momentum, valuation context, and risk — and give a clear bottom line.
- You may reference the desk's latest trade card (verdict) if it is included in the context.
- Always remind users of risk when giving directional views, briefly, without being preachy.`;

async function chatStream({ messages, contextBlock, onDelta = () => {}, maxTokens = 4000 }) {
  const client = getClient();
  const finalMessages = messages.map((m, i) => {
    if (i === messages.length - 1 && m.role === "user" && contextBlock) {
      return { role: "user", content: `${contextBlock}\n\n---\n\nUSER: ${m.content}` };
    }
    return { role: m.role, content: m.content };
  });
  let fullText = "";
  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: maxTokens,
    system: STUDIO_SYSTEM,
    thinking: { type: "adaptive" },
    messages: finalMessages,
  });
  stream.on("text", (delta) => {
    fullText += delta;
    onDelta(delta);
  });
  const msg = await stream.finalMessage();
  return { text: fullText, stopReason: msg.stop_reason };
}

module.exports = {
  MODEL,
  hasKeyConfigured,
  runAgent,
  chatStream,
  validateOutput,
  finalVerdict,
  assessNews,
  prompts: { researcherPrompt, analystPrompt, realityPrompt, devilPrompt },
  systems: {
    researcher: RESEARCHER_SYSTEM,
    analyst: ANALYST_SYSTEM,
    reality: REALITY_SYSTEM,
    devil: DEVIL_SYSTEM,
    manager: MANAGER_SYSTEM,
  },
  cards: { CARD_DEEP_DIVE, CARD_REALITY_CHECK, CARD_DEVILS_ADVOCATE },
};
