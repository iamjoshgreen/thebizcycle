import { logger } from "./logger.js";

const FRED_BASE = "https://api.stlouisfed.org/fred/series/observations";
const FRED_KEY = process.env.FRED_API_KEY;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CjiMonthlyPoint {
  time: number; // unix seconds, first of month UTC
  value: number;
}

export type RecessionStatus = "expansion" | "warning" | "signal" | "insufficient";

export type SectorId =
  | "residentialConstruction"
  | "durableGoods"
  | "totalConstruction"
  | "totalManufacturing";

export interface SectorStats {
  id: SectorId;
  label: string;
  series: string; // FRED id
  role: "leader" | "confirmation";
  current: number | null;
  currentDate: number | null;
  peakValue: number | null;
  peakDate: number | null;
  pctOffPeak: number | null; // negative when below peak
  monthsSincePeak: number | null;
  yoyPct: number | null; // % vs 12 months ago
  ann3mPct: number | null; // 3-month annualized % change (compound)
  status: RecessionStatus; // per-row color, derived from pctOffPeak
}

export interface NberRecessionInterval {
  start: number; // unix seconds, first day of recession month
  end: number; // unix seconds, last month of recession (USREC=1)
}

export interface RecessionPayload {
  cji: number | null;
  cjiStatus: RecessionStatus;
  cjiLabel: string; // e.g. "Expansion", "Warning — clock has started", "Recession Warning — 9-29mo lead"
  cjiBlurb: string; // one-line plain-English description
  confirmedRed: boolean; // CJI <= -1.5 AND both leaders' 3M-ann < 0 for 2+ consecutive months
  sectors: SectorStats[]; // 4 rows: 2 leaders + 2 confirmations
  cjiHistory: CjiMonthlyPoint[]; // historical CJI (rolling 60-mo peak), 30+ years
  nberRecessions: NberRecessionInterval[]; // for chart shading
  payemsYoY: CjiMonthlyPoint[]; // context: PAYEMS YoY % over same span
  dataAsOf: number | null; // unix seconds — last shared month between leaders (alias of lastFredDate)
  lastFredDate: number | null; // unix seconds — last leader observation date used for headline CJI
  partialData: boolean; // true if any series was missing or short
  notes: string[]; // human-readable warnings (missing series, short series, etc.)
  lastUpdated: number;
}

// ─── Series catalog ───────────────────────────────────────────────────────────

const SECTORS: Array<{
  id: SectorId;
  label: string;
  series: string;
  role: "leader" | "confirmation";
}> = [
  { id: "residentialConstruction", label: "Residential Construction", series: "CES2023610001", role: "leader" },
  { id: "durableGoods", label: "Durable Goods Manufacturing", series: "DMANEMP", role: "leader" },
  { id: "totalConstruction", label: "Total Construction", series: "USCONS", role: "confirmation" },
  { id: "totalManufacturing", label: "Total Manufacturing", series: "MANEMP", role: "confirmation" },
];

const PAYEMS_SERIES = "PAYEMS";
const USREC_SERIES = "USREC";

const PEAK_WINDOW_MONTHS = 60;
const HISTORY_OBS_START = "1990-01-01"; // 30+ years for the historical chart

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface FredPoint {
  time: number; // unix seconds, first-of-month UTC
  value: number;
}

