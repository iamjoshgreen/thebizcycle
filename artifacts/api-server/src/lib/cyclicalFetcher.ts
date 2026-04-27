import { logger } from "./logger.js";

const FRED_BASE = "https://api.stlouisfed.org/fred/series/observations";
const FRED_KEY = process.env.FRED_API_KEY;

// ─── Types (mirror the OpenAPI schema) ────────────────────────────────────────

export type CyclicalComponentId =
  | "durableGoods"
  | "residentialInvestment"
  | "businessEquipment";

export type CyclicalStatus =
  | "strong"
  | "expansion"
  | "decelerating"
  | "contraction"
  | "insufficient";

export interface CyclicalComponent {
  id: CyclicalComponentId;
  label: string;
  series: string;
  latestLevel: number | null;
  qoqAnnPct: number | null;
  yoyPct: number | null;
  shareOfGdpPct: number | null;
  contractionPctSince1956: number | null;
}

export interface CyclicalGrowthPoint {
  time: number;
  value: number;
}

export interface NberRecessionInterval {
  start: number;
  end: number;
}

export interface CyclicalContractionStats {
  cyclicalPct: number | null;
  totalGdpPct: number | null;
  nonCyclicalPct: number | null;
  sinceYear: number;
  quartersCounted: number;
}

export interface CyclicalQuarterEntry {
  time: number;
  quarterLabel: string;
  value: number | null;
}

export interface CyclicalPayload {
  latestQuarter: number | null;
  latestQuarterLabel: string;
  latestQoqAnnPct: number | null;
  latestYoyPct: number | null;
  status: CyclicalStatus;
  statusLabel: string;
  statusBlurb: string;
  recentSequence: CyclicalQuarterEntry[];
  components: CyclicalComponent[];
  cyclicalSharePct: number | null;
  cyclicalGrowthHistory: CyclicalGrowthPoint[];
  totalGdpGrowthHistory: CyclicalGrowthPoint[];
  nonCyclicalGrowthHistory: CyclicalGrowthPoint[];
  cyclicalMa4History: CyclicalGrowthPoint[];
  nberRecessions: NberRecessionInterval[];
  contractionStats: CyclicalContractionStats;
  partialData: boolean;
  notes: string[];
  lastUpdated: number;
}

// ─── Series catalog ───────────────────────────────────────────────────────────
//
// Two flavours of series for each cyclical component:
//
//  • "growth" series — BEA percent-change-at-annual-rate. These go back to
//    1947Q2 and give us the long-history chart and contraction-frequency stats.
//
//  • "level" series — real chained-2017-dollar level (SAAR). FRED's level
//    series for durables and residential only start in 2007, but we only
//    need a level to (a) show the latest dollar value in the per-component
//    table and (b) compute the latest dollar shares used as fixed weights
//    when aggregating long-history growth rates.

interface ComponentMeta {
  id: CyclicalComponentId;
  label: string;
  growthSeries: string;
  levelSeries: string;
}

const COMPONENTS: ComponentMeta[] = [
  {
    id: "durableGoods",
    label: "Durable Goods Consumption",
    growthSeries: "DDURRL1Q225SBEA",
    levelSeries: "PCDGCC96",
  },
  {
    id: "residentialInvestment",
    label: "Residential Investment",
    growthSeries: "A011RL1Q225SBEA",
    levelSeries: "PRFIC1",
  },
  {
    id: "businessEquipment",
    label: "Business Equipment Investment",
    growthSeries: "Y033RL1Q225SBEA",
    levelSeries: "Y033RX1Q020SBEA",
  },
];

const GDP_GROWTH_SERIES = "A191RL1Q225SBEA"; // Real GDP, % change at annual rate (1947+)
const GDP_LEVEL_SERIES = "GDPC1"; // Real GDP, chained 2017$ (1947+)
const USREC_SERIES = "USREC"; // NBER recession indicator (monthly)

