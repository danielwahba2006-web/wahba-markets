// Wahba Markets — Netlify serverless API (dependency-free).
// Serves the same /api/* surface as the local Node server, minus the multi-agent
// desk loop (long-running SSE), which runs on the local server only.
// Set ANTHROPIC_API_KEY in Netlify → Site settings → Environment variables for AI Studio.

export const config = { path: "/api/*" };

const MODEL = process.env.WAHBA_MODEL || "claude-opus-4-8";
const UA = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  Accept: "application/json, text/xml, */*",
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

async function chart(symbol, range, interval) {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?range=${range}&interval=${interval}&includePrePost=false`;
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`Market data upstream returned ${res.status}`);
  const data = await res.json();
  const r = data?.chart?.result?.[0];
  if (!r) throw new Error(data?.chart?.error?.description || `No chart data for "${symbol}"`);
  return r;
}

const lastValid = (arr) => {
  if (!Array.isArray(arr)) return null;
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i];
  return null;
};
const movingAvg = (closes, n) =>
  closes && closes.length >= n ? closes.slice(-n).reduce((a, b) => a + b, 0) / n : null;

async function snapshot(symbol) {
  const r = await chart(symbol, "1y", "1d");
  const meta = r.meta || {};
  const ts = r.timestamp || [];
  const q = r.indicators?.quote?.[0] || {};
  const series = [];
  for (let i = 0; i < ts.length; i++) if (q.close?.[i] != null) series.push({ t: ts[i] * 1000, c: q.close[i] });
  const closes = series.map((p) => p.c);
  const vols = (q.volume || []).filter((v) => v != null);
  const price = meta.regularMarketPrice ?? lastValid(q.close);
  const prevClose =
    meta.regularMarketPreviousClose ??
    (closes.length > 1 ? closes[closes.length - 2] : meta.chartPreviousClose ?? null);
  const pct = (a, b) => (a != null && b != null && b !== 0 ? ((a - b) / b) * 100 : null);
  const nBack = (n) => (closes.length > n ? closes[closes.length - 1 - n] : null);
  return {
    symbol: (meta.symbol || symbol).toUpperCase(),
    name: meta.longName || meta.shortName || (meta.symbol || symbol).toUpperCase(),
    currency: meta.currency || "USD",
    exchange: meta.fullExchangeName || meta.exchangeName || "",
    marketState: meta.marketState || "",
    price,
    prevClose,
    changePct: pct(price, prevClose),
    dayHigh: meta.regularMarketDayHigh ?? null,
    dayLow: meta.regularMarketDayLow ?? null,
    hi52: meta.fiftyTwoWeekHigh ?? (closes.length ? Math.max(...closes) : null),
    lo52: meta.fiftyTwoWeekLow ?? (closes.length ? Math.min(...closes) : null),
    volume: meta.regularMarketVolume ?? lastValid(q.volume),
    avgVolume3m: vols.length ? Math.round(vols.slice(-63).reduce((a, b) => a + b, 0) / Math.min(63, vols.length)) : null,
    ma50: movingAvg(closes, 50),
    ma200: movingAvg(closes, 200),
    perf1w: pct(price, nBack(5)),
    perf1m: pct(price, nBack(21)),
    perf3m: pct(price, nBack(63)),
    perf1y: closes.length ? pct(price, closes[0]) : null,
    series,
    asOf: Date.now(),
  };
}

async function intraday(symbol) {
  const r = await chart(symbol, "1d", "5m");
  const meta = r.meta || {};
  const q = r.indicators?.quote?.[0] || {};
  const price = meta.regularMarketPrice ?? lastValid(q.close);
  const prevClose = meta.chartPreviousClose ?? meta.previousClose;
  return {
    symbol: (meta.symbol || symbol).toUpperCase(),
    price,
    prevClose,
    changePct: price != null && prevClose ? ((price - prevClose) / prevClose) * 100 : null,
    marketState: meta.marketState || "",
    asOf: Date.now(),
  };
}

async function intradaySeries(symbol) {
  const r = await chart(symbol, "1d", "5m");
  const meta = r.meta || {};
  const ts = r.timestamp || [];
  const q = r.indicators?.quote?.[0] || {};
  const series = [];
  for (let i = 0; i < ts.length; i++) if (q.close?.[i] != null) series.push({ t: ts[i] * 1000, c: q.close[i] });
  return {
    symbol: (meta.symbol || symbol).toUpperCase(),
    prevClose: meta.chartPreviousClose ?? meta.previousClose,
    marketState: meta.marketState || "",
    series,
    asOf: Date.now(),
  };
}

const stripCdata = (s) =>
  (s || "")
    .replace(/<!\[CDATA\[/g, "").replace(/\]\]>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').trim();

async function news(symbol) {
  const url = `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(symbol)}&region=US&lang=en-US`;
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`News upstream returned ${res.status}`);
  const xml = await res.text();
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml)) && items.length < 20) {
    const block = m[1];
    const pick = (tag) => {
      const mm = block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
      return mm ? stripCdata(mm[1]) : "";
    };
    const title = pick("title");
    if (!title) continue;
    items.push({ id: pick("guid") || pick("link") || title, title, link: pick("link"), pubDate: pick("pubDate"), description: pick("description").slice(0, 400) });
  }
  return items;
}

async function search(query) {
  const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=8&newsCount=0`;
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`Search upstream returned ${res.status}`);
  const data = await res.json();
  return (data.quotes || [])
    .filter((x) => x.symbol)
    .map((x) => ({ symbol: x.symbol, name: x.shortname || x.longname || "", exchange: x.exchDisp || x.exchange || "", type: x.quoteType || "" }));
}

