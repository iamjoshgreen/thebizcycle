import YahooFinanceClass from "yahoo-finance2";
import { logger } from "./logger.js";

const yahooFinance = new YahooFinanceClass();

// ─── Fixed model constants (Table 3 + Section 4.2) ─────────────────────────────
//
// This is a DETERMINISTIC fixed-coefficient model — nothing is fit at runtime.
// Source: "Asymmetric Tail Curvature in Bitcoin Price Quantiles".
//
//   t = days since Jan 1, 2009 (the Table 3 anchor)
//   x = ln(t) − MU          (natural log of time, centered at the fixed MU)
//   log10(price) = c + a·x + b·x²
//   price = 10^(c + a·x + b·x²)
//   then rearrange (ascending sort) the 7 quantile prices per date.
//
// Time is natural-log; price is base-10. The two bases are intentional.

const GENESIS_S = Math.floor(Date.UTC(2009, 0, 1) / 1000); // Jan 1, 2009
const MU = 7.9914; // fixed centering constant (NOT the data mean)
const DAY_S = 86400;
const WEEK_S = 7 * DAY_S;

// Table 3, ordered low → high quantile.
const QUANTILES: Array<{ tau: number; c: number; a: number; b: number }> = [
  { tau: 0.01, c: 2.837, a: 2.578, b: -0.0241 },
  { tau: 0.1, c: 2.933, a: 2.552, b: -0.0241 },
  { tau: 0.25, c: 3.004, a: 2.554, b: -0.0241 },
  { tau: 0.5, c: 3.214, a: 2.482, b: -0.1126 },
  { tau: 0.75, c: 3.562, a: 2.283, b: -0.3259 },
  { tau: 0.95, c: 3.897, a: 1.964, b: -0.3259 },
  { tau: 0.99, c: 4.028, a: 1.904, b: -0.3259 },
];

// Dislocation offsets below Q1% (Figure 1). Golden zone spans disl1 (top) → disl4 (bottom).
const DISLOCATIONS = [-0.0735, -0.174, -0.226, -0.346];

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BtcQuantilePoint {
  time: number;
  price: number | null; // null for projection points
  q01: number;
  q10: number;
  q25: number;
  q50: number;
  q75: number;
  q95: number;
  q99: number;
  disl1: number;
  disl2: number;
  disl3: number;
  disl4: number;
}

export interface BtcCyclePeak {
  time: number;
  price: number;
  label: string;
  q99: number; // Q99% band value at the time of the peak
  pctOfQ99: number; // price / q99 — fraction of the top quantile the peak reached
}

export interface BtcQuantilePayload {
  series: BtcQuantilePoint[];
  cyclePeaks: BtcCyclePeak[];
  currentPrice: number | null;
  currentQ01: number | null;
  currentQ10: number | null;
  currentQ50: number | null;
  currentQ95: number | null;
  currentQ99: number | null;
  currentPercentile: number | null; // interpolated across the 7 taus, 0–100
  goldenTop: number | null; // disl1 at the latest data point
  goldenBottom: number | null; // disl4 at the latest data point
  modelNote: string;
  lastUpdated: number;
}

// ─── Model ─────────────────────────────────────────────────────────────────────

// 7 rearranged (ascending) quantile prices for a unix-second timestamp.
function quantilePrices(timeS: number): number[] {
  const t = (timeS - GENESIS_S) / DAY_S; // days since Jan 1, 2009
  const x = Math.log(Math.max(1, t)) - MU; // natural log of time, centered at MU
  const prices = QUANTILES.map((q) => Math.pow(10, q.c + q.a * x + q.b * x * x));
  prices.sort((p1, p2) => p1 - p2); // rearrangement — required, not cosmetic
  return prices;
}

