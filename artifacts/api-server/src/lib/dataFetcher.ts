import YahooFinanceClass from "yahoo-finance2";
// yahoo-finance2 v3 requires instantiation
const yahooFinance = new YahooFinanceClass();
import { logger } from "./logger.js";
import { fetchWithRetry } from "./fetchWithRetry.js";

const FRED_BASE = "https://api.stlouisfed.org/fred/series/observations";
const FRED_KEY = process.env.FRED_API_KEY;

interface DataPoint {
  time: number;
  value: number;
}

interface RecessionInterval {
  start: number;
  end: number;
}

interface Overlays {
  oil: DataPoint[];
  unrate: DataPoint[];
  fedfunds: DataPoint[];
  dgs10: DataPoint[];
  t10y2y: DataPoint[];
  btc: DataPoint[];
  cpi: DataPoint[];
}

export interface ChartPayload {
  composite: DataPoint[];
  spx: DataPoint[];
  spxM2: DataPoint[];
  recessions: RecessionInterval[];
  overlays: Overlays;
  lastUpdated: number;
}

function getPreviousFriday(from: Date): Date {
  const d = new Date(from);
  d.setHours(0, 0, 0, 0);
  const dow = d.getDay();
  if (dow === 5) {
    d.setDate(d.getDate() - 7);
  } else if (dow < 5) {
    d.setDate(d.getDate() - dow - 2);
  } else {
    d.setDate(d.getDate() - 1);
  }
  return d;
}

function toUnix(d: Date): number {
  return Math.floor(d.getTime() / 1000);
}

function getFridays(start: Date, end: Date): Date[] {
  const fridays: Date[] = [];
  const d = new Date(start);
  while (d.getDay() !== 5) d.setDate(d.getDate() + 1);
  while (d <= end) {
    fridays.push(new Date(d));
    d.setDate(d.getDate() + 7);
  }
  return fridays;
}

// Yahoo Finance chart() with bounded retries + exponential backoff + per-attempt timeout.
// Uses the same transient-error policy as fetchWithRetry: retries network/timeout
// errors, fast-fails on errors that look like a permanent client problem, and
// throws a descriptive error after the final attempt.
interface YahooChartResult {
  quotes?: Array<{ date?: Date; close?: number | null }>;
}

async function yahooChartWithRetry(
  symbol: string,
  opts: { period1: string; period2: string; interval: "1wk" | "1d" | "1mo" },
): Promise<YahooChartResult> {
  const ATTEMPTS = 3;
  const BASE_DELAY = 400;
  const MAX_DELAY = 4000;
  const TIMEOUT_MS = 20_000;

  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const timeout = new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error(`Yahoo ${symbol} timeout after ${TIMEOUT_MS}ms`)), TIMEOUT_MS),
      );
      const result = await Promise.race<YahooChartResult>([
        yahooFinance.chart(symbol, opts) as Promise<YahooChartResult>,
        timeout,
      ]);
      return result;
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      // Permanent-looking client errors: bad symbol / 404 / validation. Don't retry.
      if (/Not Found|404|invalid|symbol/i.test(msg) && !/timeout|ECONN|ETIMEDOUT|network|fetch/i.test(msg)) {
        throw new Error(`Yahoo ${symbol} failed (non-transient): ${msg}`);
      }
      if (attempt === ATTEMPTS) break;
      logger.warn({ symbol, attempt, err: msg }, "yahooChartWithRetry: transient error, retrying");
      const delay = (0.5 + Math.random()) * Math.min(MAX_DELAY, BASE_DELAY * 2 ** (attempt - 1));
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error(
    `yahooChartWithRetry failed after ${ATTEMPTS} attempts for ${symbol}: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`,
  );
}

// Fetch FRED monthly series → date string → value
async function fetchFredMonthly(series: string, units?: string): Promise<Map<string, number>> {
  if (!FRED_KEY) throw new Error("FRED_API_KEY not set");
  const unitsParam = units ? `&units=${units}` : "";
  const url = `${FRED_BASE}?series_id=${series}&api_key=${FRED_KEY}&file_type=json&observation_start=1959-01-01&frequency=m${unitsParam}`;
  const resp = await fetchWithRetry(url, { label: `FRED ${series}` });
  if (!resp.ok) throw new Error(`FRED error ${resp.status} for ${series}`);
  const json = (await resp.json()) as { observations: Array<{ date: string; value: string }> };
  const map = new Map<string, number>();
  for (const obs of json.observations) {
    const v = parseFloat(obs.value);
    if (!isNaN(v)) map.set(obs.date, v);
  }
  return map;
}

