import { logger } from "./logger.js";

const FRED_BASE = "https://api.stlouisfed.org/fred/series/observations";
const FRED_KEY = process.env.FRED_API_KEY;

export interface MonthlyPoint {
  time: number; // unix seconds, first of month UTC
  value: number;
}

export type DominoState = "expanding" | "rolling_over" | "fallen";

export interface DominoStatus {
  id: "newSales" | "permits" | "underConstruction" | "employment" | "homePrices";
  label: string;
  series: string; // FRED id
  current: number | null;
  currentDate: number | null;
  peakValue: number | null;
  peakDate: number | null;
  pctOffPeak: number | null; // negative number e.g. -8.2 means 8.2% below peak
  monthsSincePeak: number | null;
  roc3m: number | null; // % change vs 3mo ago
  roc6m: number | null; // % change vs 6mo ago
  state: DominoState;
  fallen: boolean;
  data: MonthlyPoint[]; // last ~36 months for sparkline
}

export interface FedStatus {
  current: number | null;
  yearAgo: number | null;
  tightening: boolean; // current > yearAgo
  data: MonthlyPoint[]; // last 36 months
}

export interface HousingPayload {
  fed: FedStatus;
  dominoes: DominoStatus[]; // in canonical order
  stage: number; // 0..5
  stageLabel: string;
  expectedTimingMonths: [number, number] | null; // e.g. [12,24]
  expectedTimingNote: string | null;
  sequenceValid: boolean;
  sequenceNote: string;
  lastUpdated: number;
}

const SERIES: Array<{ id: DominoStatus["id"]; label: string; series: string }> = [
  { id: "newSales", label: "New Home Sales", series: "HSN1F" },
  { id: "permits", label: "Building Permits", series: "PERMIT" },
  { id: "underConstruction", label: "Under Construction", series: "UNDCONTSA" },
  { id: "employment", label: "Construction Employment", series: "CES2023600001" },
  { id: "homePrices", label: "Case-Shiller Home Prices", series: "CSUSHPINSA" },
];

async function fetchFredAll(series: string): Promise<MonthlyPoint[]> {
  if (!FRED_KEY) throw new Error("FRED_API_KEY not set");
  const url = `${FRED_BASE}?series_id=${series}&api_key=${FRED_KEY}&file_type=json&observation_start=1990-01-01`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`FRED error ${resp.status} for ${series}`);
  const json = (await resp.json()) as { observations: Array<{ date: string; value: string }> };
  const points: MonthlyPoint[] = [];
  for (const obs of json.observations) {
    const v = parseFloat(obs.value);
    if (isNaN(v)) continue;
    const ts = Math.floor(new Date(obs.date + "T00:00:00Z").getTime() / 1000);
    points.push({ time: ts, value: v });
  }
  points.sort((a, b) => a.time - b.time);
  return points;
}

function monthsBetween(laterTs: number, earlierTs: number): number {
  const a = new Date(laterTs * 1000);
  const b = new Date(earlierTs * 1000);
  return (
    (a.getUTCFullYear() - b.getUTCFullYear()) * 12 +
    (a.getUTCMonth() - b.getUTCMonth())
  );
}

function computeDomino(
  meta: { id: DominoStatus["id"]; label: string; series: string },
  points: MonthlyPoint[]
): DominoStatus {
  if (points.length === 0) {
    return {
      ...meta,
      current: null,
      currentDate: null,
      peakValue: null,
      peakDate: null,
      pctOffPeak: null,
      monthsSincePeak: null,
      roc3m: null,
      roc6m: null,
      state: "expanding",
      fallen: false,
      data: [],
    };
  }

  const last = points[points.length - 1];
  // Trailing 24-month peak (inclusive of current month)
  const window24 = points.slice(-24);
  let peak = window24[0];
  for (const p of window24) if (p.value > peak.value) peak = p;

  const pctOffPeak = peak.value > 0 ? ((last.value - peak.value) / peak.value) * 100 : 0;
  const monthsSincePeak = monthsBetween(last.time, peak.time);

  const idx = points.length - 1;
  const p3 = idx - 3 >= 0 ? points[idx - 3] : null;
  const p6 = idx - 6 >= 0 ? points[idx - 6] : null;
  const roc3m = p3 && p3.value > 0 ? ((last.value - p3.value) / p3.value) * 100 : null;
  const roc6m = p6 && p6.value > 0 ? ((last.value - p6.value) / p6.value) * 100 : null;

  // Fallen rule: peaked >= 3 months ago, current >= 5% below peak, 3mo ROC < 0
  const fallen =
    monthsSincePeak >= 3 && pctOffPeak <= -5 && roc3m != null && roc3m < 0;

  // Rolling-over: peaked >= 1 month ago and ROC negative (but not fully fallen)
  const rollingOver =
    !fallen && monthsSincePeak >= 1 && ((roc3m != null && roc3m < 0) || pctOffPeak < -1);

  const state: DominoState = fallen ? "fallen" : rollingOver ? "rolling_over" : "expanding";

  return {
    ...meta,
    current: last.value,
    currentDate: last.time,
    peakValue: peak.value,
    peakDate: peak.time,
    pctOffPeak,
    monthsSincePeak,
    roc3m,
    roc6m,
    state,
    fallen,
    data: points.slice(-36),
  };
}

