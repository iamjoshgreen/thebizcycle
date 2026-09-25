import { logger } from "./logger.js";
import { fetchWithRetry } from "./fetchWithRetry.js";

const FRED_BASE = "https://api.stlouisfed.org/fred/series/observations";
const FRED_KEY = process.env.FRED_API_KEY;

// ─── Types (mirror the OpenAPI schema) ────────────────────────────────────────

export type RateShockStatus = "calm" | "warning" | "shock" | "insufficient";

export interface RateShockPoint {
  time: number; // unix seconds, last trading day of the week (UTC)
  value: number;
}

export interface RateShockEpisode {
  startTime: number; // first day the 3-month rise crossed the shock threshold
  peakTime: number; // day of the largest 3-month rise within the episode
  peakChangeBp: number;
  fromYield: number; // 10Y yield 63 trading days before the peak
  toYield: number; // 10Y yield at the peak
  active: boolean; // true if the episode is still running as of the latest print
  context: string | null; // what happened around it (editorial, null when nothing obvious)
}

export interface RateShockTrigger {
  tradingDaysAhead: number;
  approxDate: number; // unix seconds — latest date + N weekdays (ignores holidays)
  baseTime: number; // the date that becomes the 3-month-ago base on that day
  baseYield: number;
  triggerYield: number; // 10Y level needed on that day for a +100bp 3-month rise
}

export interface NberRecessionInterval {
  start: number;
  end: number;
}