function buildRow(timeS: number, price: number | null): BtcQuantilePoint {
  const p = quantilePrices(timeS);
  const q1 = p[0];
  return {
    time: timeS,
    price,
    q01: p[0],
    q10: p[1],
    q25: p[2],
    q50: p[3],
    q75: p[4],
    q95: p[5],
    q99: p[6],
    disl1: q1 * (1 + DISLOCATIONS[0]),
    disl2: q1 * (1 + DISLOCATIONS[1]),
    disl3: q1 * (1 + DISLOCATIONS[2]),
    disl4: q1 * (1 + DISLOCATIONS[3]),
  };
}

// Interpolate the percentile of a price across the 7 quantile levels (log-price space).
// Below Q1 / above Q99 the value is extrapolated using the nearest segment slope and
// clamped to [0, 100], so a price under the Q1% floor honestly reads below 1.
function interpPercentile(price: number, qPrices: number[]): number {
  const taus = QUANTILES.map((q) => q.tau * 100); // [1,10,25,50,75,95,99]
  const n = qPrices.length;
  const lp = Math.log(price);

  // Below the bottom quantile: extrapolate down using the Q1→Q10 slope.
  if (price <= qPrices[0]) {
    const lo = Math.log(qPrices[0]);
    const hi = Math.log(qPrices[1]);
    const f = hi > lo ? (lp - lo) / (hi - lo) : 0;
    return Math.max(0, taus[0] + f * (taus[1] - taus[0]));
  }
  // Above the top quantile: extrapolate up using the Q95→Q99 slope.
  if (price >= qPrices[n - 1]) {
    const lo = Math.log(qPrices[n - 2]);
    const hi = Math.log(qPrices[n - 1]);
    const f = hi > lo ? (lp - lo) / (hi - lo) : 0;
    return Math.min(100, taus[n - 1] + f * (taus[n - 1] - taus[n - 2]));
  }
  for (let i = 0; i < n - 1; i++) {
    if (price >= qPrices[i] && price <= qPrices[i + 1]) {
      const lo = Math.log(qPrices[i]);
      const hi = Math.log(qPrices[i + 1]);
      const f = hi > lo ? (lp - lo) / (hi - lo) : 0;
      return taus[i] + f * (taus[i + 1] - taus[i]);
    }
  }
  return taus[n - 1];
}

// ─── Early BTC price history ──────────────────────────────────────────────────
//
// Yahoo Finance BTC-USD coverage starts ~Sep 2014. These monthly close prices
// (Jul 2010 – Sep 2014) are sourced from well-documented exchange records
// (Mt.Gox → Bitstamp) so the price line covers the full available history.
// They are NOT used to fit anything — the bands are deterministic.
//
// [dateStr, USD close]
const EARLY_BTC_PRICES: Array<[string, number]> = [
  ["2010-07-01", 0.0584],
  ["2010-08-01", 0.0694],
  ["2010-09-01", 0.0614],
  ["2010-10-01", 0.0974],
  ["2010-11-01", 0.2378],
  ["2010-12-01", 0.218],
  ["2011-01-01", 0.31],
  ["2011-02-01", 0.89],
  ["2011-03-01", 0.99],
  ["2011-04-01", 1.02],
  ["2011-05-01", 6.0],
  ["2011-06-01", 31.91], // June 2011 peak
  ["2011-07-01", 13.4],
  ["2011-08-01", 10.0],
  ["2011-09-01", 5.0],
  ["2011-10-01", 3.48],
  ["2011-11-01", 2.52],
  ["2011-12-01", 3.06],
  ["2012-01-01", 6.18],
  ["2012-02-01", 4.88],
  ["2012-03-01", 4.89],
  ["2012-04-01", 5.08],
  ["2012-05-01", 5.02],
  ["2012-06-01", 6.7],
  ["2012-07-01", 7.14],
  ["2012-08-01", 9.75],
  ["2012-09-01", 12.37],
  ["2012-10-01", 10.96],
  ["2012-11-01", 11.6],
  ["2012-12-01", 13.45],
  ["2013-01-01", 15.4],
  ["2013-02-01", 28.5],
  ["2013-03-01", 92.0],
  ["2013-04-01", 135.0],
  ["2013-05-01", 118.0],
  ["2013-06-01", 97.5],
  ["2013-07-01", 87.0],
  ["2013-08-01", 104.0],
  ["2013-09-01", 126.0],
  ["2013-10-01", 196.0],
  ["2013-11-01", 1242.0], // November 2013 peak
  ["2013-12-01", 710.0],
  ["2014-01-01", 912.0],
  ["2014-02-01", 585.0],
  ["2014-03-01", 458.0],
  ["2014-04-01", 440.0],
  ["2014-05-01", 438.0],
  ["2014-06-01", 584.0],
  ["2014-07-01", 624.0],
  ["2014-08-01", 510.0],
  ["2014-09-01", 380.0],
];

