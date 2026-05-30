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

// ─── Known cycle peaks ────────────────────────────────────────────────────────

// Known cycle peaks. Pre-data entries (before Yahoo BTC-USD coverage ~Sep 2014)
// carry a hardcoded price; the bands at those dates are computed via model extrapolation.
const PEAK_DATES: Array<{ label: string; dateStr: string; knownPrice?: number }> = [
  { label: "2011 Peak", dateStr: "2011-06-08", knownPrice: 31.91 },
  { label: "2013 Peak", dateStr: "2013-11-30", knownPrice: 1242 },
  { label: "2017 Peak", dateStr: "2017-12-17" },
  { label: "2021 Peak", dateStr: "2021-11-08" },
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

  // Build sorted (time, price) pairs — anchor to Friday
  const priceMap = new Map<number, number>();
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

  // All historical Fridays already in sorted[], plus project 2 years forward
  const lastTime = times[times.length - 1];
  const projEndTime = lastTime + 2 * 365 * DAY_S;
  const projTimes: number[] = [];
  for (let t = lastTime + WEEK_S; t <= projEndTime; t += WEEK_S) {
    projTimes.push(t);
  }

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
  for (const t of projTimes) {
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
  for (const { label, dateStr, knownPrice } of PEAK_DATES) {
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

    let peakTime: number;
    let peakPrice: number;
    let peakLogDays: number;

    if (bestIdx !== -1) {
      // Found in data: search local max within ±6 weekly bars
      const window = 6;
      let maxIdx = bestIdx;
      for (
        let i = Math.max(0, bestIdx - window);
        i <= Math.min(times.length - 1, bestIdx + window);
        i++
      ) {
        if (prices[i] > prices[maxIdx]) maxIdx = i;
      }
      peakTime = times[maxIdx];
      peakPrice = prices[maxIdx];
      peakLogDays = logDaysArr[maxIdx];
    } else if (knownPrice != null) {
      // Pre-data peak (e.g. 2011, 2013): use documented historical price and
      // evaluate the fitted model via extrapolation to that date.
      peakTime = targetS;
      peakPrice = knownPrice;
      peakLogDays = Math.log(Math.max(1, (targetS - GENESIS_S) / DAY_S));
    } else {
      continue;
    }

    const upperBand = Math.exp(evalModel(upperCoeffs, peakLogDays));
    const pctOfUpper = peakPrice / upperBand;
    cyclePeaks.push({ time: peakTime, price: peakPrice, label, upperBand, pctOfUpper });
  }

  // ─── Current position ─────────────────────────────────────────────────────

  const lastPt = series[times.length - 1];
  const currentPrice = lastPt.price;
  const currentLower = lastPt.lower;
  const currentMedian = lastPt.median;
  const currentUpper = lastPt.upper;

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