async function fetchFred(series: string, observationStart = HISTORY_OBS_START): Promise<FredPoint[]> {
  if (!FRED_KEY) throw new Error("FRED_API_KEY not set");
  const url = `${FRED_BASE}?series_id=${series}&api_key=${FRED_KEY}&file_type=json&observation_start=${observationStart}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`FRED error ${resp.status} for ${series}`);
  const json = (await resp.json()) as { observations: Array<{ date: string; value: string }> };
  const out: FredPoint[] = [];
  for (const obs of json.observations) {
    const v = parseFloat(obs.value);
    if (!isFinite(v)) continue;
    // FRED dates are YYYY-MM-DD, monthly series use YYYY-MM-01.
    const ts = Math.floor(new Date(obs.date + "T00:00:00Z").getTime() / 1000);
    out.push({ time: ts, value: v });
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

// Returns null if either series fails — callers handle gracefully.
async function tryFetchFred(series: string): Promise<FredPoint[] | null> {
  try {
    return await fetchFred(series);
  } catch (err) {
    logger.warn({ err, series }, "FRED fetch failed");
    return null;
  }
}

function monthsBetween(laterTs: number, earlierTs: number): number {
  const a = new Date(laterTs * 1000);
  const b = new Date(earlierTs * 1000);
  return (
    (a.getUTCFullYear() - b.getUTCFullYear()) * 12 +
    (a.getUTCMonth() - b.getUTCMonth())
  );
}

// Rolling N-month peak (inclusive of current). Returns the peak point itself.
function rollingPeak(points: FredPoint[], endIdx: number, windowMonths: number): FredPoint {
  const start = Math.max(0, endIdx - windowMonths + 1);
  let peak = points[start];
  for (let i = start; i <= endIdx; i++) {
    if (points[i].value > peak.value) peak = points[i];
  }
  return peak;
}

function pctOffPeak(current: number, peak: number): number {
  if (peak <= 0) return 0;
  return ((current - peak) / peak) * 100;
}

function yoyPercent(points: FredPoint[], idx: number): number | null {
  if (idx < 12) return null;
  const cur = points[idx].value;
  const prev = points[idx - 12].value;
  if (prev <= 0) return null;
  return ((cur - prev) / prev) * 100;
}

function ann3mPercent(points: FredPoint[], idx: number): number | null {
  if (idx < 3) return null;
  const cur = points[idx].value;
  const prev = points[idx - 3].value;
  if (prev <= 0) return null;
  // Compound annualized: ((cur/prev)^(12/3) - 1) * 100
  return (Math.pow(cur / prev, 4) - 1) * 100;
}

function statusFromPctOffPeak(pct: number | null): RecessionStatus {
  if (pct == null) return "insufficient";
  if (pct >= -0.5) return "expansion";
  if (pct >= -1.5) return "warning";
  return "signal";
}

// ─── Per-sector computation ───────────────────────────────────────────────────

// Compute stats for a sector "as of" a specific index. If `asOfIdx` is null,
// the latest available point is used. Returns insufficient stats when the
// requested index is unavailable (e.g. that month is missing for this series).
function computeSector(
  meta: { id: SectorId; label: string; series: string; role: "leader" | "confirmation" },
  points: FredPoint[] | null,
  asOfIdx: number | null = null
): SectorStats {
  if (!points || points.length === 0) {
    return {
      ...meta,
      current: null,
      currentDate: null,
      peakValue: null,
      peakDate: null,
      pctOffPeak: null,
      monthsSincePeak: null,
      yoyPct: null,
      ann3mPct: null,
      status: "insufficient",
    };
  }
  const idx = asOfIdx ?? points.length - 1;
  if (idx < 0 || idx >= points.length) {
    return {
      ...meta,
      current: null,
      currentDate: null,
      peakValue: null,
      peakDate: null,
      pctOffPeak: null,
      monthsSincePeak: null,
      yoyPct: null,
      ann3mPct: null,
      status: "insufficient",
    };
  }
  const at = points[idx];
  const peak = rollingPeak(points, idx, PEAK_WINDOW_MONTHS);
  const pop = pctOffPeak(at.value, peak.value);
  return {
    ...meta,
    current: at.value,
    currentDate: at.time,
    peakValue: peak.value,
    peakDate: peak.time,
    pctOffPeak: pop,
    monthsSincePeak: monthsBetween(at.time, peak.time),
    yoyPct: yoyPercent(points, idx),
    ann3mPct: ann3mPercent(points, idx),
    status: statusFromPctOffPeak(pop),
  };
}

// Build a quick timestamp -> index map for a series.
function indexByTime(points: FredPoint[] | null): Map<number, number> {
  const m = new Map<number, number>();
  if (!points) return m;
  for (let i = 0; i < points.length; i++) m.set(points[i].time, i);
  return m;
}

// ─── Historical CJI series ────────────────────────────────────────────────────

// At each month present in BOTH leader series (after at least one full month of
// data exists), compute CJI using the rolling 60-month peak as-of that month.
function buildCjiHistory(
  resCons: FredPoint[] | null,
  durGoods: FredPoint[] | null
): CjiMonthlyPoint[] {
  if (!resCons || !durGoods || resCons.length === 0 || durGoods.length === 0) return [];

  // Index both by unix time so we only emit points where both exist.
  const dgByTime = new Map<number, number>();
  for (let i = 0; i < durGoods.length; i++) dgByTime.set(durGoods[i].time, i);

  const out: CjiMonthlyPoint[] = [];
  for (let i = 0; i < resCons.length; i++) {
    const t = resCons[i].time;
    const dgIdx = dgByTime.get(t);
    if (dgIdx == null) continue;

    const peakRC = rollingPeak(resCons, i, PEAK_WINDOW_MONTHS);
    const peakDG = rollingPeak(durGoods, dgIdx, PEAK_WINDOW_MONTHS);
    const popRC = pctOffPeak(resCons[i].value, peakRC.value);
    const popDG = pctOffPeak(durGoods[dgIdx].value, peakDG.value);
    out.push({ time: t, value: (popRC + popDG) / 2 });
  }
  return out;
}

// ─── PAYEMS YoY context series ────────────────────────────────────────────────

function buildPayemsYoY(payems: FredPoint[] | null): CjiMonthlyPoint[] {
  if (!payems || payems.length < 13) return [];
  const out: CjiMonthlyPoint[] = [];
  for (let i = 12; i < payems.length; i++) {
    const cur = payems[i].value;
    const prev = payems[i - 12].value;
    if (prev <= 0) continue;
    out.push({ time: payems[i].time, value: ((cur - prev) / prev) * 100 });
  }
  return out;
}

// ─── NBER recession intervals from USREC ──────────────────────────────────────

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

// ─── Confirmation rule + label ────────────────────────────────────────────────

// RED only if CJI <= -1.5% AND 3-month annualized is negative for BOTH leaders
// for 2+ consecutive months. Months are matched by timestamp on the shared
// CJI history (so leader lag/missing observations cannot misalign the check).
function checkConfirmedRed(
  cjiHistory: CjiMonthlyPoint[],
  resCons: FredPoint[] | null,
  durGoods: FredPoint[] | null
): boolean {
  if (cjiHistory.length < 2) return false;
  if (!resCons || !durGoods) return false;

  // Most recent CJI must already be in red zone.
  const latest = cjiHistory[cjiHistory.length - 1];
  if (latest.value > -1.5) return false;

  const rcByTime = indexByTime(resCons);
  const dgByTime = indexByTime(durGoods);

  const checkMonth = (ts: number): boolean => {
    const rcIdx = rcByTime.get(ts);
    const dgIdx = dgByTime.get(ts);
    if (rcIdx == null || dgIdx == null) return false;
    const rcAnn = ann3mPercent(resCons, rcIdx);
    const dgAnn = ann3mPercent(durGoods, dgIdx);
    return rcAnn != null && rcAnn < 0 && dgAnn != null && dgAnn < 0;
  };

  const lastTs = cjiHistory[cjiHistory.length - 1].time;
  const prevTs = cjiHistory[cjiHistory.length - 2].time;
  return checkMonth(lastTs) && checkMonth(prevTs);
}

function makeLabel(status: RecessionStatus, confirmedRed: boolean): { label: string; blurb: string } {
  if (status === "insufficient") {
    return {
      label: "Insufficient data",
      blurb: "One or both leading series are unavailable — cannot compute the index right now.",
    };
  }
  if (status === "expansion") {
    return {
      label: "Expansion",
      blurb: "Both cyclical leaders at or near peak. No recession signal.",
    };
  }
  if (status === "warning") {
    return {
      label: "Warning — clock has started",
      blurb:
        "Cyclical leaders have started rolling over. Historically the 9-29 month recession clock starts in this zone, not immediately.",
    };
  }
  // signal
  if (confirmedRed) {
    return {
      label: "Recession Warning — 9-29mo lead",
      blurb:
        "Confirmed rollover in both leading sectors. Based on history, recession is likely within ~12 months — not necessarily now.",
    };
  }
  return {
    label: "Recession Warning (unconfirmed) — 9-29mo lead",
    blurb:
      "Index is in the red zone but the 2-consecutive-month confirmation on both leaders has not fired yet. Treat as a developing signal.",
  };
}

// ─── Public entrypoint ────────────────────────────────────────────────────────

export async function fetchRecessionPayload(): Promise<RecessionPayload> {
  logger.info("Fetching recession FRED series...");

  const seriesResults = await Promise.all(SECTORS.map((s) => tryFetchFred(s.series)));
  const [payemsRes, usrecRes] = await Promise.all([
    tryFetchFred(PAYEMS_SERIES),
    tryFetchFred(USREC_SERIES),
  ]);

  const resCons = seriesResults[0];
  const durGoods = seriesResults[1];

  // Build the historical CJI first — this is the source of truth for
  // "what month are we as of?" since each point is a date-aligned average.
  const cjiHistory = buildCjiHistory(resCons, durGoods);
  const nberRecessions = buildNberRecessions(usrecRes);
  const payemsYoY = buildPayemsYoY(payemsRes);

  // Headline CJI = last point of historical series. This guarantees the
  // headline and the right-most chart point always agree, and that the
  // 2 leader rows shown in the table are computed for the SAME calendar
  // month (the one used for the average). If either leader is missing,
  // cjiHistory will be empty and we degrade to "insufficient".
  let lastFredDate: number | null = null;
  let cji: number | null = null;
  let cjiZone: RecessionStatus = "insufficient"; // raw threshold zone — used by chart bands and the table
  let leaderAsOfRC: number | null = null;
  let leaderAsOfDG: number | null = null;
  if (cjiHistory.length > 0) {
    const last = cjiHistory[cjiHistory.length - 1];
    lastFredDate = last.time;
    cji = last.value;
    cjiZone = statusFromPctOffPeak(cji);
    leaderAsOfRC = indexByTime(resCons).get(last.time) ?? null;
    leaderAsOfDG = indexByTime(durGoods).get(last.time) ?? null;
  }

  // Compute sector rows: leaders use the date-aligned as-of index; the two
  // confirmation rows use their own latest observations.
  const sectors: SectorStats[] = SECTORS.map((meta, i) => {
    if (i === 0) return computeSector(meta, seriesResults[i], leaderAsOfRC);
    if (i === 1) return computeSector(meta, seriesResults[i], leaderAsOfDG);
    return computeSector(meta, seriesResults[i]);
  });

  const confirmedRed = cjiZone === "signal" && checkConfirmedRed(cjiHistory, resCons, durGoods);

  // Headline status RESPECTS the confirmation rule. If CJI is in the red zone
  // but the 2-consecutive-month rule has not fired, show as warning, not red.
  // This matches the spec: RED only when CJI <= -1.5% AND both leaders' 3M
  // annualized < 0 for 2+ consecutive months. The text label still uses the
  // raw zone so the user sees "Recession Warning (unconfirmed)" — the color
  // changes, but the wording remains explicit.
  const cjiStatus: RecessionStatus =
    cjiZone === "signal" && !confirmedRed ? "warning" : cjiZone;

  const { label, blurb } = makeLabel(cjiZone, confirmedRed);

  const notes: string[] = [];
  let partialData = false;
  for (const s of sectors) {
    if (s.current == null) {
      partialData = true;
      notes.push(`${s.label} (${s.series}) unavailable`);
    }
  }
  // Note any leader-lag scenario explicitly so the user understands why
  // a leader's "current" might be older than its raw last observation.
  if (resCons && durGoods && lastFredDate != null) {
    const rcLatest = resCons[resCons.length - 1].time;
    const dgLatest = durGoods[durGoods.length - 1].time;
    if (rcLatest !== lastFredDate || dgLatest !== lastFredDate) {
      partialData = true;
      const lagged: string[] = [];
      if (rcLatest > lastFredDate) lagged.push("Durable Goods");
      if (dgLatest > lastFredDate) lagged.push("Residential Construction");
      notes.push(
        `Leader release lag: showing CJI as of last shared month. Waiting on ${lagged.join(" & ")}.`
      );
    }
  }
  if (!payemsRes) {
    partialData = true;
    notes.push("Total Nonfarm (PAYEMS) context series unavailable");
  }
  if (!usrecRes) {
    notes.push("NBER recession history (USREC) unavailable — chart shading omitted");
  }

  return {
    cji,
    cjiStatus,
    cjiLabel: label,
    cjiBlurb: blurb,
    confirmedRed,
    sectors,
    cjiHistory,
    nberRecessions,
    payemsYoY,
    dataAsOf: lastFredDate,
    lastFredDate,
    partialData,
    notes,
    lastUpdated: Math.floor(Date.now() / 1000),
  };
}
