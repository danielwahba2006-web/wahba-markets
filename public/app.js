"use strict";
/* Wahba Markets — AI Trading Desk (frontend) */

const $ = (id) => document.getElementById(id);
const agentsList = ["researcher", "analyst", "reality", "devil", "manager"];
const agentText = { researcher: "", analyst: "", reality: "", devil: "", manager: "" };
let currentTicker = "";
let lastSnapshot = null;
let renderTimers = {};
let chartRange = "1D"; // 1D (live) or 1Y
let intradayData = null; // { series, prevClose }
let tickTimer = null;
let tickMs = 1000; // 1-second live updates locally; relaxed on serverless hosting
let platform = "local";
const chatHistory = [];
let studioTickers = [];
let sp500 = [];

// ---------------------------------------------------------------------------
// Tiny markdown renderer (headers, bold, italics, code, lists, tables)
// ---------------------------------------------------------------------------
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function renderMarkdown(md) {
  const lines = escapeHtml(md).split("\n");
  const out = [];
  let inUl = false, inOl = false, inTable = false;
  const closeLists = () => {
    if (inUl) { out.push("</ul>"); inUl = false; }
    if (inOl) { out.push("</ol>"); inOl = false; }
    if (inTable) { out.push("</table>"); inTable = false; }
  };
  const inline = (s) =>
    s
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>");

  for (const raw of lines) {
    const line = raw.trimEnd();
    const h = line.match(/^(#{1,4})\s+(.*)/);
    if (h) { closeLists(); out.push(`<h${h[1].length + 1}>${inline(h[2])}</h${h[1].length + 1}>`); continue; }
    if (/^\s*\|/.test(line)) {
      if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue; // separator row
      if (!inTable) { closeLists(); out.push("<table>"); inTable = true; }
      const cells = line.replace(/^\s*\||\|\s*$/g, "").split("|").map((c) => inline(c.trim()));
      out.push("<tr>" + cells.map((c) => `<td>${c}</td>`).join("") + "</tr>");
      continue;
    }
    if (inTable) { out.push("</table>"); inTable = false; }
    const ul = line.match(/^\s*[-*•]\s+(.*)/);
    if (ul) { if (!inUl) { closeLists(); out.push("<ul>"); inUl = true; } out.push(`<li>${inline(ul[1])}</li>`); continue; }
    const ol = line.match(/^\s*\d+[.)]\s+(.*)/);
    if (ol) { if (!inOl) { closeLists(); out.push("<ol>"); inOl = true; } out.push(`<li>${inline(ol[1])}</li>`); continue; }
    closeLists();
    if (line.trim() === "") continue;
    out.push(`<p>${inline(line)}</p>`);
  }
  closeLists();
  return out.join("\n");
}

// Throttled render of streaming agent output
function scheduleRender(agent) {
  if (renderTimers[agent]) return;
  renderTimers[agent] = setTimeout(() => {
    renderTimers[agent] = null;
    const el = $("out-" + agent);
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    el.innerHTML = renderMarkdown(agentText[agent]);
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, 180);
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------
const fmt = (v, d = 2) => (v == null || isNaN(v) ? "—" : Number(v).toFixed(d));
const fmtBig = (v) => (v == null ? "—" : Number(v).toLocaleString());
const pctClass = (v) => (v == null ? "" : v >= 0 ? "up" : "down");
const pctStr = (v) => (v == null ? "—" : (v >= 0 ? "+" : "") + Number(v).toFixed(2) + "%");
function timeAgo(dateStr) {
  const t = new Date(dateStr).getTime();
  if (isNaN(t)) return dateStr || "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 90) return "just now";
  if (s < 3600) return Math.round(s / 60) + "m ago";
  if (s < 86400) return Math.round(s / 3600) + "h ago";
  return Math.round(s / 86400) + "d ago";
}

// ---------------------------------------------------------------------------
// Market data rendering
// ---------------------------------------------------------------------------
function renderSnapshot(s) {
  lastSnapshot = s;
  currentTicker = s.symbol;
  $("tickerInput").value = s.symbol;
  $("pTicker").textContent = s.symbol;
  $("pName").textContent = `${s.name} · ${s.exchange}`;
  $("pPrice").textContent = `${fmt(s.price)} ${s.currency}`;
  const chg = $("pChange");
  chg.textContent = `${pctStr(s.changePct)}  (prev ${fmt(s.prevClose)})`;
  chg.className = "price-chg " + pctClass(s.changePct);

  const rows = [
    ["Day range", `${fmt(s.dayLow)} – ${fmt(s.dayHigh)}`],
    ["52-wk range", `${fmt(s.lo52)} – ${fmt(s.hi52)}`],
    ["Volume", fmtBig(s.volume)],
    ["Avg vol (3m)", fmtBig(s.avgVolume3m)],
    ["50-day MA", fmt(s.ma50)],
    ["200-day MA", fmt(s.ma200)],
    ["1w / 1m", `${pctStr(s.perf1w)} / ${pctStr(s.perf1m)}`],
    ["3m / 1y", `${pctStr(s.perf3m)} / ${pctStr(s.perf1y)}`],
  ];
  $("pStats").innerHTML = rows
    .map(([k, v]) => `<div class="row"><span class="k">${k}</span><span class="v">${v}</span></div>`)
    .join("");

  redrawChart();
}

function redrawChart() {
  if (chartRange === "1D" && intradayData && intradayData.series.length) {
    drawChart(intradayData.series, intradayData.prevClose);
  } else if (lastSnapshot) {
    drawChart(lastSnapshot.series || []);
  }
}

function drawChart(series, refValue) {
  const canvas = $("chart");
  const ctx = canvas.getContext("2d");
  const W = (canvas.width = canvas.clientWidth * 2);
  const H = (canvas.height = 280);
  ctx.clearRect(0, 0, W, H);
  if (!series.length) return;
  const closes = series.map((p) => p.c);
  const min = Math.min(...closes), max = Math.max(...closes);
  const pad = (max - min) * 0.08 || Math.max(closes[0] * 0.002, 0.01);
  const y = (v) => H - ((v - (min - pad)) / (max - min + 2 * pad)) * H;
  const x = (i) => (closes.length === 1 ? 0 : (i / (closes.length - 1)) * W);

  const ref = refValue != null ? refValue : closes[0];
  const up = closes[closes.length - 1] >= ref;
  const color = up ? "#4ade80" : "#f87171";

  // reference line (previous close) for intraday view
  if (refValue != null && refValue > min - pad && refValue < max + pad) {
    ctx.beginPath();
    ctx.setLineDash([6, 6]);
    ctx.moveTo(0, y(refValue));
    ctx.lineTo(W, y(refValue));
    ctx.strokeStyle = "#3a4f40";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.setLineDash([]);
  }

  ctx.beginPath();
  closes.forEach((c, i) => (i ? ctx.lineTo(x(i), y(c)) : ctx.moveTo(x(i), y(c))));
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5;
  ctx.stroke();

  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, up ? "rgba(74,222,128,.25)" : "rgba(248,113,113,.25)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.fillStyle = "#55684f";
  ctx.font = "20px ui-monospace";
  ctx.fillText(fmt(max), 8, 24);
  ctx.fillText(fmt(min), 8, H - 10);
}

function renderNews(items, freshIds = []) {
  const list = $("newsList");
  if (!items || !items.length) {
    list.innerHTML = `<div class="empty">No headlines available for this ticker.</div>`;
    return;
  }
  list.innerHTML = items
    .map((h) => {
      const fresh = freshIds.includes(h.id) ? " fresh" : "";
      return `<div class="news-item${fresh}" data-id="${encodeURIComponent(h.id)}">
        <a href="${h.link || "#"}" target="_blank" rel="noopener">${escapeHtml(h.title)}</a>
        <div class="news-meta"><span>${timeAgo(h.pubDate)}</span><span class="triage"></span></div>
      </div>`;
    })
    .join("");
}

function markTriage(headline, material, reason) {
  const el = document.querySelector(`.news-item[data-id="${encodeURIComponent(headline.id)}"] .triage`);
  if (!el) return;
  el.innerHTML = material
    ? `<span class="badge-material" title="${escapeHtml(reason)}">MATERIAL</span>`
    : `<span class="badge-notmaterial" title="${escapeHtml(reason)}">not material</span>`;
}

// ---------------------------------------------------------------------------
// Agents / verdict rendering
// ---------------------------------------------------------------------------
function setAgentStatus(agent, status, note) {
  const badge = $("status-" + agent);
  if (badge) { badge.textContent = status; badge.className = "status " + status; }
  const card = $("card-" + agent);
  if (card) card.classList.toggle("active", status === "working" || status === "validating" || status === "retry");
  const noteEl = $("note-" + agent);
  if (noteEl) {
    if (note) { noteEl.textContent = "Manager: " + note; noteEl.hidden = false; }
    else noteEl.hidden = true;
  }
}

function resetAgents() {
  for (const a of agentsList) {
    agentText[a] = "";
    const out = $("out-" + a);
    if (out) out.innerHTML = "";
    setAgentStatus(a, "queued", "");
  }
  $("verdictPanel").innerHTML = `<div class="empty">Cycle running…</div>`;
}

function renderVerdict(v) {
  const rows = [
    ["Ticker", `${v.ticker} @ ${fmt(v.price_at_verdict)} ${v.currency || ""}`],
    ["Entry", v.entry_price],
    ["Target", v.target_price],
    ["Invalidation / exit", v.invalidation],
    ["Horizon", v.time_horizon],
  ];
  $("verdictPanel").innerHTML = `
    <div class="signal-row">
      <span class="signal ${v.signal}">${v.signal}</span>
      <span class="conviction">conviction<br/><strong>${v.conviction}/10</strong></span>
    </div>
    <div class="verdict-grid">
      ${rows.map(([k, val]) => `<div class="row"><span class="k">${k}</span><span class="v">${escapeHtml(String(val || "—"))}</span></div>`).join("")}
    </div>
    <div class="verdict-summary">${escapeHtml(v.summary || "")}</div>
    <div class="verdict-section">KEY EVIDENCE</div>
    <ul class="verdict-list">${(v.key_evidence || []).map((e) => `<li>${escapeHtml(e)}</li>`).join("")}</ul>
    <div class="verdict-section">KEY RISKS</div>
    <ul class="verdict-list risks">${(v.key_risks || []).map((e) => `<li>${escapeHtml(e)}</li>`).join("")}</ul>
    <div class="verdict-agreement">${escapeHtml(v.agent_agreement || "")}</div>
    <div class="verdict-ts">issued ${new Date(v.issued_at || Date.now()).toLocaleString()}</div>
  `;
}

function addLog(message, level = "info", at = Date.now()) {
  const el = document.createElement("div");
  el.className = "log-line " + level;
  const t = new Date(at).toLocaleTimeString();
  el.innerHTML = `<span class="t">${t}</span>${escapeHtml(message)}`;
  const list = $("logList");
  list.prepend(el);
  while (list.children.length > 150) list.removeChild(list.lastChild);
}

function setCycleStatus(text, running) {
  const el = $("cycleStatus");
  el.textContent = text;
  el.classList.toggle("running", Boolean(running));
  $("runBtn").disabled = Boolean(running);
}

function setKeyPill(hasKey) {
  const pill = $("keyPill");
  pill.classList.toggle("ok", hasKey);
  $("keyPillText").textContent = hasKey ? "AI ONLINE" : "NO KEY";
}

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------
function connectEvents() {
  const es = new EventSource("/api/events");
  es.onmessage = (m) => {
    let evt;
    try { evt = JSON.parse(m.data); } catch { return; }
    switch (evt.type) {
      case "state": {
        const st = evt.state;
        setKeyPill(st.hasKey);
        $("modelBadge").textContent = st.model;
        if (st.monitor && st.monitor.enabled) {
          $("monitorToggle").checked = true;
          $("autoToggle").checked = st.monitor.auto;
          $("liveTag").hidden = false;
        }
        (st.log || []).forEach((l) => addLog(l.message, l.level, l.at));
        if (st.verdict) renderVerdict(st.verdict);
        setCycleStatus(st.running ? `running: ${st.ticker} / ${st.stage || "…"}` : "idle", st.running);
        break;
      }
      case "cycle_start":
        resetAgents();
        setCycleStatus(`running: ${evt.ticker}`, true);
        break;
      case "stage":
        setCycleStatus(`running: ${currentTicker} / ${evt.stage}`, true);
        break;
      case "agent":
        setAgentStatus(evt.agent, evt.status, evt.note);
        break;
      case "agent_reset":
        agentText[evt.agent] = "";
        { const o = $("out-" + evt.agent); if (o) o.innerHTML = ""; }
        break;
      case "delta":
        agentText[evt.agent] += evt.text;
        scheduleRender(evt.agent);
        break;
      case "validation":
        addLog(
          `Manager ${evt.approved ? "APPROVED" : "REJECTED"} ${evt.agent} (score ${evt.score}/10)${evt.approved ? "" : " — " + evt.feedback}`,
          evt.approved ? "info" : "warn",
          evt.at
        );
        break;
      case "price":
        renderSnapshot(evt.snapshot);
        break;
      case "price_tick": {
        const q = evt.quote;
        if (lastSnapshot && q.symbol === lastSnapshot.symbol && q.price != null) {
          $("pPrice").textContent = `${fmt(q.price)} ${lastSnapshot.currency}`;
          const chg = $("pChange");
          chg.textContent = `${pctStr(q.changePct)}  (prev ${fmt(q.prevClose)})`;
          chg.className = "price-chg " + pctClass(q.changePct);
        }
        break;
      }
      case "news":
        renderNews(evt.items, evt.freshIds || []);
        break;
      case "news_triage":
        markTriage(evt.headline, evt.material, evt.reason);
        break;
      case "verdict":
        renderVerdict(evt.verdict);
        break;
      case "cycle_done":
        setCycleStatus("idle — cycle complete", false);
        break;
      case "cycle_error":
        setCycleStatus("error", false);
        addLog(`Cycle error: ${evt.message}`, "error", evt.at);
        break;
      case "monitor":
        $("liveTag").hidden = !evt.enabled;
        $("monitorToggle").checked = Boolean(evt.enabled);
        $("autoToggle").checked = Boolean(evt.auto);
        break;
      case "log":
        addLog(evt.message, evt.level, evt.at);
        break;
    }
  };
  es.onerror = () => {
    setTimeout(() => { es.close(); connectEvents(); }, 4000);
  };
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
async function api(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function loadTicker(symbol) {
  const t = (symbol || $("tickerInput").value).trim().toUpperCase();
  if (!t) return;
  $("tickerInput").value = t;
  $("loadBtn").disabled = true;
  try {
    const [snap, intra, news] = await Promise.all([
      api(`/api/snapshot/${encodeURIComponent(t)}`),
      api(`/api/intraday/${encodeURIComponent(t)}`).catch(() => null),
      api(`/api/news/${encodeURIComponent(t)}`).catch(() => []),
    ]);
    intradayData = intra;
    renderSnapshot(snap);
    renderNews(news);
    setStudioContext([snap.symbol]);
    startTickLoop(snap.symbol);
    addLog(`Loaded live market data for ${snap.symbol}: ${fmt(snap.price)} ${snap.currency} (${pctStr(snap.changePct)}).`);
  } catch (err) {
    addLog(`Failed to load ${t}: ${err.message}`, "error");
    alert(`Could not load "${t}": ${err.message}`);
  } finally {
    $("loadBtn").disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Live tick loop — real quote polled every second, chart updated in place
// ---------------------------------------------------------------------------
function startTickLoop(symbol) {
  if (tickTimer) clearInterval(tickTimer);
  let inFlight = false;
  const tick = async () => {
    if (inFlight || document.hidden) return;
    inFlight = true;
    try {
      const q = await api(`/api/tick/${encodeURIComponent(symbol)}`);
      if (lastSnapshot && q.symbol === lastSnapshot.symbol && q.price != null) {
        $("pPrice").textContent = `${fmt(q.price)} ${lastSnapshot.currency}`;
        const chg = $("pChange");
        chg.textContent = `${pctStr(q.changePct)}  (prev ${fmt(q.prevClose)})`;
        chg.className = "price-chg " + pctClass(q.changePct);
        const info = $("tickInfo");
        info.textContent = `● live ${new Date().toLocaleTimeString()} (${q.marketState || "…"})`;
        info.className = "tick-info live";
        if (intradayData && intradayData.series) {
          const s = intradayData.series;
          const last = s[s.length - 1];
          if (!last || last.c !== q.price || Date.now() - last.t > 15000) {
            s.push({ t: Date.now(), c: q.price });
            if (s.length > 2500) s.splice(0, s.length - 2500);
            if (chartRange === "1D") redrawChart();
          }
        }
      }
    } catch {
      const info = $("tickInfo");
      info.textContent = "tick paused (network)";
      info.className = "tick-info";
    } finally {
      inFlight = false;
    }
  };
  tick();
  tickTimer = setInterval(tick, tickMs);
}

async function runCycle() {
  const t = $("tickerInput").value.trim().toUpperCase();
  if (!t) return alert("Enter a ticker first.");
  try {
    await api("/api/cycle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticker: t }),
    });
  } catch (err) {
    addLog(`Could not start cycle: ${err.message}`, "error");
    alert(err.message);
  }
}

async function updateMonitor() {
  const enabled = $("monitorToggle").checked;
  const auto = $("autoToggle").checked;
  const t = $("tickerInput").value.trim().toUpperCase();
  if (enabled && !t) {
    $("monitorToggle").checked = false;
    return alert("Enter a ticker to monitor.");
  }
  try {
    await api("/api/monitor", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled, ticker: t, auto }),
    });
  } catch (err) {
    addLog(`Monitor error: ${err.message}`, "error");
  }
}

// Ticker search dropdown
let searchTimer = null;
$("tickerInput").addEventListener("input", () => {
  clearTimeout(searchTimer);
  const q = $("tickerInput").value.trim();
  if (q.length < 2) { $("searchResults").hidden = true; return; }
  searchTimer = setTimeout(async () => {
    try {
      const results = await api(`/api/search?q=${encodeURIComponent(q)}`);
      const box = $("searchResults");
      if (!results.length) { box.hidden = true; return; }
      box.innerHTML = results
        .map((r) => `<div data-sym="${escapeHtml(r.symbol)}"><span class="sym">${escapeHtml(r.symbol)}</span><span class="nm">${escapeHtml(r.name)} · ${escapeHtml(r.exchange)}</span></div>`)
        .join("");
      box.hidden = false;
      box.querySelectorAll("div[data-sym]").forEach((el) =>
        el.addEventListener("mousedown", () => {
          $("tickerInput").value = el.dataset.sym;
          box.hidden = true;
          loadTicker();
        })
      );
    } catch { /* ignore */ }
  }, 300);
});
document.addEventListener("click", (e) => {
  if (!e.target.closest(".ticker-box")) $("searchResults").hidden = true;
});

$("tickerInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { $("searchResults").hidden = true; loadTicker(); }
});
$("loadBtn").addEventListener("click", () => loadTicker());
$("runBtn").addEventListener("click", runCycle);
$("monitorToggle").addEventListener("change", updateMonitor);
$("autoToggle").addEventListener("change", () => { if ($("monitorToggle").checked) updateMonitor(); });

$("settingsBtn").addEventListener("click", () => {
  $("settingsPanel").hidden = !$("settingsPanel").hidden;
});
$("saveKeyBtn").addEventListener("click", async () => {
  const key = $("apiKeyInput").value.trim();
  if (!key) return;
  try {
    await api("/api/key", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ apiKey: key }) });
    $("apiKeyInput").value = "";
    setKeyPill(true);
    addLog("API key saved.");
  } catch (err) {
    alert("Failed to save key: " + err.message);
  }
});
$("testAiBtn").addEventListener("click", async () => {
  const out = $("testAiResult");
  out.textContent = "testing…";
  out.className = "test-result";
  try {
    const r = await api("/api/test-ai", { method: "POST" });
    out.textContent = `✓ ${r.model}: "${r.reply}"`;
    out.className = "test-result ok";
  } catch (err) {
    out.textContent = "✗ " + err.message;
    out.className = "test-result err";
  }
});