function describeSnapshot(s, headlines) {
  const f = (v, d = 2) => (v == null ? "n/a" : Number(v).toFixed(d));
  const lines = [
    `LIVE MARKET DATA (real, from Yahoo Finance, as of ${new Date(s.asOf).toUTCString()})`,
    `Ticker: ${s.symbol} — ${s.name} (${s.exchange}, ${s.currency}) — market state: ${s.marketState}`,
    `Last price: ${f(s.price)} | Previous close: ${f(s.prevClose)} | Day change: ${f(s.changePct)}%`,
    `Day range: ${f(s.dayLow)} – ${f(s.dayHigh)} | 52-week range: ${f(s.lo52)} – ${f(s.hi52)}`,
    `50-day MA: ${f(s.ma50)} | 200-day MA: ${f(s.ma200)}`,
    `Performance — 1w: ${f(s.perf1w)}% | 1m: ${f(s.perf1m)}% | 3m: ${f(s.perf3m)}% | ~1y: ${f(s.perf1y)}%`,
    "",
    "LATEST REAL HEADLINES:",
  ];
  (headlines || []).slice(0, 8).forEach((h, i) => lines.push(`${i + 1}. [${h.pubDate || "recent"}] ${h.title}`));
  return lines.join("\n");
}

const STUDIO_SYSTEM = `You are the AI Studio analyst on the Wahba Markets trading desk — a conversational market analyst the user can ask anything about stocks, sectors, and the desk's research.
Rules:
- Ground every number in the LIVE MARKET CONTEXT supplied with each message. It is real data. If a figure isn't in the context and you aren't confident, say so rather than inventing it.
- Be direct and practical. Short answers for short questions; deep analysis when asked.
- When comparing stocks, cover growth, momentum, valuation context, and risk — and give a clear bottom line.
- Always remind users of risk when giving directional views, briefly, without being preachy.`;

// Streaming chat via raw Anthropic Messages API (SSE parsed to plain text chunks).
async function chatStreamResponse(body) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return json({ ok: false, error: "ANTHROPIC_API_KEY is not set in Netlify environment variables." }, 400);

  const messages = Array.isArray(body.messages) ? body.messages.slice(-16) : [];
  if (!messages.length || messages[messages.length - 1].role !== "user")
    return json({ ok: false, error: "messages must end with a user message" }, 400);

  const tickers = (Array.isArray(body.tickers) ? body.tickers : []).slice(0, 2).map((t) => String(t).trim().toUpperCase()).filter(Boolean);
  const blocks = [];
  for (const t of tickers) {
    try {
      const [snap, headlines] = await Promise.all([snapshot(t), news(t).catch(() => [])]);
      blocks.push(describeSnapshot(snap, headlines));
    } catch (err) {
      blocks.push(`(Could not load live data for ${t}: ${err.message})`);
    }
  }
  const contextBlock = blocks.length ? `=== LIVE MARKET CONTEXT ===\n${blocks.join("\n\n")}\n=== END CONTEXT ===` : "";
  const finalMessages = messages.map((m, i) =>
    i === messages.length - 1 && contextBlock
      ? { role: "user", content: `${contextBlock}\n\n---\n\nUSER: ${m.content}` }
      : { role: m.role, content: m.content }
  );

  const upstream = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4000,
      stream: true,
      system: STUDIO_SYSTEM,
      thinking: { type: "adaptive" },
      messages: finalMessages,
    }),
  });
  if (!upstream.ok) {
    const errText = await upstream.text();
    return json({ ok: false, error: `Anthropic API ${upstream.status}: ${errText.slice(0, 300)}` }, 502);
  }

  // Transform Anthropic SSE -> plain text chunks.
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  const stream = new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const evt = JSON.parse(payload);
          if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta") {
            controller.enqueue(encoder.encode(evt.delta.text));
          }
        } catch { /* partial JSON across chunks is handled by buffering */ }
      }
    },
    cancel() { reader.cancel(); },
  });
  return new Response(stream, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache" } });
}

export default async (req) => {
  const url = new URL(req.url);
  const parts = url.pathname.replace(/^\/api\//, "").split("/").filter(Boolean);
  const route = parts[0] || "";
  const arg = parts[1] ? decodeURIComponent(parts[1]) : "";

  try {
    switch (route) {
      case "health":
        return json({ ok: true, platform: "netlify", model: MODEL, hasKey: Boolean(process.env.ANTHROPIC_API_KEY), running: false, monitor: { enabled: false } });
      case "snapshot":
        return json(await snapshot(arg));
      case "intraday":
        return json(await intradaySeries(arg));
      case "tick":
        return json(await intraday(arg));
      case "news":
        return json(await news(arg));
      case "search":
        return json(await search(url.searchParams.get("q") || ""));
      case "chat": {
        if (req.method !== "POST") return json({ ok: false, error: "POST required" }, 405);
        const body = await req.json().catch(() => ({}));
        return await chatStreamResponse(body);
      }
      case "test-ai": {
        if (!process.env.ANTHROPIC_API_KEY) return json({ ok: false, error: "ANTHROPIC_API_KEY not set in Netlify env vars" }, 400);
        return json({ ok: true, model: MODEL, reply: "DESK ONLINE (netlify)" });
      }
      case "cycle":
      case "monitor":
      case "events":
      case "key":
        return json({ ok: false, error: "The multi-agent desk loop runs on the local Node server (see README). On Netlify you get live data, S&P 500, compare, and AI Studio." }, 501);
      default:
        return json({ ok: false, error: `Unknown API route: ${route}` }, 404);
    }
  } catch (err) {
    return json({ ok: false, error: err.message }, 502);
  }
};