// Fetch FRED weekly series → date string → value
async function fetchFredWeekly(series: string): Promise<Map<string, number>> {
  if (!FRED_KEY) throw new Error("FRED_API_KEY not set");
  const url = `${FRED_BASE}?series_id=${series}&api_key=${FRED_KEY}&file_type=json&observation_start=1959-01-01&frequency=w&aggregation_method=eop`;
  const resp = await fetchWithRetry(url, { label: `FRED ${series}` });
  if (!resp.ok) throw new Error(`FRED error ${resp.status} for ${series}`);
  const json = (await resp.json()) as { observations: Array<{ date: string; value: string }> };
  const map = new Map<string, number>();
  for (const obs of json.observations) {
    const v = parseFloat(obs.value);
    if (!isNaN(v)) map.set(obs.date, v);
  }
  return map;
}

// Forward-fill a date→value map to our weekly Friday grid
function forwardFill(
  fredMap: Map<string, number>,
  fridays: Date[]
): Map<number, number> {
  const sortedDates = Array.from(fredMap.keys()).sort();
  const result = new Map<number, number>();
  for (const friday of fridays) {
    const fridayStr = friday.toISOString().slice(0, 10);
    let val: number | undefined;
    for (let i = sortedDates.length - 1; i >= 0; i--) {
      if (sortedDates[i] <= fridayStr) {
        val = fredMap.get(sortedDates[i]);
        break;
      }
    }
    if (val !== undefined) result.set(toUnix(friday), val);
  }
  return result;
}

// Convert a weekly map to a DataPoint array sorted by time
function mapToSeries(m: Map<number, number>): DataPoint[] {
  return Array.from(m.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([time, value]) => ({ time, value }));
}