// Toggle agent card collapse on header click
document.querySelectorAll(".agent-head").forEach((head) => {
  head.addEventListener("click", () => {
    const out = head.parentElement.querySelector(".agent-output");
    if (out) out.style.display = out.style.display === "none" ? "" : "none";
  });
});

// ---------------------------------------------------------------------------
// Chart range tabs (1D live / 1Y)
// ---------------------------------------------------------------------------
document.querySelectorAll(".range-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".range-tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    chartRange = tab.dataset.range;
    redrawChart();
  });
});

// ---------------------------------------------------------------------------
// Right column tabs (trade card / AI studio / log)
// ---------------------------------------------------------------------------
function switchTab(name) {
  document.querySelectorAll(".right-tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  for (const pane of ["verdict", "studio", "log"]) $("tab-" + pane).hidden = pane !== name;
}
document.querySelectorAll(".right-tab").forEach((t) => t.addEventListener("click", () => switchTab(t.dataset.tab)));

// ---------------------------------------------------------------------------
// AI STUDIO — chat about any stock, grounded in live data
// ---------------------------------------------------------------------------
function setStudioContext(tickers) {
  studioTickers = tickers.filter(Boolean).slice(0, 2);
  $("chatContext").textContent = "context: " + (studioTickers.length ? studioTickers.join(" + ") + " (live data attached to each message)" : "—");
}

function addChatMsg(role, text) {
  const el = document.createElement("div");
  el.className = "chat-msg " + role;
  if (role === "user") el.textContent = text;
  else el.innerHTML = renderMarkdown(text);
  const list = $("chatList");
  list.appendChild(el);
  list.scrollTop = list.scrollHeight;
  return el;
}

let chatBusy = false;
async function sendChat(presetText) {
  if (chatBusy) return;
  const input = $("chatInput");
  const text = (presetText != null ? presetText : input.value).trim();
  if (!text) return;
  if (presetText == null) input.value = "";
  chatBusy = true;
  $("chatSendBtn").disabled = true;

  chatHistory.push({ role: "user", content: text });
  addChatMsg("user", text);
  const aiEl = addChatMsg("ai", "");
  aiEl.classList.add("streaming");

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: chatHistory, tickers: studioTickers }),
    });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      throw new Error(e.error || `HTTP ${res.status}`);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let full = "";
    const list = $("chatList");
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      full += dec.decode(value, { stream: true });
      aiEl.innerHTML = renderMarkdown(full);
      list.scrollTop = list.scrollHeight;
    }
    aiEl.classList.remove("streaming");
    chatHistory.push({ role: "assistant", content: full });
    if (chatHistory.length > 24) chatHistory.splice(0, chatHistory.length - 24);
  } catch (err) {
    aiEl.classList.remove("streaming");
    aiEl.classList.add("err");
    aiEl.textContent = "Error: " + err.message;
    chatHistory.pop(); // drop the failed user turn so history stays valid
  } finally {
    chatBusy = false;
    $("chatSendBtn").disabled = false;
  }
}
$("chatSendBtn").addEventListener("click", () => sendChat());
$("chatInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendChat();
  }
});