function computeStage(dominoes: DominoStatus[]): { stage: number; stageLabel: string } {
  // Stage 1 = newSales fallen, Stage 2 = + permits, Stage 3 = + underConstruction,
  // Stage 4 = + employment, Stage 5 = + homePrices.
  // Sequential — stop counting at the first non-fallen domino.
  let stage = 0;
  for (const d of dominoes) {
    if (d.fallen) stage++;
    else break;
  }
  const labels = [
    "Stage 0 — Watching for the first domino",
    "Stage 1 — New home sales rolling over",
    "Stage 2 — Permits also falling (first major trigger)",
    "Stage 3 — Construction pipeline contracting",
    "Stage 4 — Construction layoffs underway (second major trigger)",
    "Stage 5 — Home prices declining (full sequence)",
  ];
  return { stage, stageLabel: labels[stage] };
}

function computeExpectedTiming(stage: number): {
  months: [number, number] | null;
  note: string | null;
} {
  if (stage >= 5) return { months: null, note: "Sequence complete — prices already weak" };
  if (stage >= 4) return { months: [12, 18], note: "Home price weakness typically 12–18 months out" };
  if (stage >= 2) return { months: [12, 24], note: "Home price decline typically 12–24 months out" };
  return { months: null, note: null };
}

function computeSequenceIntegrity(dominoes: DominoStatus[]): {
  valid: boolean;
  note: string;
} {
  const fallen = dominoes.filter((d) => d.fallen);
  if (fallen.length === 0) return { valid: true, note: "No dominoes fallen yet — nothing to evaluate" };

  // Rule 1: Fallen dominoes must form a contiguous prefix starting at index 0.
  // If any earlier domino in the canonical order is NOT fallen while a later
  // one IS, the chain skipped a step — that's a false start per the guide.
  const lastFallenIdx = (() => {
    for (let i = dominoes.length - 1; i >= 0; i--) if (dominoes[i].fallen) return i;
    return -1;
  })();
  for (let i = 0; i <= lastFallenIdx; i++) {
    if (!dominoes[i].fallen) {
      return {
        valid: false,
        note: `False start — ${dominoes[lastFallenIdx].label} fell before ${dominoes[i].label}`,
      };
    }
  }

  // Rule 2: Among fallen dominoes, peak dates must be in canonical (non-decreasing) order.
  for (let i = 1; i < fallen.length; i++) {
    const prev = fallen[i - 1].peakDate;
    const cur = fallen[i].peakDate;
    if (prev == null || cur == null) continue;
    if (cur < prev) {
      return {
        valid: false,
        note: `Out of order — ${fallen[i].label} peaked before ${fallen[i - 1].label}`,
      };
    }
  }

  return { valid: true, note: "Peaks occurred in the canonical order" };
}

export async function fetchHousingPayload(): Promise<HousingPayload> {
  logger.info("Fetching housing FRED series...");

  const [fedfundsAll, ...seriesData] = await Promise.all([
    fetchFredAll("FEDFUNDS"),
    ...SERIES.map((s) => fetchFredAll(s.series)),
  ]);

  const dominoes: DominoStatus[] = SERIES.map((meta, i) => computeDomino(meta, seriesData[i]));

  // Fed tightening status
  const fedLast = fedfundsAll[fedfundsAll.length - 1] ?? null;
  const fed12 =
    fedfundsAll.length >= 13 ? fedfundsAll[fedfundsAll.length - 13] : null;
  const fed: FedStatus = {
    current: fedLast?.value ?? null,
    yearAgo: fed12?.value ?? null,
    tightening: !!(fedLast && fed12 && fedLast.value > fed12.value),
    data: fedfundsAll.slice(-36),
  };

  const { stage, stageLabel } = computeStage(dominoes);
  const { months: expectedTimingMonths, note: expectedTimingNote } = computeExpectedTiming(stage);
  const { valid: sequenceValid, note: sequenceNote } = computeSequenceIntegrity(dominoes);

  return {
    fed,
    dominoes,
    stage,
    stageLabel,
    expectedTimingMonths,
    expectedTimingNote,
    sequenceValid,
    sequenceNote,
    lastUpdated: Math.floor(Date.now() / 1000),
  };
}
