"use strict";
// Claude Code engine: runs the desk's agents through the local Claude Code CLI
// in headless mode, authenticated with the user's Claude subscription login
// (`claude auth login --claudeai`). No Anthropic API key, no per-call billing.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, execFile } = require("child_process");

const SANDBOX = path.join(os.tmpdir(), "wahba-claude-code-sandbox");

// ---------------------------------------------------------------------------
// Locate the CLI: explicit env → PATH → the copy bundled with the Claude desktop app.
// ---------------------------------------------------------------------------
function versionKey(name) {
  return name.split(/[.-]/).map((p) => (/^\d+$/.test(p) ? p.padStart(6, "0") : p)).join(".");
}

function findBundledExe() {
  const root = path.join(process.env.APPDATA || "", "Claude", "claude-code");
  if (!fs.existsSync(root)) return null;
  const versions = fs.readdirSync(root).filter((v) => /^\d/.test(v)).sort((a, b) => (versionKey(a) < versionKey(b) ? 1 : -1));
  for (const v of versions) {
    const vdir = path.join(root, v);
    for (const sub of fs.readdirSync(vdir)) {
      const exe = path.join(vdir, sub, process.platform === "win32" ? "claude.exe" : "claude");
      if (fs.existsSync(exe)) return exe;
    }
  }
  return null;
}

function findOnPath() {
  const names = process.platform === "win32" ? ["claude.exe", "claude.cmd"] : ["claude"];
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    for (const n of names) {
      const p = path.join(dir, n);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

let exeCache = null;
function cliPath() {
  if (exeCache && fs.existsSync(exeCache)) return exeCache;
  const explicit = process.env.WAHBA_CLAUDE_PATH;
  exeCache = (explicit && fs.existsSync(explicit) ? explicit : null) || findOnPath() || findBundledExe();
  return exeCache;
}

// Child env: force subscription auth and avoid nested-session detection.
function childEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k === "ANTHROPIC_API_KEY" || k === "ANTHROPIC_AUTH_TOKEN" || k === "ANTHROPIC_BASE_URL" || k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_")) {
      delete env[k];
    }
  }
  return env;
}

// A .js path (used by the test suite's fake CLI) runs under this Node binary.
function command(exe, args) {
  return /\.m?js$/i.test(exe) ? [process.execPath, [exe, ...args]] : [exe, args];
}

function spawnCli(args) {
  const exe = cliPath();
  if (!exe) throw new Error("Claude Code CLI not found. Install Claude Code or set WAHBA_CLAUDE_PATH.");
  fs.mkdirSync(SANDBOX, { recursive: true });
  const [file, argv] = command(exe, args);
  // .cmd shims need a shell on Windows; the native .exe does not.
  return spawn(file, argv, { cwd: SANDBOX, env: childEnv(), shell: /\.cmd$/i.test(exe), windowsHide: true });
}

// ---------------------------------------------------------------------------
// Login status (cached so availability checks stay instant).
// ---------------------------------------------------------------------------
let status = { checkedAt: 0, loggedIn: false, authMethod: "none" };
let checking = null;

function refreshStatus() {
  if (checking) return checking;
  const exe = cliPath();
  if (!exe) {
    status = { checkedAt: Date.now(), loggedIn: false, authMethod: "none" };
    return Promise.resolve(status);
  }
  checking = new Promise((resolve) => {
    const [file, argv] = command(exe, ["auth", "status", "--json"]);
    execFile(file, argv, { env: childEnv(), cwd: os.tmpdir(), windowsHide: true, timeout: 20000, shell: /\.cmd$/i.test(exe) }, (err, stdout) => {
      let s = { loggedIn: false, authMethod: "none" };
      try {
        s = JSON.parse(stdout);
      } catch {}
      status = { checkedAt: Date.now(), loggedIn: Boolean(s.loggedIn), authMethod: s.authMethod || "none" };
      checking = null;
      resolve(status);
    });
  });
  return checking;
}

function isAvailable() {
  if (Date.now() - status.checkedAt > 30000) refreshStatus();
  return status.loggedIn;
}

let lastModel = null;
function modelLabel() {
  return lastModel || "Claude (subscription)";
}

// ---------------------------------------------------------------------------
// Run one headless turn. Prompt goes over stdin (no command-line length limits).
// ---------------------------------------------------------------------------
function run({ system, prompt, tools = [], jsonSchema = null, onDelta = () => {}, timeoutMs = 10 * 60 * 1000 }) {
  return new Promise((resolve, reject) => {
    const args = [
      "-p",
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--no-session-persistence",
      "--strict-mcp-config",
      "--tools", tools.join(","),
    ];
    if (tools.length) args.push("--allowedTools", tools.join(","));
    if (system) args.push("--system-prompt", system);
    if (jsonSchema) args.push("--json-schema", JSON.stringify(jsonSchema));
    if (process.env.WAHBA_CC_MODEL) args.push("--model", process.env.WAHBA_CC_MODEL);

    let child;
    try {
      child = spawnCli(args);
    } catch (err) {
      return reject(err);
    }

    let buf = "";
    let streamed = "";
    let needSep = false;
    let result = null;
    let stderr = "";
    let settled = false;
    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(val);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(reject, new Error(`Claude Code timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        let evt;
        try {
          evt = JSON.parse(t);
        } catch {
          continue;
        }
        if (evt.type === "system" && evt.subtype === "init" && evt.model) lastModel = evt.model;
        const se = evt.type === "stream_event" && evt.event;
        // Separate text from different turns (e.g. narration between web searches).
        if (se && se.type === "content_block_start" && se.content_block && se.content_block.type === "text") {
          needSep = streamed.length > 0;
        }
        if (se && se.type === "content_block_delta" && se.delta && se.delta.type === "text_delta") {
          let piece = se.delta.text;
          if (needSep) {
            piece = "\n\n" + piece;
            needSep = false;
          }
          streamed += piece;
          onDelta(piece);
        }
        if (evt.type === "result") result = evt;
      }
    });
    child.stderr.on("data", (d) => (stderr += d.toString("utf8")));
    child.on("error", (err) => finish(reject, err));
    child.on("close", (code) => {
      if (!result) {
        return finish(reject, new Error(`Claude Code exited (code ${code}) without a result. ${stderr.slice(-300)}`.trim()));
      }
      if (result.is_error) {
        const msg = String(result.result || result.subtype || "unknown error");
        if (/log ?in/i.test(msg)) status = { checkedAt: Date.now(), loggedIn: false, authMethod: "none" };
        return finish(reject, new Error(`Claude Code: ${msg}`));
      }
      finish(resolve, {
        text: typeof result.result === "string" && result.result.trim() ? result.result : streamed,
        streamed,
        structured: result.structured_output !== undefined ? result.structured_output : null,
        stopReason: result.stop_reason || "end_turn",
      });
    });

    child.stdin.on("error", () => {}); // child may exit early; surfaced via close/result
    child.stdin.end(prompt, "utf8");
  });
}

// Extract a JSON object from model text (fallback when no structured output).
function parseJsonLoose(text) {
  const s = String(text || "").replace(/```(?:json)?/gi, "").trim();
  try {
    return JSON.parse(s);
  } catch {}
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a >= 0 && b > a) return JSON.parse(s.slice(a, b + 1));
  throw new Error("No JSON object found in model output");
}

refreshStatus(); // warm the login cache at startup

module.exports = { cliPath, isAvailable, refreshStatus, run, parseJsonLoose, modelLabel, getStatus: () => status };