// ---------------------------------------------------------------------------
// S&P 500 browser — every constituent, clickable
// ---------------------------------------------------------------------------
async function ensureSp500() {
  if (sp500.length) return;
  sp500 = await api("/sp500.json");
  const sectors = [...new Set(sp500.map((r) => r.sec))].sort();
  $("spSector").innerHTML =
    `<option value="">All sectors</option>` + sectors.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join("");
}

function renderSpList() {
  const q = $("spFilter").value.trim().toUpperCase();
  const sec = $("spSector").value;
  const rows = sp500.filter(
    (r) => (!sec || r.sec === sec) && (!q || r.s.toUpperCase().includes(q) || r.n.toUpperCase().includes(q))
  );
  $("spCount").textContent = `${rows.length} of ${sp500.length} constituents`;
  $("spList").innerHTML = rows
    .map(
      (r) =>
        `<div class="sp-row" data-sym="${escapeHtml(r.s)}">
          <span class="sym">${escapeHtml(r.s)}</span>
          <span class="nm">${escapeHtml(r.n)}</span>
          <span class="sec">${escapeHtml(r.sec)}</span>
          <span class="cmp-add" data-cmp="${escapeHtml(r.s)}" title="Add to compare">+cmp</span>
        </div>`
    )
    .join("");
  $("spList").querySelectorAll(".sp-row").forEach((row) => {
    row.addEventListener("click", (e) => {
      if (e.target.dataset.cmp) {
        addToCompare(e.target.dataset.cmp);
        return;
      }
      closeSp500();
      loadTicker(row.dataset.sym);
    });
  });
}