export async function fetchAndCompute(): Promise<ChartPayload> {
  logger.info("Fetching Yahoo Finance SPX + BTC data...");

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const startDate = new Date("1959-01-02");

  // period2 must extend past today's market session, otherwise Yahoo cuts
  // off the current trading day entirely (period2 is interpreted as the
  // *start* of the day in UTC). Use tomorrow's date so today's close is
  // always included as soon as Yahoo publishes it.
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const period2 = tomorrow.toISOString().slice(0, 10);

  const [spxResult, btcResult] = await Promise.all([
    yahooChartWithRetry("^GSPC", { period1: "1959-01-01", period2, interval: "1wk" }),
    yahooChartWithRetry("BTC-USD", { period1: "2010-01-01", period2, interval: "1wk" }),
  ]);

  // Anchor each Yahoo weekly bar (dated by its Monday) to that week's
  // Friday. If the computed Friday is in the future (refresh on a Mon–Thu,
  // a holiday Monday, etc.), anchor that in-progress bar to today so the
  // latest available close stays visible. This is safe — today and the
  // prior week's actual Friday are different timestamps, so the prior
  // week's completed close is not overwritten.
  function anchorToFriday(barDateRaw: Date): number {
    const d = new Date(barDateRaw);
    d.setHours(0, 0, 0, 0);
    const dow = d.getDay();
    if (dow !== 5) {
      d.setDate(d.getDate() + (dow === 0 ? 5 : 5 - dow));
    }
    return d > today ? toUnix(today) : toUnix(d);
  }

  const spxMap = new Map<number, number>();
  if (spxResult.quotes) {
    for (const q of spxResult.quotes) {
      if (q.date && q.close != null) {
        spxMap.set(anchorToFriday(q.date), q.close);
      }
    }
  }

  const btcMap = new Map<number, number>();
  if (btcResult.quotes) {
    for (const q of btcResult.quotes) {
      if (q.date && q.close != null) {
        btcMap.set(anchorToFriday(q.date), q.close);
      }
    }
  }

  // Log the latest SPX close so future drift is visible in workflow logs
  const latestSpxTs = Array.from(spxMap.keys()).sort((a, b) => b - a)[0];
  if (latestSpxTs != null) {
    const latestSpxDate = new Date(latestSpxTs * 1000).toISOString().slice(0, 10);
    logger.info(`SPX latest: ${latestSpxDate} = ${spxMap.get(latestSpxTs)}`);
  }
  const latestBtcTs = Array.from(btcMap.keys()).sort((a, b) => b - a)[0];
  if (latestBtcTs != null) {
    const latestBtcDate = new Date(latestBtcTs * 1000).toISOString().slice(0, 10);
    logger.info(`BTC latest: ${latestBtcDate} = ${btcMap.get(latestBtcTs)}`);
  }
  logger.info(`SPX data: ${spxMap.size} weekly bars, BTC: ${btcMap.size} weekly bars`);
  logger.info("Fetching FRED data...");

  // Fetch all series in parallel
  const [unrateMap, fedfundsMap, cpiauscslMap, cpiYoYMap, m2slMap, usrecMap, oilMap, dgs10Map, t10y2yMap, wm2nsMap] =
    await Promise.all([
      fetchFredMonthly("UNRATE"),
      fetchFredMonthly("FEDFUNDS"),
      fetchFredMonthly("CPIAUCSL"),
      fetchFredMonthly("CPIAUCSL", "pc1"),
      fetchFredMonthly("M2SL"),
      fetchFredMonthly("USREC"),
      fetchFredWeekly("DCOILWTICO"),
      fetchFredWeekly("DGS10"),
      fetchFredWeekly("T10Y2Y"),
      fetchFredWeekly("WM2NS"),
    ]);

  logger.info("FRED data fetched, computing composite...");

  const fridays = getFridays(startDate, today);
  // Include today if it's not a Friday so the current partial week shows up
  if (today.getDay() !== 5) {
    fridays.push(new Date(today));
  }

  // Forward-fill monthly series to weekly grid
  const unrateWeekly = forwardFill(unrateMap, fridays);
  const fedfundsWeekly = forwardFill(fedfundsMap, fridays);
  const cpiauscslWeekly = forwardFill(cpiauscslMap, fridays);
  const cpiYoYWeekly = forwardFill(cpiYoYMap, fridays);
  const m2slWeekly = forwardFill(m2slMap, fridays);
  const usrecWeekly = forwardFill(usrecMap, fridays);

  // Forward-fill weekly FRED series (handles any missing weeks)
  const oilWeekly = forwardFill(oilMap, fridays);
  const dgs10Weekly = forwardFill(dgs10Map, fridays);
  const t10y2yWeekly = forwardFill(t10y2yMap, fridays);
  const wm2nsWeekly = forwardFill(wm2nsMap, fridays);
  // BTC: convert map to a date-string map then forward-fill onto the Friday grid
  const btcDateMap = new Map<string, number>();
  for (const [ts, v] of btcMap.entries()) {
    const dateStr = new Date(ts * 1000).toISOString().slice(0, 10);
    btcDateMap.set(dateStr, v);
  }
  const btcWeekly = forwardFill(btcDateMap, fridays);

  // Compute composite: (SPX × FEDFUNDS × CPIAUCSL) / (UNRATE² × M2SL)
  // and SPX/WM2NS (M2-normalized SPX, mirrors SPX/WM2NS on TradingView)
  const composite: DataPoint[] = [];
  const spxSeries: DataPoint[] = [];
  const spxM2Series: DataPoint[] = [];

  for (const friday of fridays) {
    const ts = toUnix(friday);
    const spx = spxMap.get(ts);
    const unrate = unrateWeekly.get(ts);
    const fedfunds = fedfundsWeekly.get(ts);
    const cpiaucsl = cpiauscslWeekly.get(ts);
    const m2sl = m2slWeekly.get(ts);

    if (spx == null || unrate == null || fedfunds == null || cpiaucsl == null || m2sl == null) continue;

    const denom = unrate * unrate * m2sl;
    if (denom === 0) continue;

    composite.push({ time: ts, value: (spx * fedfunds * cpiaucsl) / denom });
    spxSeries.push({ time: ts, value: spx });

    // SPX / WM2NS (only when WM2NS is available — starts ~1980)
    const wm2ns = wm2nsWeekly.get(ts);
    if (wm2ns != null && wm2ns > 0) {
      spxM2Series.push({ time: ts, value: spx / wm2ns });
    }
  }

  logger.info(`Composite computed: ${composite.length} data points`);

  // Compute recession intervals from USREC
  const recessions: RecessionInterval[] = [];
  let inRecession = false;
  let recStart = 0;

  const sortedFridays = [...fridays].sort((a, b) => a.getTime() - b.getTime());
  for (const friday of sortedFridays) {
    const ts = toUnix(friday);
    const isRec = (usrecWeekly.get(ts) ?? 0) === 1;
    if (isRec && !inRecession) {
      inRecession = true;
      recStart = ts;
    } else if (!isRec && inRecession) {
      inRecession = false;
      recessions.push({ start: recStart, end: ts });
    }
  }
  if (inRecession && recStart > 0) {
    recessions.push({ start: recStart, end: toUnix(today) });
  }

  logger.info(`Found ${recessions.length} recession intervals`);

  return {
    composite,
    spx: spxSeries,
    spxM2: spxM2Series,
    recessions,
    overlays: {
      oil: mapToSeries(oilWeekly),
      unrate: mapToSeries(unrateWeekly),
      fedfunds: mapToSeries(fedfundsWeekly),
      dgs10: mapToSeries(dgs10Weekly),
      t10y2y: mapToSeries(t10y2yWeekly),
      btc: mapToSeries(btcWeekly),
      cpi: mapToSeries(cpiYoYWeekly),
    },
    lastUpdated: Math.floor(Date.now() / 1000),
  };
}