// ─── Known cycle peaks ────────────────────────────────────────────────────────

const PEAK_DATES: Array<{ label: string; dateStr: string }> = [
  { label: "2011", dateStr: "2011-06-08" },
  { label: "2013", dateStr: "2013-11-30" },
  { label: "2017", dateStr: "2017-12-17" },
  { label: "2021", dateStr: "2021-11-08" },
];

// ─── Yahoo Finance helper ─────────────────────────────────────────────────────

interface YahooChartResult {
  quotes?: Array<{ date?: Date; close?: number | null }>;
}

async function yahooChartWithRetry(
  symbol: string,
  opts: { period1: string; period2: string; interval: "1wk" | "1d" | "1mo" },
): Promise<YahooChartResult | null> {
  const ATTEMPTS = 3;
  const BASE_DELAY = 400;
  const TIMEOUT_MS = 25_000;
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const timeout = new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error(`Yahoo ${symbol} timeout`)), TIMEOUT_MS),
      );
      return await Promise.race<YahooChartResult>([
        yahooFinance.chart(symbol, opts) as Promise<YahooChartResult>,
        timeout,
      ]);
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (
        /Not Found|404|invalid|symbol/i.test(msg) &&
        !/timeout|ECONN|ETIMEDOUT|network|fetch/i.test(msg)
      ) {
        logger.warn({ symbol, err: msg }, "yahoo permanent failure");
        return null;
      }
      if (attempt === ATTEMPTS) break;
      await new Promise((r) => setTimeout(r, BASE_DELAY * 2 ** (attempt - 1)));
    }
  }
  logger.warn({ symbol, err: lastErr }, "yahoo fetch failed (btcQuantile)");
  return null;
}

// ─── Main entry ───────────────────────────────────────────────────────────────