async function openSp500() {
  $("spDrawer").hidden = false;
  $("spBackdrop").hidden = false;
  try {
    await ensureSp500();
    renderSpList();
    $("spFilter").focus();
  } catch (err) {
    $("spList").innerHTML = `<div class="empty" style="padding:12px">Failed to load list: ${escapeHtml(err.message)}</div>`;
  }
}
function closeSp500() {
  $("spDrawer").hidden = true;
  $("spBackdrop").hidden = true;
}
$("sp500Btn").addEventListener("click", openSp500);
$("spCloseBtn").addEventListener("click", closeSp500);
$("spBackdrop").addEventListener("click", closeSp500);
$("spFilter").addEventListener("input", renderSpList);
$("spSector").addEventListener("change", renderSpList);

// ---------------------------------------------------------------------------
// COMPARE two stocks
// ---------------------------------------------------------------------------
let cmpData = { a: null, b: null };

function addToCompare(sym) {
  if (!$("cmpA").value) $("cmpA").value = sym;
  else if (!$("cmpB").value && $("cmpA").value !== sym) $("cmpB").value = sym;
  else { $("cmpA").value = sym; $("cmpB").value = ""; }
  openCompare();
  if ($("cmpA").value && $("cmpB").value) runCompare();
}

function openCompare() {
  $("cmpBackdrop").hidden = false;
  if (!$("cmpA").value && currentTicker) $("cmpA").value = currentTicker;
}
function closeCompare() {
  $("cmpBackdrop").hidden = true;
}
$("compareBtn").addEventListener("click", openCompare);
$("cmpCloseBtn").addEventListener("click", closeCompare);
$("cmpBackdrop").addEventListener("click", (e) => {
  if (e.target === $("cmpBackdrop")) closeCompare();
});

