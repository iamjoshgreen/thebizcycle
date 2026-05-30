import YahooFinanceClass from "yahoo-finance2";
import { logger } from "./logger.js";

const yahooFinance = new YahooFinanceClass();

// BTC genesis block: January 3, 2009
const GENESIS_DATE = "2009-01-03";
const GENESIS_S = Math.floor(new Date(GENESIS_DATE + "T00:00:00Z").getTime() / 1000);
const DAY_S = 86400;
const WEEK_S = 7 * DAY_S;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BtcQuantilePoint {
  time: number;
  price: number | null; // null for projection points
  lower: number;
  median: number;
  upper: number;
}

export interface BtcCyclePeak {
  time: number;
  price: number;
  label: string;
  upperBand: number;
  pctOfUpper: number;
}

export interface BtcQuantilePayload {
  series: BtcQuantilePoint[];
  cyclePeaks: BtcCyclePeak[];
  currentPrice: number | null;
  currentLower: number | null;
  currentMedian: number | null;
  currentUpper: number | null;
  currentPercentile: number | null;
  lowerCoeffs: number[];
  medianCoeffs: number[];
  upperCoeffs: number[];
  modelNote: string;
  lastUpdated: number;
}

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

// ─── Quantile regression ──────────────────────────────────────────────────────
//
// Fits a quantile regression via sub-gradient descent.
// X: design matrix [n × p], y: targets [n], q: quantile ∈ (0,1)
//
// Uses 1/sqrt(t) step decay (provably convergent for sub-gradient methods).
// Initialized from the OLS estimate for fast convergence.

function dotVec(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// Gaussian elimination for small p×p systems
function solveLinear(A: number[][], b: number[]): number[] {
  const n = A.length;
  const aug = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let maxRow = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(aug[row][col]) > Math.abs(aug[maxRow][col])) maxRow = row;
    }
    [aug[col], aug[maxRow]] = [aug[maxRow], aug[col]];
    const pivot = aug[col][col];
    if (Math.abs(pivot) < 1e-14) continue;
    for (let row = col + 1; row < n; row++) {
      const f = aug[row][col] / pivot;
      for (let j = col; j <= n; j++) aug[row][j] -= f * aug[col][j];
    }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    x[i] = aug[i][n];
    for (let j = i + 1; j < n; j++) x[i] -= aug[i][j] * x[j];
    x[i] /= aug[i][i];
  }
  return x;
}

function olsEstimate(X: number[][], y: number[]): number[] {
  const p = X[0].length;
  const XtX = Array.from({ length: p }, (_, i) =>
    Array.from({ length: p }, (_, j) => X.reduce((s, row) => s + row[i] * row[j], 0)),
  );
  const Xty = Array.from({ length: p }, (_, i) =>
    X.reduce((s, row, k) => s + row[i] * y[k], 0),
  );
  return solveLinear(XtX, Xty);
}

function quantileReg(X: number[][], y: number[], q: number, maxIter = 40000): number[] {
  const n = X.length;
  const p = X[0].length;
  const w = olsEstimate(X, y);

  for (let t = 1; t <= maxIter; t++) {
    // Decaying step size with warm-up
    const lr = (0.3 / Math.sqrt(t)) * (t < 100 ? t / 100 : 1);
    const grad = new Array(p).fill(0);
    for (let i = 0; i < n; i++) {
      const pred = dotVec(X[i], w);
      const r = y[i] - pred;
      const g = r > 0 ? -q : 1 - q;
      for (let j = 0; j < p; j++) grad[j] += g * X[i][j];
    }
    for (let j = 0; j < p; j++) w[j] -= (lr / n) * grad[j];
  }
  return w;
}

// Evaluate a (linear or quadratic) model at logDays
function evalModel(coeffs: number[], logDays: number): number {
  if (coeffs.length === 2) return coeffs[0] + coeffs[1] * logDays;
  return coeffs[0] + coeffs[1] * logDays + coeffs[2] * logDays * logDays;
}