const HISTORY_OBS_START = "1947-01-01";
const STATS_SINCE_YEAR = 1956;

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface FredPoint {
  time: number; // unix seconds, first day of quarter UTC
  value: number;
}

async function fetchFred(
  series: string,
  observationStart = HISTORY_OBS_START
): Promise<FredPoint[]> {
  if (!FRED_KEY) throw new Error("FRED_API_KEY not set");
  const url = `${FRED_BASE}?series_id=${series}&api_key=${FRED_KEY}&file_type=json&observation_start=${observationStart}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`FRED error ${resp.status} for ${series}`);
  const json = (await resp.json()) as {
    observations: Array<{ date: string; value: string }>;
  };
  const out: FredPoint[] = [];
  for (const obs of json.observations) {
    const v = parseFloat(obs.value);
    if (!isFinite(v)) continue;
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
    logger.warn({ err, series }, "FRED fetch failed (cyclical)");
    return null;
  }
}

function quarterLabel(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  const m = d.getUTCMonth(); // 0=Jan
  const q = Math.floor(m / 3) + 1;
  return `${d.getUTCFullYear()} Q${q}`;
}

function yoyFromGrowthSeries(
  growth: FredPoint[],
  endIdx: number
): number | null {
  // Compose 4 consecutive QoQ-annualized growth rates into a year-over-year %.
  // growth values are annualized, so single-quarter level ratio = (1+g)^(1/4).
  if (endIdx < 3) return null;
  let prod = 1;
  for (let k = 0; k < 4; k++) {
    const g = growth[endIdx - k].value / 100;
    prod *= Math.pow(1 + g, 1 / 4);
  }
  return (prod - 1) * 100;
}

function asMap(points: FredPoint[] | null): Map<number, number> {
  const m = new Map<number, number>();
  if (!points) return m;
  for (const p of points) m.set(p.time, p.value);
  return m;
}

// ─── Cyclical growth aggregation (weighted average of component growth) ──────
//
// For each quarter where ALL three component growth-rate series are present,
// compute a weighted average using FIXED weights derived from the latest
// dollar shares within the cyclical bucket. Weights drift slowly over decades
// (durables shrink, equipment grows), so a fixed weight gives the right
// shape on history and matches the recent dollar-sum exactly.

interface Weights {
  durables: number;
  residential: number;
  equipment: number;
}

function deriveCyclicalWeights(
  durLevels: FredPoint[] | null,
  resLevels: FredPoint[] | null,
  eqLevels: FredPoint[] | null
): Weights | null {
  if (
    !durLevels ||
    !resLevels ||
    !eqLevels ||
    durLevels.length === 0 ||
    resLevels.length === 0 ||
    eqLevels.length === 0
  ) {
    return null;
  }
  const dMap = asMap(durLevels);
  const rMap = asMap(resLevels);
  const eMap = asMap(eqLevels);

  // Find the most recent quarter where all three levels exist.
  const candidates = [...durLevels].reverse();
  for (const p of candidates) {
    const r = rMap.get(p.time);
    const e = eMap.get(p.time);
    if (r != null && e != null && p.value > 0 && r > 0 && e > 0) {
      const total = p.value + r + e;
      void dMap; // avoid unused-var lint (kept for readability)
      return {
        durables: p.value / total,
        residential: r / total,
        equipment: e / total,
      };
    }
  }
  return null;
}

// Two paths produce the cyclical bucket's QoQ-annualized growth:
//
//  • PREFERRED (recent, matches EPB Research exactly): sum the chained-dollar
//    levels across the three components and compute QoQ ann growth from the
//    summed level. This is what EPB does. Only available since the level
//    series exist (durables/residential start 2007, equipment 1999).
//
//  • FALLBACK (pre-2007 history): weighted average of the three component
//    growth-rate series, using fixed weights derived from the latest dollar
//    shares within the cyclical bucket. Slow weight drift makes this a
//    close approximation for the long-run shape on the chart.
function buildCyclicalGrowth(
  durGrowth: FredPoint[] | null,
  resGrowth: FredPoint[] | null,
  eqGrowth: FredPoint[] | null,
  weights: Weights | null,
  durLevel: FredPoint[] | null,
  resLevel: FredPoint[] | null,
  eqLevel: FredPoint[] | null
): CyclicalGrowthPoint[] {
  if (!durGrowth || !resGrowth || !eqGrowth || !weights) return [];

  // Build a level-sum series first (only quarters where all 3 levels exist).
  const levelSum: FredPoint[] = [];
  if (durLevel && resLevel && eqLevel) {
    const rMap = asMap(resLevel);
    const eMap = asMap(eqLevel);
    for (const p of durLevel) {
      const r = rMap.get(p.time);
      const e = eMap.get(p.time);
      if (r == null || e == null) continue;
      levelSum.push({ time: p.time, value: p.value + r + e });
    }
    levelSum.sort((a, b) => a.time - b.time);
  }
  // Map: quarter time -> level-sum value, for quick "is this quarter covered?" checks.
  const levelMap = asMap(levelSum.length > 0 ? levelSum : null);

  // Walk the durables-growth timeline. For each quarter where the level-sum
  // method is available (current AND prior quarter both have a level value),
  // use it. Otherwise fall back to the weighted-growth approximation.
  const dgMap = asMap(durGrowth);
  const rgMap = asMap(resGrowth);
  const egMap = asMap(eqGrowth);
  void dgMap;

  const out: CyclicalGrowthPoint[] = [];
  for (let i = 0; i < durGrowth.length; i++) {
    const p = durGrowth[i];
    const r = rgMap.get(p.time);
    const e = egMap.get(p.time);
    if (r == null || e == null) continue;

    // Try the level-sum path first.
    let usedLevels = false;
    if (i > 0) {
      const prevTime = durGrowth[i - 1].time;
      const cur = levelMap.get(p.time);
      const prev = levelMap.get(prevTime);
      if (cur != null && prev != null && prev > 0) {
        const g = (Math.pow(cur / prev, 4) - 1) * 100;
        out.push({ time: p.time, value: g });
        usedLevels = true;
      }
    }
    if (usedLevels) continue;

    // Fall back to weighted growth-rate average.
    const v =
      weights.durables * p.value +
      weights.residential * r +
      weights.equipment * e;
    out.push({ time: p.time, value: v });
  }
  return out;
}

// Non-cyclical growth: implied growth of the rest of GDP, given total GDP
// growth and our weighted cyclical estimate. We approximate the cyclical
// share-of-GDP with the latest joined-quarter share (drift is slow).
function buildNonCyclicalGrowth(
  cyclical: CyclicalGrowthPoint[],
  gdpGrowth: FredPoint[] | null,
  cyclicalShare: number | null
): CyclicalGrowthPoint[] {
  if (!gdpGrowth || cyclicalShare == null || cyclicalShare <= 0 || cyclicalShare >= 1) {
    return [];
  }
  const gMap = asMap(gdpGrowth);
  const out: CyclicalGrowthPoint[] = [];
  for (const c of cyclical) {
    const g = gMap.get(c.time);
    if (g == null) continue;
    const nc = (g - cyclicalShare * c.value) / (1 - cyclicalShare);
    out.push({ time: c.time, value: nc });
  }
  return out;
}

// Convert a QoQ-annualized growth history to a year-over-year history by
// compounding 4 consecutive quarters: (Π (1+g_i/100)^(1/4)) - 1
function toYoyHistory(history: CyclicalGrowthPoint[]): CyclicalGrowthPoint[] {
  const out: CyclicalGrowthPoint[] = [];
  for (let i = 3; i < history.length; i++) {
    let prod = 1;
    for (let k = 0; k < 4; k++) {
      prod *= Math.pow(1 + history[i - k].value / 100, 1 / 4);
    }
    out.push({ time: history[i].time, value: (prod - 1) * 100 });
  }
  return out;
}

function buildMa4(history: CyclicalGrowthPoint[]): CyclicalGrowthPoint[] {
  const out: CyclicalGrowthPoint[] = [];
  for (let i = 3; i < history.length; i++) {
    const avg =
      (history[i].value +
        history[i - 1].value +
        history[i - 2].value +
        history[i - 3].value) /
      4;
    out.push({ time: history[i].time, value: avg });
  }
  return out;
}

// ─── NBER recession intervals from monthly USREC ──────────────────────────────

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

// ─── Status & plain-English templates ─────────────────────────────────────────

function classify(latest: number | null, ma4: number | null): CyclicalStatus {
  if (latest == null) return "insufficient";
  if (latest < 0) return "contraction";
  if (latest >= 4 && (ma4 == null || ma4 >= 3)) return "strong";
  if (latest >= 2) return "expansion";
  return "decelerating";
}

function statusCopy(
  status: CyclicalStatus,
  recent: CyclicalQuarterEntry[]
): { label: string; blurb: string } {
  if (status === "insufficient") {
    return {
      label: "Insufficient data",
      blurb: "One or more underlying series are unavailable right now.",
    };
  }
  // Detect a clear monotone deceleration across the last 4 quarters.
  const vals = recent.map((r) => r.value).filter((v): v is number => v != null);
  const decelerating =
    vals.length >= 3 &&
    vals.every((v, i, a) => i === 0 || v <= a[i - 1] + 0.01) &&
    vals[0] - vals[vals.length - 1] >= 1;

  if (status === "contraction") {
    return {
      label: "Contraction",
      blurb:
        "Cyclical GDP is shrinking. Historically this is the part of the economy that contracts well before headline GDP turns negative.",
    };
  }
  if (status === "strong") {
    return {
      label: "Strong expansion",
      blurb:
        "The cyclical engine — durables, housing, business equipment — is firing. Cycle risk is low while growth holds above ~3%.",
    };
  }
  if (status === "expansion") {
    return {
      label: decelerating ? "Expansion — losing momentum" : "Expansion",
      blurb: decelerating
        ? "Still growing, but momentum has compressed. This is the kind of deceleration that historically precedes a downturn if it continues."
        : "Cyclical GDP is growing at a healthy pace. No recession signal from this bucket.",
    };
  }
  // decelerating
  return {
    label: "Decelerating",
    blurb:
      "Growth is positive but compressed. Watch the next print — the signal often shows up here before total GDP rolls over.",
  };
}

// ─── Contraction-frequency stats ──────────────────────────────────────────────

function pctNegativeSince(
  history: CyclicalGrowthPoint[] | { time: number; value: number }[],
  sinceYear: number
): { pct: number | null; counted: number } {
  let neg = 0;
  let counted = 0;
  for (const p of history) {
    const yr = new Date(p.time * 1000).getUTCFullYear();
    if (yr < sinceYear) continue;
    counted++;
    if (p.value < 0) neg++;
  }
  if (counted === 0) return { pct: null, counted: 0 };
  return { pct: (neg / counted) * 100, counted };
}

// ─── Per-component summary stats ──────────────────────────────────────────────

function summarizeComponent(
  meta: ComponentMeta,
  growth: FredPoint[] | null,
  level: FredPoint[] | null,
  totalGdpLevel: FredPoint[] | null,
  asOfTime: number | null
): CyclicalComponent {
  // Latest growth-rate (QoQ ann)
  let qoqAnnPct: number | null = null;
  let yoyPct: number | null = null;
  let contractionPct: number | null = null;

  if (growth && growth.length > 0) {
    // Use the same as-of timestamp as the headline (the last quarter where
    // all three growth series exist). If unavailable, fall back to the last
    // observation of this series.
    const idx =
      asOfTime != null
        ? growth.findIndex((p) => p.time === asOfTime)
        : growth.length - 1;
    const useIdx = idx >= 0 ? idx : growth.length - 1;
    qoqAnnPct = growth[useIdx].value;
    yoyPct = yoyFromGrowthSeries(growth, useIdx);
    contractionPct = pctNegativeSince(growth, STATS_SINCE_YEAR).pct;
  }

  // Latest level + share of GDP
  let latestLevel: number | null = null;
  let shareOfGdpPct: number | null = null;
  if (level && level.length > 0) {
    const last = level[level.length - 1];
    latestLevel = last.value;
    if (totalGdpLevel) {
      const gMap = asMap(totalGdpLevel);
      const g = gMap.get(last.time);
      if (g != null && g > 0) shareOfGdpPct = (last.value / g) * 100;
    }
  }

  return {
    id: meta.id,
    label: meta.label,
    series: meta.growthSeries,
    latestLevel,
    qoqAnnPct,
    yoyPct,
    shareOfGdpPct,
    contractionPctSince1956: contractionPct,
  };
}

// ─── Main entry ───────────────────────────────────────────────────────────────

export async function fetchCyclicalPayload(): Promise<CyclicalPayload> {
  const notes: string[] = [];

  const [
    durGrowth,
    resGrowth,
    eqGrowth,
    gdpGrowth,
    durLevel,
    resLevel,
    eqLevel,
    gdpLevel,
    usrec,
  ] = await Promise.all([
    tryFetchFred(COMPONENTS[0].growthSeries),
    tryFetchFred(COMPONENTS[1].growthSeries),
    tryFetchFred(COMPONENTS[2].growthSeries),
    tryFetchFred(GDP_GROWTH_SERIES),
    tryFetchFred(COMPONENTS[0].levelSeries),
    tryFetchFred(COMPONENTS[1].levelSeries),
    tryFetchFred(COMPONENTS[2].levelSeries),
    tryFetchFred(GDP_LEVEL_SERIES),
    tryFetchFred(USREC_SERIES),
  ]);

  if (!durGrowth) notes.push(`Missing growth series ${COMPONENTS[0].growthSeries}`);
  if (!resGrowth) notes.push(`Missing growth series ${COMPONENTS[1].growthSeries}`);
  if (!eqGrowth) notes.push(`Missing growth series ${COMPONENTS[2].growthSeries}`);
  if (!gdpGrowth) notes.push(`Missing growth series ${GDP_GROWTH_SERIES}`);

  // Weights from latest joined quarter of LEVELS
  const weights = deriveCyclicalWeights(durLevel, resLevel, eqLevel);
  if (!weights) notes.push("Could not derive component weights from level series");

  // Cyclical growth history (all quarters where the 3 growth series intersect)
  const cyclicalGrowth = buildCyclicalGrowth(
    durGrowth,
    resGrowth,
    eqGrowth,
    weights,
    durLevel,
    resLevel,
    eqLevel
  );
  const cyclicalMa4 = buildMa4(cyclicalGrowth);

  // Total GDP growth, restricted to the same quarters as cyclical (so x-axes line up)
  const cyclicalTimes = new Set(cyclicalGrowth.map((p) => p.time));
  const totalGdpGrowth = (gdpGrowth ?? [])
    .filter((p) => cyclicalTimes.has(p.time))
    .map((p) => ({ time: p.time, value: p.value }));

  // Cyclical share of GDP (latest joined quarter where all 3 levels + GDPC1 exist)
  let cyclicalSharePct: number | null = null;
  if (durLevel && resLevel && eqLevel && gdpLevel) {
    const dMap = asMap(durLevel);
    const rMap = asMap(resLevel);
    const eMap = asMap(eqLevel);
    const gMap = asMap(gdpLevel);
    const candidates = [...durLevel].reverse();
    for (const p of candidates) {
      const r = rMap.get(p.time);
      const e = eMap.get(p.time);
      const g = gMap.get(p.time);
      void dMap;
      if (r != null && e != null && g != null && g > 0) {
        cyclicalSharePct = ((p.value + r + e) / g) * 100;
        break;
      }
    }
  }

  const cyclicalShareFraction =
    cyclicalSharePct != null ? cyclicalSharePct / 100 : null;

  // Non-cyclical growth (implied)
  const nonCyclicalGrowth = buildNonCyclicalGrowth(
    cyclicalGrowth,
    gdpGrowth,
    cyclicalShareFraction
  );

  // Headline numbers
  const latest =
    cyclicalGrowth.length > 0 ? cyclicalGrowth[cyclicalGrowth.length - 1] : null;
  const latestQuarter = latest?.time ?? null;
  const latestQoqAnnPct = latest?.value ?? null;

  const latestYoyPct =
    cyclicalGrowth.length >= 4
      ? yoyFromGrowthSeries(cyclicalGrowth, cyclicalGrowth.length - 1)
      : null;

  const latestMa4 =
    cyclicalMa4.length > 0 ? cyclicalMa4[cyclicalMa4.length - 1].value : null;
  const status = classify(latestQoqAnnPct, latestMa4);

  // Recent sequence: last 4 cyclical growth points
  const recent: CyclicalQuarterEntry[] = cyclicalGrowth.slice(-4).map((p) => ({
    time: p.time,
    quarterLabel: quarterLabel(p.time),
    value: p.value,
  }));

  const { label: statusLabel, blurb: statusBlurb } = statusCopy(status, recent);

  // Per-component summaries
  const components: CyclicalComponent[] = [
    summarizeComponent(COMPONENTS[0], durGrowth, durLevel, gdpLevel, latestQuarter),
    summarizeComponent(COMPONENTS[1], resGrowth, resLevel, gdpLevel, latestQuarter),
    summarizeComponent(COMPONENTS[2], eqGrowth, eqLevel, gdpLevel, latestQuarter),
  ];

  // Contraction-frequency stats since 1956 — YoY based (matches EPB framing).
  // For each quarter we compose 4 consecutive QoQ-annualized growth rates
  // into a YoY %, then count quarters where YoY < 0.
  const cyclicalYoy = toYoyHistory(cyclicalGrowth);
  const totalGdpYoy = toYoyHistory(totalGdpGrowth);
  const nonCyclicalYoy = toYoyHistory(nonCyclicalGrowth);

  const cycPct = pctNegativeSince(cyclicalYoy, STATS_SINCE_YEAR);
  const totPct = pctNegativeSince(totalGdpYoy, STATS_SINCE_YEAR);
  const ncPct = pctNegativeSince(nonCyclicalYoy, STATS_SINCE_YEAR);

  const contractionStats: CyclicalContractionStats = {
    cyclicalPct: cycPct.pct,
    totalGdpPct: totPct.pct,
    nonCyclicalPct: ncPct.pct,
    sinceYear: STATS_SINCE_YEAR,
    quartersCounted: cycPct.counted,
  };

  const nberRecessions = buildNberRecessions(usrec);
  const partialData =
    !durGrowth ||
    !resGrowth ||
    !eqGrowth ||
    !gdpGrowth ||
    !weights ||
    cyclicalGrowth.length === 0;

  return {
    latestQuarter,
    latestQuarterLabel: latestQuarter != null ? quarterLabel(latestQuarter) : "—",
    latestQoqAnnPct,
    latestYoyPct,
    status,
    statusLabel,
    statusBlurb,
    recentSequence: recent,
    components,
    cyclicalSharePct,
    cyclicalGrowthHistory: cyclicalGrowth,
    totalGdpGrowthHistory: totalGdpGrowth,
    nonCyclicalGrowthHistory: nonCyclicalGrowth,
    cyclicalMa4History: cyclicalMa4,
    nberRecessions,
    contractionStats,
    partialData,
    notes,
    lastUpdated: Math.floor(Date.now() / 1000),
  };
}