export async function fetchBtcQuantilePayload(): Promise<BtcQuantilePayload> {
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);

  const raw = await yahooChartWithRetry("BTC-USD", {
    period1: "2010-01-01",
    period2: todayStr,
    interval: "1wk",
  });

  if (!raw?.quotes || raw.quotes.length === 0) {
    throw new Error("BTC-USD data unavailable from Yahoo Finance");
  }

  // Build sorted (time, price) pairs.
  // Seed with hardcoded early history first (Jul 2010 – Sep 2014);
  // Yahoo data (starting ~Sep 2014) will overwrite any overlap.
  const priceMap = new Map<number, number>();
  for (const [dateStr, price] of EARLY_BTC_PRICES) {
    const t = Math.floor(new Date(dateStr + "T00:00:00Z").getTime() / 1000);
    priceMap.set(t, price);
  }
  for (const q of raw.quotes) {
    if (!q.date || q.close == null || !isFinite(q.close) || q.close <= 0) continue;
    const d = new Date(q.date);
    d.setUTCHours(0, 0, 0, 0);
    const dow = d.getUTCDay();
    if (dow !== 5) d.setUTCDate(d.getUTCDate() + (dow === 0 ? 5 : 5 - dow));
    priceMap.set(Math.floor(d.getTime() / 1000), q.close);
  }

  const sorted = [...priceMap.entries()].sort((a, b) => a[0] - b[0]);
  if (sorted.length < 20) throw new Error("Insufficient BTC price history");

  const times = sorted.map(([t]) => t);
  const prices = sorted.map(([, p]) => p);
  const lastTime = times[times.length - 1];

  // ─── Build series ─────────────────────────────────────────────────────────
  // Historical rows carry real prices; the bands are the deterministic model.
  const series: BtcQuantilePoint[] = [];
  for (let i = 0; i < times.length; i++) {
    series.push(buildRow(times[i], prices[i]));
  }

  // 2-year weekly projection beyond the last data point. price = null so the
  // price line stops at the last real point while the bands continue. The
  // ascending rearrangement runs on these rows too (handles the Q75/Q95
  // crossing around Dec 2026).
  const projEndTime = lastTime + 2 * 365 * DAY_S;
  for (let t = lastTime + WEEK_S; t <= projEndTime; t += WEEK_S) {
    series.push(buildRow(t, null));
  }

  // ─── Cycle peaks ──────────────────────────────────────────────────────────
  const cyclePeaks: BtcCyclePeak[] = [];
  for (const { label, dateStr } of PEAK_DATES) {
    const targetS = Math.floor(new Date(dateStr + "T00:00:00Z").getTime() / 1000);

    // Locate the nearest data point within ±4 weeks of the target date.
    let bestIdx = -1;
    let bestDelta = Infinity;
    for (let i = 0; i < times.length; i++) {
      const delta = Math.abs(times[i] - targetS);
      if (delta < bestDelta && delta < 4 * WEEK_S) {
        bestDelta = delta;
        bestIdx = i;
      }
    }
    if (bestIdx === -1) continue;

    // Search the local max within ±6 bars of the nearest match.
    const window = 6;
    let maxIdx = bestIdx;
    for (
      let i = Math.max(0, bestIdx - window);
      i <= Math.min(times.length - 1, bestIdx + window);
      i++
    ) {
      if (prices[i] > prices[maxIdx]) maxIdx = i;
    }
    const peakTime = times[maxIdx];
    const peakPrice = prices[maxIdx];
    const q99 = quantilePrices(peakTime)[6];
    cyclePeaks.push({ time: peakTime, price: peakPrice, label, q99, pctOfQ99: peakPrice / q99 });
  }

  // ─── Current position ─────────────────────────────────────────────────────
  const lastHistPt = series.filter((p) => p.price != null).at(-1);
  if (!lastHistPt) throw new Error("No historical price data found in series");

  const currentPrice = lastHistPt.price;
  const currentQ01 = lastHistPt.q01;
  const currentQ10 = lastHistPt.q10;
  const currentQ50 = lastHistPt.q50;
  const currentQ95 = lastHistPt.q95;
  const currentQ99 = lastHistPt.q99;
  const goldenTop = lastHistPt.disl1;
  const goldenBottom = lastHistPt.disl4;

  let currentPercentile: number | null = null;
  if (currentPrice != null) {
    const qp = [
      lastHistPt.q01,
      lastHistPt.q10,
      lastHistPt.q25,
      lastHistPt.q50,
      lastHistPt.q75,
      lastHistPt.q95,
      lastHistPt.q99,
    ];
    currentPercentile = interpPercentile(currentPrice, qp);
  }

  const modelNote =
    `Deterministic fixed-coefficient quantile model (Table 3). Seven quantiles ` +
    `(τ = 1%, 10%, 25%, 50%, 75%, 95%, 99%) of the form log₁₀(price) = c + a·x + b·x², ` +
    `where x = ln(days since Jan 1 2009) − ${MU}. Quantiles are rearranged (sorted ` +
    `ascending per date) to enforce non-crossing. Nothing is fit at runtime — the ` +
    `coefficients are fixed. Price line: Yahoo Finance BTC-USD weekly closes plus ` +
    `documented monthly exchange data for Jul 2010 – Sep 2014. Not a forecast or a ` +
    `floor — a distributional characterization of where price has historically traded.`;

  return {
    series,
    cyclePeaks,
    currentPrice,
    currentQ01,
    currentQ10,
    currentQ50,
    currentQ95,
    currentQ99,
    currentPercentile,
    goldenTop,
    goldenBottom,
    modelNote,
    lastUpdated: Math.floor(Date.now() / 1000),
  };
}