// ─── Early BTC price history ──────────────────────────────────────────────────
//
// Yahoo Finance BTC-USD coverage starts ~Sep 2014. These monthly close prices
// (Jul 2010 – Sep 2014) are sourced from well-documented exchange records
// (Mt.Gox → Bitstamp) and fill the gap so the regression and price line cover
// the full available history including both the 2011 and 2013 cycle peaks.
//
// [dateStr, USD close]
const EARLY_BTC_PRICES: Array<[string, number]> = [
  ["2010-07-01", 0.0584],
  ["2010-08-01", 0.0694],
  ["2010-09-01", 0.0614],
  ["2010-10-01", 0.0974],
  ["2010-11-01", 0.2378],
  ["2010-12-01", 0.2180],
  ["2011-01-01", 0.3100],
  ["2011-02-01", 0.8900],
  ["2011-03-01", 0.9900],
  ["2011-04-01", 1.0200],
  ["2011-05-01", 6.0000],
  ["2011-06-01", 31.9100], // June 2011 peak
  ["2011-07-01", 13.4000],
  ["2011-08-01", 10.0000],
  ["2011-09-01", 5.0000],
  ["2011-10-01", 3.4800],
  ["2011-11-01", 2.5200],
  ["2011-12-01", 3.0600],
  ["2012-01-01", 6.1800],
  ["2012-02-01", 4.8800],
  ["2012-03-01", 4.8900],
  ["2012-04-01", 5.0800],
  ["2012-05-01", 5.0200],
  ["2012-06-01", 6.7000],
  ["2012-07-01", 7.1400],
  ["2012-08-01", 9.7500],
  ["2012-09-01", 12.3700],
  ["2012-10-01", 10.9600],
  ["2012-11-01", 11.6000],
  ["2012-12-01", 13.4500],
  ["2013-01-01", 15.4000],
  ["2013-02-01", 28.5000],
  ["2013-03-01", 92.0000],
  ["2013-04-01", 135.0000],
  ["2013-05-01", 118.0000],
  ["2013-06-01", 97.5000],
  ["2013-07-01", 87.0000],
  ["2013-08-01", 104.0000],
  ["2013-09-01", 126.0000],
  ["2013-10-01", 196.0000],
  ["2013-11-01", 1242.000], // November 2013 peak
  ["2013-12-01", 710.0000],
  ["2014-01-01", 912.0000],
  ["2014-02-01", 585.0000],
  ["2014-03-01", 458.0000],
  ["2014-04-01", 440.0000],
  ["2014-05-01", 438.0000],
  ["2014-06-01", 584.0000],
  ["2014-07-01", 624.0000],
  ["2014-08-01", 510.0000],
  ["2014-09-01", 380.0000],
];

// ─── Known cycle peaks ────────────────────────────────────────────────────────

const PEAK_DATES: Array<{ label: string; dateStr: string }> = [
  { label: "2011", dateStr: "2011-06-08" },
  { label: "2013", dateStr: "2013-11-30" },
  { label: "2017", dateStr: "2017-12-17" },
  { label: "2021", dateStr: "2021-11-08" },
];

// ─── Main entry ───────────────────────────────────────────────────────────────

