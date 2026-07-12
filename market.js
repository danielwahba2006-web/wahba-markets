"use strict";
// Real market data via Yahoo Finance public endpoints (no API key required).

const FETCH_OPTS = {
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    Accept: "application/json, text/xml, */*",
  },
};

async function yfetch(url) {
  const res = await fetch(url, FETCH_OPTS);
  if (!res.ok) throw new Error(`Market data upstream returned ${res.status}`);
  return res;
}

async function chart(symbol, range, interval) {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?range=${range}&interval=${interval}&includePrePost=false`;
  const data = await (await yfetch(url)).json();
  const result = data && data.chart && data.chart.result && data.chart.result[0];
  if (!result) {
    const desc =
      (data && data.chart && data.chart.error && data.chart.error.description) ||
      `No chart data for "${symbol}"`;
    throw new Error(desc);
  }
  return result;
}

function lastValid(arr) {
  if (!Array.isArray(arr)) return null;
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i];
  return null;
}

function movingAvg(closes, n) {
  if (!closes || closes.length < n) return null;
  const slice = closes.slice(-n);
  return slice.reduce((a, b) => a + b, 0) / n;
}

// Full snapshot: 1 year of daily candles + derived stats. Used by the UI and the agents.
async function snapshot(symbol) {
  const r = await chart(symbol, "1y", "1d");
  const meta = r.meta || {};
  const ts = r.timestamp || [];
  const q = (r.indicators && r.indicators.quote && r.indicators.quote[0]) || {};
  const series = [];
  for (let i = 0; i < ts.length; i++) {
    if (q.close && q.close[i] != null) series.push({ t: ts[i] * 1000, c: q.close[i] });
  }
  const closes = series.map((p) => p.c);
  const vols = (q.volume || []).filter((v) => v != null);

  const price = meta.regularMarketPrice != null ? meta.regularMarketPrice : lastValid(q.close);
  // NOTE: meta.chartPreviousClose on a 1y chart is the close from a year ago —
  // for the day change we need the previous session's close instead.
  const prevClose =
    meta.regularMarketPreviousClose != null
      ? meta.regularMarketPreviousClose
      : closes.length > 1
        ? closes[closes.length - 2]
        : meta.chartPreviousClose != null
          ? meta.chartPreviousClose
          : null;

  const hi52 = meta.fiftyTwoWeekHigh != null ? meta.fiftyTwoWeekHigh : closes.length ? Math.max(...closes) : null;
  const lo52 = meta.fiftyTwoWeekLow != null ? meta.fiftyTwoWeekLow : closes.length ? Math.min(...closes) : null;

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
    dayHigh: meta.regularMarketDayHigh != null ? meta.regularMarketDayHigh : null,
    dayLow: meta.regularMarketDayLow != null ? meta.regularMarketDayLow : null,
    hi52,
    lo52,
    volume: meta.regularMarketVolume != null ? meta.regularMarketVolume : lastValid(q.volume),
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

// Lightweight intraday quote for the live monitor loop / 1-second tick.
async function intraday(symbol) {
  const r = await chart(symbol, "1d", "5m");
  const meta = r.meta || {};
  const q = (r.indicators && r.indicators.quote && r.indicators.quote[0]) || {};
  const price = meta.regularMarketPrice != null ? meta.regularMarketPrice : lastValid(q.close);
  const prevClose = meta.chartPreviousClose != null ? meta.chartPreviousClose : meta.previousClose;
  return {
    symbol: (meta.symbol || symbol).toUpperCase(),
    price,
    prevClose,
    changePct: price != null && prevClose ? ((price - prevClose) / prevClose) * 100 : null,
    marketState: meta.marketState || "",
    asOf: Date.now(),
  };
}

// Intraday series (today, 5-minute candles) for the live 1D chart.
async function intradaySeries(symbol) {
  const r = await chart(symbol, "1d", "5m");
  const meta = r.meta || {};
  const ts = r.timestamp || [];
  const q = (r.indicators && r.indicators.quote && r.indicators.quote[0]) || {};
  const series = [];
  for (let i = 0; i < ts.length; i++) {
    if (q.close && q.close[i] != null) series.push({ t: ts[i] * 1000, c: q.close[i] });
  }
  return {
    symbol: (meta.symbol || symbol).toUpperCase(),
    prevClose: meta.chartPreviousClose != null ? meta.chartPreviousClose : meta.previousClose,
    marketState: meta.marketState || "",
    series,
    asOf: Date.now(),
  };
}

// Short-TTL cache so the 1-second UI tick never hammers the upstream.
const tickCache = new Map();
const TICK_TTL_MS = 1500;
async function tick(symbol) {
  const key = symbol.toUpperCase();
  const hit = tickCache.get(key);
  if (hit && Date.now() - hit.at < TICK_TTL_MS) return hit.data;
  const data = await intraday(key);
  tickCache.set(key, { at: Date.now(), data });
  return data;
}

function stripCdata(s) {
  return (s || "")
    .replace(/<!\[CDATA\[/g, "")
    .replace(/\]\]>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .trim();
}

// Real news headlines from Yahoo Finance RSS (no key required).
async function news(symbol) {
  const url = `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(symbol)}&region=US&lang=en-US`;
  const xml = await (await yfetch(url)).text();
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
    items.push({
      id: pick("guid") || pick("link") || title,
      title,
      link: pick("link"),
      pubDate: pick("pubDate"),
      description: pick("description").slice(0, 400),
    });
  }
  return items;
}

// Symbol lookup (autocomplete / validation).
async function search(query) {
  const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=8&newsCount=0`;
  const data = await (await yfetch(url)).json();
  return (data.quotes || [])
    .filter((x) => x.symbol)
    .map((x) => ({
      symbol: x.symbol,
      name: x.shortname || x.longname || "",
      exchange: x.exchDisp || x.exchange || "",
      type: x.quoteType || "",
    }));
}

// Plain-text block of live market data handed to the agents as ground truth.
function describeSnapshot(s, headlines) {
  const f = (v, d = 2) => (v == null ? "n/a" : Number(v).toFixed(d));
  const lines = [
    `LIVE MARKET DATA (real, from Yahoo Finance, as of ${new Date(s.asOf).toUTCString()})`,
    `Ticker: ${s.symbol} — ${s.name} (${s.exchange}, ${s.currency}) — market state: ${s.marketState}`,
    `Last price: ${f(s.price)} | Previous close: ${f(s.prevClose)} | Day change: ${f(s.changePct)}%`,
    `Day range: ${f(s.dayLow)} – ${f(s.dayHigh)} | 52-week range: ${f(s.lo52)} – ${f(s.hi52)}`,
    `Volume: ${s.volume == null ? "n/a" : s.volume.toLocaleString()} | 3-month avg volume: ${s.avgVolume3m == null ? "n/a" : s.avgVolume3m.toLocaleString()}`,
    `50-day MA: ${f(s.ma50)} | 200-day MA: ${f(s.ma200)}`,
    `Performance — 1w: ${f(s.perf1w)}% | 1m: ${f(s.perf1m)}% | 3m: ${f(s.perf3m)}% | ~1y: ${f(s.perf1y)}%`,
    "",
    "LATEST REAL HEADLINES (Yahoo Finance news feed):",
  ];
  (headlines || []).slice(0, 12).forEach((h, i) => {
    lines.push(`${i + 1}. [${h.pubDate || "recent"}] ${h.title}`);
  });
  if (!headlines || !headlines.length) lines.push("(no headlines available right now)");
  return lines.join("\n");
}

module.exports = { snapshot, intraday, intradaySeries, tick, news, search, describeSnapshot };