export interface RateShockPayload {
  latestTime: number | null;
  latestYield: number | null;
  baseTime: number | null; // 63 trading days before latestTime
  baseYield: number | null;
  change1dBp: number | null;
  change5dBp: number | null;
  change21dBp: number | null;
  change63dBp: number | null; // the headline number
  windowTradingDays: number;
  warnThresholdBp: number;
  shockThresholdBp: number;
  status: RateShockStatus;
  statusLabel: string;
  translation: string;
  blurb: string;
  triggers: RateShockTrigger[];
  history: RateShockPoint[]; // weekly 3-month change in bp
  yieldHistory: RateShockPoint[]; // weekly 10Y level in %
  episodes: RateShockEpisode[];
  nberRecessions: NberRecessionInterval[];
  partialData: boolean;
  notes: string[];
  lastUpdated: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const OBS_START = "1962-01-01"; // DGS10 daily history begins Jan 1962
const WINDOW = 63; // ~3 months of trading days
const WARN_BP = 50;
const SHOCK_BP = 100;
// Flagged days closer than this (in trading days) belong to the same episode,
// so one long rally counts once instead of once per burst.
const EPISODE_MERGE_GAP = 126;
const TRIGGER_HORIZONS = [1, 5, 10, 21];

// Editorial: what happened during or shortly after each episode, keyed by the
// year of the episode's peak. Left null when nothing clearly broke.
const EPISODE_CONTEXT: Record<number, string> = {
  1970: "Penn Central bankruptcy, commercial paper freeze (Jun 1970)",
  1971: "Nixon closes the gold window (Aug 1971)",
  1980: "Silver crash (Mar 1980), 1980 recession",
  1984: "Continental Illinois bank failure (May 1984)",
  1987: "Black Monday crash (Oct 1987)",
  1994: "Bond massacre; Orange County bankruptcy, peso crisis (Dec 1994)",
  2011: "Euro debt crisis, US credit downgrade (Aug 2011)",
  2013: "Taper tantrum, emerging-market selloff",
  2022: "UK gilt/LDI crisis (Sep 2022), FTX collapse (Nov 2022)",
  2023: "NYCB regional-bank scare (Feb 2024)",
};

// ─── FRED helpers ─────────────────────────────────────────────────────────────

interface FredPoint {
  time: number; // unix seconds at midnight UTC of the observation date
  value: number;
}

async function fetchFred(series: string): Promise<FredPoint[]> {
  if (!FRED_KEY) throw new Error("FRED_API_KEY not set");
  const url = `${FRED_BASE}?series_id=${series}&api_key=${FRED_KEY}&file_type=json&observation_start=${OBS_START}`;
  const resp = await fetchWithRetry(url, { label: `FRED ${series}` });
  if (!resp.ok) throw new Error(`FRED error ${resp.status} for ${series}`);
  const json = (await resp.json()) as { observations: Array<{ date: string; value: string }> };
  const out: FredPoint[] = [];
  for (const obs of json.observations) {
    const v = parseFloat(obs.value);
    if (!isFinite(v)) continue; // DGS10 uses "." for market holidays
    const ts = Math.floor(new Date(obs.date + "T00:00:00Z").getTime() / 1000);
    out.push({ time: ts, value: v });
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

async function tryFetchFred(series: string): Promise<FredPoint[] | null> {
  try {
    return await fetchFred(series);
  } catch (err) {
    logger.warn({ err, series }, "FRED fetch failed (rate shock)");
    return null;
  }
}

// ─── Computation ──────────────────────────────────────────────────────────────

const DAY = 86400;

// Monday-based week index. 1970-01-01 was a Thursday, hence the +3.
function weekIndex(ts: number): number {
  return Math.floor((Math.floor(ts / DAY) + 3) / 7);
}

function bp(later: number, earlier: number): number {
  return Math.round((later - earlier) * 100);
}

function changeBp(points: FredPoint[], days: number): number | null {
  const n = points.length;
  if (n <= days) return null;
  return bp(points[n - 1].value, points[n - 1 - days].value);
}

// Rolling 63-trading-day change in bp, aligned so changes[i] ends at points[i].
// Entries before the first full window are null.
function rollingChanges(points: FredPoint[]): Array<number | null> {
  return points.map((p, i) => (i < WINDOW ? null : bp(p.value, points[i - WINDOW].value)));
}

// Keep the last trading day of each week, plus the latest point, so the chart
// carries ~3,300 points instead of ~16,000.
function weekly(points: FredPoint[], values: Array<number | null>): RateShockPoint[] {
  const out: RateShockPoint[] = [];
  for (let i = 0; i < points.length; i++) {
    const v = values[i];
    if (v == null) continue;
    const isLast = i === points.length - 1;
    if (isLast || weekIndex(points[i + 1].time) !== weekIndex(points[i].time)) {
      out.push({ time: points[i].time, value: v });
    }
  }
  return out;
}

function findEpisodes(points: FredPoint[], changes: Array<number | null>): RateShockEpisode[] {
  const out: RateShockEpisode[] = [];
  let cur: { startIdx: number; lastIdx: number; peakIdx: number } | null = null;
  const flush = () => {
    if (!cur) return;
    const peak = points[cur.peakIdx];
    out.push({
      startTime: points[cur.startIdx].time,
      peakTime: peak.time,
      peakChangeBp: changes[cur.peakIdx]!,
      fromYield: points[cur.peakIdx - WINDOW].value,
      toYield: peak.value,
      active: cur.lastIdx === points.length - 1,
      context: EPISODE_CONTEXT[new Date(peak.time * 1000).getUTCFullYear()] ?? null,
    });
  };
  for (let i = 0; i < points.length; i++) {
    const c = changes[i];
    if (c == null || c < SHOCK_BP) continue;
    if (cur && i - cur.lastIdx < EPISODE_MERGE_GAP) {
      cur.lastIdx = i;
      if (c > changes[cur.peakIdx]!) cur.peakIdx = i;
    } else {
      flush();
      cur = { startIdx: i, lastIdx: i, peakIdx: i };
    }
  }
  flush();
  return out;
}

function addWeekdays(ts: number, n: number): number {
  let t = ts;
  let added = 0;
  while (added < n) {
    t += DAY;
    const dow = new Date(t * 1000).getUTCDay();
    if (dow !== 0 && dow !== 6) added++;
  }
  return t;
}

// On day latest+h, the 3-month base is the point WINDOW-h trading days back
// from the latest print. Hitting the shock threshold then needs base + 1.00%.
function buildTriggers(points: FredPoint[]): RateShockTrigger[] {
  const n = points.length;
  if (n <= WINDOW) return [];
  const latest = points[n - 1];
  return TRIGGER_HORIZONS.map((h) => {
    const base = points[n - 1 - WINDOW + h];
    return {
      tradingDaysAhead: h,
      approxDate: addWeekdays(latest.time, h),
      baseTime: base.time,
      baseYield: base.value,
      triggerYield: Math.round((base.value + SHOCK_BP / 100) * 100) / 100,
    };
  });
}

function buildNberRecessions(usrec: FredPoint[] | null): NberRecessionInterval[] {
  if (!usrec || usrec.length === 0) return [];
  const out: NberRecessionInterval[] = [];
  let runStart: number | null = null;
  let runEnd: number | null = null;
  for (const p of usrec) {
    if (p.value >= 1) {
      if (runStart == null) runStart = p.time;
      runEnd = p.time;
    } else if (runStart != null && runEnd != null) {
      out.push({ start: runStart, end: runEnd });
      runStart = null;
      runEnd = null;
    }
  }
  if (runStart != null && runEnd != null) out.push({ start: runStart, end: runEnd });
  return out;
}

function statusFor(change: number | null): RateShockStatus {
  if (change == null) return "insufficient";
  if (change >= SHOCK_BP) return "shock";
  if (change >= WARN_BP) return "warning";
  return "calm";
}

// ─── Plain-English templates (deterministic — same inputs → same string) ─────

function makeCopy(
  status: RateShockStatus,
  change: number | null,
  episodeCount: number // completed episodes, excluding one still running
): { label: string; translation: string; blurb: string } {
  if (status === "insufficient" || change == null) {
    return {
      label: "Insufficient data",
      translation: "Translation: not enough 10-year yield data to compute the 3-month change.",
      blurb: "The DGS10 series from FRED is unavailable or too short right now.",
    };
  }
  if (status === "shock") {
    return {
      label: "Rate shock",
      translation: `Translation: the 10-year is up ${change}bp in 3 months. That's shock pace — something tends to break.`,
      blurb: `Before this one, it happened ${episodeCount} times since 1962. Most were followed by a financial accident within months, sometimes years.`,
    };
  }
  if (status === "warning") {
    return {
      label: "Warning — approaching shock pace",
      translation: `Translation: the 10-year is up ${change}bp in 3 months, ${SHOCK_BP - change}bp short of shock pace.`,
      blurb: `Fast, but not yet the kind of move (≥ +${SHOCK_BP}bp in 3 months) that preceded past financial accidents.`,
    };
  }
  const direction = change >= 0 ? `up ${change}bp` : `down ${-change}bp`;
  return {
    label: "Calm",
    translation: `Translation: the 10-year is ${direction} over 3 months. Normal pace — no rate shock.`,
    blurb: `Rate shocks start at +${SHOCK_BP}bp in 3 months. Warning zone starts at +${WARN_BP}bp.`,
  };
}

// ─── Public entrypoints ───────────────────────────────────────────────────────

export function buildRateShockPayload(
  dgs10: FredPoint[] | null,
  usrec: FredPoint[] | null
): RateShockPayload {
  const points = dgs10 ?? [];
  const n = points.length;
  const changes = rollingChanges(points);
  const change63dBp = changeBp(points, WINDOW);
  const episodes = findEpisodes(points, changes);
  const status = statusFor(change63dBp);
  const pastEpisodes = episodes.filter((e) => !e.active).length;
  const { label, translation, blurb } = makeCopy(status, change63dBp, pastEpisodes);

  const notes: string[] = [];
  let partialData = false;
  if (!dgs10 || n <= WINDOW) {
    partialData = true;
    notes.push("10-Year Treasury yield (DGS10) unavailable or too short");
  }
  if (!usrec) {
    partialData = true;
    notes.push("NBER recession history (USREC) unavailable — chart shading omitted");
  }

  return {
    latestTime: n > 0 ? points[n - 1].time : null,
    latestYield: n > 0 ? points[n - 1].value : null,
    baseTime: n > WINDOW ? points[n - 1 - WINDOW].time : null,
    baseYield: n > WINDOW ? points[n - 1 - WINDOW].value : null,
    change1dBp: changeBp(points, 1),
    change5dBp: changeBp(points, 5),
    change21dBp: changeBp(points, 21),
    change63dBp,
    windowTradingDays: WINDOW,
    warnThresholdBp: WARN_BP,
    shockThresholdBp: SHOCK_BP,
    status,
    statusLabel: label,
    translation,
    blurb,
    triggers: buildTriggers(points),
    history: weekly(points, changes),
    yieldHistory: weekly(points, points.map((p) => p.value)),
    episodes,
    nberRecessions: buildNberRecessions(usrec),
    partialData,
    notes,
    lastUpdated: Math.floor(Date.now() / 1000),
  };
}

export async function fetchRateShockPayload(): Promise<RateShockPayload> {
  logger.info("Fetching rate shock FRED series...");
  const [dgs10, usrec] = await Promise.all([tryFetchFred("DGS10"), tryFetchFred("USREC")]);
  if (!dgs10) throw new Error("DGS10 unavailable from FRED");
  return buildRateShockPayload(dgs10, usrec);
}