export async function fetchBtcQuantilePayload(): Promise<BtcQuantilePayload> {
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);

  // Start from the earliest date Yahoo Finance may have BTC-USD data; the
  // actual series will begin wherever Yahoo's coverage starts (~Sep 2014).
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

  // Transform to log-log space
  const times = sorted.map(([t]) => t);
  const prices = sorted.map(([, p]) => p);
  const logDaysArr = times.map((t) => Math.log(Math.max(1, (t - GENESIS_S) / DAY_S)));
  const logPrices = prices.map((p) => Math.log(p));

  // Center log-days for numerical conditioning. Without centering, x≈8 and x²≈67
  // have very different scales from the intercept, causing gradient oscillation in the
  // quadratic fit. Centering brings all features to ~[-1, 1].
  const xMean = logDaysArr.reduce((s, x) => s + x, 0) / logDaysArr.length;
  const logDaysCentered = logDaysArr.map((x) => x - xMean);

  // Design matrices in centered space
  const Xlin: number[][] = logDaysCentered.map((xc) => [1, xc]);
  const Xquad: number[][] = logDaysCentered.map((xc) => [1, xc, xc * xc]);

  logger.info({ n: sorted.length, xMean }, "btcQuantile: fitting quantile regression");

  const lowerCentered = quantileReg(Xlin, logPrices, 0.1);
  const medianCentered = quantileReg(Xlin, logPrices, 0.5);
  const upperCentered = quantileReg(Xquad, logPrices, 0.9);

  // Convert centered coefficients back to uncentered parametrization so evalModel
  // can use raw log(days) without needing xMean at query time.
  //   Linear:    a0 + a1*(x-μ)   → (a0 - a1*μ) + a1*x
  //   Quadratic: a0 + a1*(x-μ) + a2*(x-μ)² →
  //              (a0 - a1*μ + a2*μ²) + (a1 - 2*a2*μ)*x + a2*x²
  function uncenterLinear(a: number[], mu: number): number[] {
    return [a[0] - a[1] * mu, a[1]];
  }
  function uncenterQuadratic(a: number[], mu: number): number[] {
    return [
      a[0] - a[1] * mu + a[2] * mu * mu,
      a[1] - 2 * a[2] * mu,
      a[2],
    ];
  }

  const lowerCoeffs = uncenterLinear(lowerCentered, xMean);
  const medianCoeffs = uncenterLinear(medianCentered, xMean);
  const upperCoeffs = uncenterQuadratic(upperCentered, xMean);

  logger.info(
    { lowerCoeffs, medianCoeffs, upperCoeffs },
    "btcQuantile: regression complete",
  );

  // ─── Build series ─────────────────────────────────────────────────────────

  const lastTime = times[times.length - 1];

  // All data points now have real prices (early history + Yahoo).
  // No null-price pre-data prefix needed.
  const series: BtcQuantilePoint[] = [];
  for (let i = 0; i < times.length; i++) {
    const t = times[i];
    const ld = logDaysArr[i];
    series.push({
      time: t,
      price: prices[i],
      lower: Math.exp(evalModel(lowerCoeffs, ld)),
      median: Math.exp(evalModel(medianCoeffs, ld)),
      upper: Math.exp(evalModel(upperCoeffs, ld)),
    });
  }

  // 2-year weekly projection beyond last data point
  const projEndTime = lastTime + 2 * 365 * DAY_S;
  for (let t = lastTime + WEEK_S; t <= projEndTime; t += WEEK_S) {
    const ld = Math.log(Math.max(1, (t - GENESIS_S) / DAY_S));
    series.push({
      time: t,
      price: null,
      lower: Math.exp(evalModel(lowerCoeffs, ld)),
      median: Math.exp(evalModel(medianCoeffs, ld)),
      upper: Math.exp(evalModel(upperCoeffs, ld)),
    });
  }

  // ─── Cycle peaks ──────────────────────────────────────────────────────────

  const cyclePeaks: BtcCyclePeak[] = [];
  for (const { label, dateStr } of PEAK_DATES) {
    const targetS = Math.floor(new Date(dateStr + "T00:00:00Z").getTime() / 1000);

    // Try to locate the peak in the available price data (within ±4 weeks of target date)
    let bestIdx = -1;
    let bestDelta = Infinity;
    for (let i = 0; i < times.length; i++) {
      const delta = Math.abs(times[i] - targetS);
      if (delta < bestDelta && delta < 4 * WEEK_S) {
        bestDelta = delta;
        bestIdx = i;
      }
    }

    if (bestIdx === -1) continue; // peak not in dataset window — skip

    // Search local max within ±6 bars of the nearest match
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
    const peakLogDays = logDaysArr[maxIdx];

    const upperBand = Math.exp(evalModel(upperCoeffs, peakLogDays));
    const pctOfUpper = peakPrice / upperBand;
    cyclePeaks.push({ time: peakTime, price: peakPrice, label, upperBand, pctOfUpper });
  }

  // ─── Current position ─────────────────────────────────────────────────────
  // series = [...historical (early+Yahoo), ...projection]; find the last entry
  // that has a real price (i.e. the last historical weekly close).

  const lastHistPt = series.filter((p) => p.price != null).at(-1);
  if (!lastHistPt) throw new Error("No historical price data found in series");

  const currentPrice = lastHistPt.price;
  const currentLower = lastHistPt.lower;
  const currentMedian = lastHistPt.median;
  const currentUpper = lastHistPt.upper;

  let currentPercentile: number | null = null;
  if (currentPrice != null && currentLower > 0 && currentUpper > currentLower) {
    const logCur = Math.log(currentPrice);
    const logLo = Math.log(currentLower);
    const logHi = Math.log(currentUpper);
    currentPercentile = Math.max(
      0,
      Math.min(100, ((logCur - logLo) / (logHi - logLo)) * 100),
    );
  }

  const curveDir = upperCoeffs[2] < 0 ? "inward (compression)" : "outward";
  const modelNote =
    `Asymmetric quantile regression in log-log space. ` +
    `Lower band (q=0.10): linear power law. ` +
    `Median (q=0.50): linear power law. ` +
    `Upper band (q=0.90): quadratic — curvature ${upperCoeffs[2].toFixed(4)} (${curveDir}). ` +
    `Fitted on ${sorted.length} weekly observations. ` +
    `Not a price forecast or floor — a distributional characterization of where price has historically traded.`;

  return {
    series,
    cyclePeaks,
    currentPrice,
    currentLower,
    currentMedian,
    currentUpper,
    currentPercentile,
    lowerCoeffs,
    medianCoeffs,
    upperCoeffs,
    modelNote,
    lastUpdated: Math.floor(Date.now() / 1000),
  };
}