async function runCompare() {
  const a = $("cmpA").value.trim().toUpperCase();
  const b = $("cmpB").value.trim().toUpperCase();
  if (!a || !b) return ($("cmpStatus").textContent = "Enter two tickers.");
  if (a === b) return ($("cmpStatus").textContent = "Pick two different tickers.");
  $("cmpStatus").textContent = `Loading real data for ${a} and ${b}…`;
  $("cmpRunBtn").disabled = true;
  try {
    const [sa, sb] = await Promise.all([
      api(`/api/snapshot/${encodeURIComponent(a)}`),
      api(`/api/snapshot/${encodeURIComponent(b)}`),
    ]);
    cmpData = { a: sa, b: sb };
    renderCompare(sa, sb);
    $("cmpStatus").textContent = "";
    addLog(`Compared ${sa.symbol} vs ${sb.symbol} on live data.`);
  } catch (err) {
    $("cmpStatus").textContent = "Failed: " + err.message;
  } finally {
    $("cmpRunBtn").disabled = false;
  }
}
$("cmpRunBtn").addEventListener("click", runCompare);
[$("cmpA"), $("cmpB")].forEach((el) =>
  el.addEventListener("keydown", (e) => { if (e.key === "Enter") runCompare(); })
);

function renderCompare(sa, sb) {
  // Normalized performance chart (both series as % change from their first close)
  const canvas = $("cmpChart");
  const ctx = canvas.getContext("2d");
  const W = (canvas.width = canvas.clientWidth * 2);
  const H = (canvas.height = 360);
  ctx.clearRect(0, 0, W, H);
  const norm = (s) => {
    const first = s.series.length ? s.series[0].c : 1;
    return s.series.map((p) => ((p.c - first) / first) * 100);
  };
  const na = norm(sa), nb = norm(sb);
  const all = na.concat(nb);
  if (all.length) {
    const min = Math.min(...all), max = Math.max(...all);
    const pad = (max - min) * 0.08 || 1;
    const y = (v) => H - ((v - (min - pad)) / (max - min + 2 * pad)) * H;
    const drawLine = (arr, color) => {
      if (!arr.length) return;
      ctx.beginPath();
      arr.forEach((v, i) => {
        const x = (i / (arr.length - 1)) * W;
        i ? ctx.lineTo(x, y(v)) : ctx.moveTo(x, y(v));
      });
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.5;
      ctx.stroke();
    };
    // zero line
    ctx.beginPath(); ctx.setLineDash([6, 6]);
    ctx.moveTo(0, y(0)); ctx.lineTo(W, y(0));
    ctx.strokeStyle = "#3a4f40"; ctx.lineWidth = 1; ctx.stroke(); ctx.setLineDash([]);
    drawLine(na, "#4ade80");
    drawLine(nb, "#67e8f9");
    ctx.fillStyle = "#55684f"; ctx.font = "20px ui-monospace";
    ctx.fillText(max.toFixed(1) + "%", 8, 24);
    ctx.fillText(min.toFixed(1) + "%", 8, H - 10);
  }
  $("cmpLegend").innerHTML =
    `<span class="a">■ ${escapeHtml(sa.symbol)} ${pctStr(na[na.length - 1])} (1y, normalized)</span>` +
    `<span class="b">■ ${escapeHtml(sb.symbol)} ${pctStr(nb[nb.length - 1])} (1y, normalized)</span>`;

  const distHigh = (s) => (s.hi52 ? ((s.price - s.hi52) / s.hi52) * 100 : null);
  const rows = [
    ["Price", `${fmt(sa.price)} ${sa.currency}`, `${fmt(sb.price)} ${sb.currency}`, null],
    ["Day change", pctStr(sa.changePct), pctStr(sb.changePct), [sa.changePct, sb.changePct]],
    ["1 week", pctStr(sa.perf1w), pctStr(sb.perf1w), [sa.perf1w, sb.perf1w]],
    ["1 month", pctStr(sa.perf1m), pctStr(sb.perf1m), [sa.perf1m, sb.perf1m]],
    ["3 months", pctStr(sa.perf3m), pctStr(sb.perf3m), [sa.perf3m, sb.perf3m]],
    ["~1 year", pctStr(sa.perf1y), pctStr(sb.perf1y), [sa.perf1y, sb.perf1y]],
    ["52-wk range", `${fmt(sa.lo52)} – ${fmt(sa.hi52)}`, `${fmt(sb.lo52)} – ${fmt(sb.hi52)}`, null],
    ["From 52-wk high", pctStr(distHigh(sa)), pctStr(distHigh(sb)), [distHigh(sa), distHigh(sb)]],
    ["50-day MA", fmt(sa.ma50), fmt(sb.ma50), null],
    ["200-day MA", fmt(sa.ma200), fmt(sb.ma200), null],
    ["Volume", fmtBig(sa.volume), fmtBig(sb.volume), null],
    ["Avg vol (3m)", fmtBig(sa.avgVolume3m), fmtBig(sb.avgVolume3m), null],
  ];
  $("cmpTable").innerHTML = `<table>
    <thead><tr><th></th><td>${escapeHtml(sa.symbol)}<br/><span style="color:var(--dim);font-weight:400;font-size:10px">${escapeHtml(sa.name)}</span></td><td>${escapeHtml(sb.symbol)}<br/><span style="color:var(--dim);font-weight:400;font-size:10px">${escapeHtml(sb.name)}</span></td></tr></thead>
    <tbody>${rows
      .map(([k, va, vb, cmp]) => {
        let ca = "", cb = "";
        if (cmp && cmp[0] != null && cmp[1] != null) {
          if (cmp[0] > cmp[1]) ca = "win"; else if (cmp[1] > cmp[0]) cb = "win";
        }
        return `<tr><th>${k}</th><td class="${ca}">${va}</td><td class="${cb}">${vb}</td></tr>`;
      })
      .join("")}</tbody>
  </table>`;
}

