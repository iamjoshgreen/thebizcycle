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

export interface ChartPayload {
  composite: DataPoint[];
  spx: DataPoint[];
  recessions: RecessionInterval[];
  lastUpdated: number;
}

// Returns the most recent completed Friday (not today if today is Friday and market hasn't closed)
function lastFriday(from?: Date): Date {
  const d = from ? new Date(from) : new Date();
  d.setHours(0, 0, 0, 0);
  // 5 = Friday in getDay()
  const day = d.getDay(); // 0=Sun .. 6=Sat
  // days to subtract to get to last Friday
  const diff = day === 5 ? 7 : ((day + 2) % 7) + 1;
  d.setDate(d.getDate() - (day === 0 ? 2 : day === 6 ? 1 : day + 2 - 7 + (day < 5 ? 7 : 0)));
  // simpler approach:
  return getPreviousFriday(new Date());
}

function getPreviousFriday(from: Date): Date {
  const d = new Date(from);
  d.setHours(0, 0, 0, 0);
  const dow = d.getDay(); // 0=Sun, 5=Fri, 6=Sat
  if (dow === 5) {
    // It's Friday - go back 7 days to get last completed Friday
    d.setDate(d.getDate() - 7);
  } else if (dow < 5) {
    d.setDate(d.getDate() - dow - 2);
  } else {
    // Saturday
    d.setDate(d.getDate() - 1);
  }
  return d;
}

function toUnix(d: Date): number {
  return Math.floor(d.getTime() / 1000);
}

// Get all Fridays between start and end (inclusive)
function getFridays(start: Date, end: Date): Date[] {
  const fridays: Date[] = [];
  const d = new Date(start);
  // Advance to the first Friday on or after start
  while (d.getDay() !== 5) d.setDate(d.getDate() + 1);
  while (d <= end) {
    fridays.push(new Date(d));
    d.setDate(d.getDate() + 7);
  }
  return fridays;
}

// Fetch FRED series, returns map of YYYY-MM-DD -> value
async function fetchFred(series: string): Promise<Map<string, number>> {
  if (!FRED_KEY) throw new Error("FRED_API_KEY not set");
  const url = `${FRED_BASE}?series_id=${series}&api_key=${FRED_KEY}&file_type=json&observation_start=1959-01-01&frequency=m`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`FRED error ${resp.status} for ${series}`);
  const json = (await resp.json()) as {
    observations: Array<{ date: string; value: string }>;
  };
  const map = new Map<string, number>();
  for (const obs of json.observations) {
    const v = parseFloat(obs.value);
    if (!isNaN(v)) map.set(obs.date, v);
  }
  return map;
}

// Given a monthly FRED map, forward-fill to weekly Fridays
function forwardFill(
  fredMap: Map<string, number>,
  fridays: Date[]
): Map<number, number> {
  // Sort the FRED dates
  const sortedDates = Array.from(fredMap.keys()).sort();
  const result = new Map<number, number>();

  for (const friday of fridays) {
    const fridayStr = friday.toISOString().slice(0, 10);
    // Find the most recent FRED date <= this Friday
    let val: number | undefined;
    for (let i = sortedDates.length - 1; i >= 0; i--) {
      if (sortedDates[i] <= fridayStr) {
        val = fredMap.get(sortedDates[i]);
        break;
      }
    }
    if (val !== undefined) {
      result.set(toUnix(friday), val);
    }
  }
  return result;
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

  // Build SPX map: unix timestamp -> close
  const spxMap = new Map<number, number>();
  if (spxResult.quotes) {
    for (const q of spxResult.quotes) {
      if (q.date && q.close != null) {
        // Normalize to Friday
        const d = new Date(q.date);
        d.setHours(0, 0, 0, 0);
        // Yahoo returns week starting Monday; we want the Friday close
        // Actually Yahoo weekly bars have date = first day of week (Monday)
        // Advance to Friday of that week
        const dow = d.getDay();
        if (dow !== 5) {
          const daysToFriday = dow === 0 ? 5 : 5 - dow;
          d.setDate(d.getDate() + daysToFriday);
        }
        spxMap.set(toUnix(d), q.close);
      }
    }
  }

  logger.info(`SPX data: ${spxMap.size} weekly bars`);

  // Fetch FRED series
  logger.info("Fetching FRED data...");
  const [unrateMap, fedfundsMap, cpiauscslMap, m2slMap, usrecMap] =
    await Promise.all([
      fetchFred("UNRATE"),
      fetchFred("FEDFUNDS"),
      fetchFred("CPIAUCSL"),
      fetchFred("M2SL"),
      fetchFred("USREC"),
    ]);

  logger.info("FRED data fetched, computing composite...");

  // Get all Fridays in range
  const fridays = getFridays(startDate, endDate);

  // Forward-fill each FRED series to weekly
  const unrateWeekly = forwardFill(unrateMap, fridays);
  const fedfundsWeekly = forwardFill(fedfundsMap, fridays);
  const cpiauscslWeekly = forwardFill(cpiauscslMap, fridays);
  const m2slWeekly = forwardFill(m2slMap, fridays);
  const usrecWeekly = forwardFill(usrecMap, fridays);

  // Compute composite: (SPX * FEDFUNDS * CPIAUCSL) / (UNRATE^2 * M2SL)
  const composite: DataPoint[] = [];
  const spxSeries: DataPoint[] = [];

  for (const friday of fridays) {
    const ts = toUnix(friday);
    const spx = spxMap.get(ts);
    const unrate = unrateWeekly.get(ts);
    const fedfunds = fedfundsWeekly.get(ts);
    const cpiaucsl = cpiauscslWeekly.get(ts);
    const m2sl = m2slWeekly.get(ts);

    // Skip if any value is missing
    if (
      spx == null ||
      unrate == null ||
      fedfunds == null ||
      cpiaucsl == null ||
      m2sl == null
    )
      continue;

    // Skip if denominator would be 0
    const denom = unrate * unrate * m2sl;
    if (denom === 0) continue;

    const comp = (spx * fedfunds * cpiaucsl) / denom;
    composite.push({ time: ts, value: comp });
    spxSeries.push({ time: ts, value: spx });
  }

  logger.info(`Composite computed: ${composite.length} data points`);

  // Compute recession intervals from USREC
  const recessions: RecessionInterval[] = [];
  let inRecession = false;
  let recStart = 0;

  const sortedFridays = fridays.sort((a, b) => a.getTime() - b.getTime());
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
    lastUpdated: Math.floor(Date.now() / 1000),
  };
}
