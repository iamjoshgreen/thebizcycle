import YahooFinanceClass from "yahoo-finance2";
// yahoo-finance2 v3 requires instantiation
const yahooFinance = new YahooFinanceClass();
import { logger } from "./logger.js";

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
}

export interface ChartPayload {
  composite: DataPoint[];
  spx: DataPoint[];
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

// Fetch FRED monthly series → date string → value
async function fetchFredMonthly(series: string): Promise<Map<string, number>> {
  if (!FRED_KEY) throw new Error("FRED_API_KEY not set");
  const url = `${FRED_BASE}?series_id=${series}&api_key=${FRED_KEY}&file_type=json&observation_start=1959-01-01&frequency=m`;
  const resp = await fetch(url);
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
  const resp = await fetch(url);
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
  logger.info("Fetching Yahoo Finance SPX data...");

  const endDate = getPreviousFriday(new Date());
  const startDate = new Date("1959-01-02");

  // Fetch SPX weekly from Yahoo Finance
  const spxResult = await yahooFinance.chart("^GSPC", {
    period1: "1959-01-01",
    period2: endDate.toISOString().slice(0, 10),
    interval: "1wk",
  });

  const spxMap = new Map<number, number>();
  if (spxResult.quotes) {
    for (const q of spxResult.quotes) {
      if (q.date && q.close != null) {
        const d = new Date(q.date);
        d.setHours(0, 0, 0, 0);
        const dow = d.getDay();
        if (dow !== 5) {
          d.setDate(d.getDate() + (dow === 0 ? 5 : 5 - dow));
        }
        spxMap.set(toUnix(d), q.close);
      }
    }
  }

  logger.info(`SPX data: ${spxMap.size} weekly bars`);
  logger.info("Fetching FRED data...");

  // Fetch all series in parallel
  const [unrateMap, fedfundsMap, cpiauscslMap, m2slMap, usrecMap, oilMap, dgs10Map, t10y2yMap] =
    await Promise.all([
      fetchFredMonthly("UNRATE"),
      fetchFredMonthly("FEDFUNDS"),
      fetchFredMonthly("CPIAUCSL"),
      fetchFredMonthly("M2SL"),
      fetchFredMonthly("USREC"),
      fetchFredWeekly("DCOILWTICO"),
      fetchFredWeekly("DGS10"),
      fetchFredWeekly("T10Y2Y"),
    ]);

  logger.info("FRED data fetched, computing composite...");

  const fridays = getFridays(startDate, endDate);

  // Forward-fill monthly series to weekly grid
  const unrateWeekly = forwardFill(unrateMap, fridays);
  const fedfundsWeekly = forwardFill(fedfundsMap, fridays);
  const cpiauscslWeekly = forwardFill(cpiauscslMap, fridays);
  const m2slWeekly = forwardFill(m2slMap, fridays);
  const usrecWeekly = forwardFill(usrecMap, fridays);

  // Forward-fill weekly FRED series (handles any missing weeks)
  const oilWeekly = forwardFill(oilMap, fridays);
  const dgs10Weekly = forwardFill(dgs10Map, fridays);
  const t10y2yWeekly = forwardFill(t10y2yMap, fridays);

  // Compute composite: (SPX × FEDFUNDS × CPIAUCSL) / (UNRATE² × M2SL)
  const composite: DataPoint[] = [];
  const spxSeries: DataPoint[] = [];

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
    recessions.push({ start: recStart, end: toUnix(endDate) });
  }

  logger.info(`Found ${recessions.length} recession intervals`);

  return {
    composite,
    spx: spxSeries,
    recessions,
    overlays: {
      oil: mapToSeries(oilWeekly),
      unrate: mapToSeries(unrateWeekly),
      fedfunds: mapToSeries(fedfundsWeekly),
      dgs10: mapToSeries(dgs10Weekly),
      t10y2y: mapToSeries(t10y2yWeekly),
    },
    lastUpdated: Math.floor(Date.now() / 1000),
  };
}