$("cmpAiBtn").addEventListener("click", async () => {
  const a = $("cmpA").value.trim().toUpperCase();
  const b = $("cmpB").value.trim().toUpperCase();
  if (!a || !b) return ($("cmpStatus").textContent = "Enter two tickers first.");
  if (!cmpData.a || cmpData.a.symbol !== a || !cmpData.b || cmpData.b.symbol !== b) await runCompare();
  setStudioContext([a, b]);
  closeCompare();
  switchTab("studio");
  sendChat(
    `Compare ${a} to ${b} on growth, momentum, and valuation context using the live data. Tell me which looks stronger right now, whether either looks cheap, fair, or expensive, and what has to be true for each of today's prices to make sense. End with a clear bottom line.`
  );
});

// Boot — read platform first, then only open the SSE desk stream where it exists (local server).
fetch("/api/health")
  .then((r) => r.json())
  .then((h) => {
    setKeyPill(h.hasKey);
    $("modelBadge").textContent = h.model;
    platform = h.platform || "local";
    if (platform === "local") {
      connectEvents();
    } else {
      tickMs = 5000; // be gentle with serverless function invocation quotas
      document.querySelectorAll("#runBtn, #monitorToggle, #autoToggle").forEach((el) => (el.disabled = true));
      addLog("Serverless hosting detected: the multi-agent desk cycle runs on the local Node server; market data, S&P 500 browser, compare, and AI Studio are fully available.", "warn");
    }
  })
  .catch(() => connectEvents());
