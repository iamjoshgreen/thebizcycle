import { logger } from "./logger.js";

const FRED_BASE = "https://api.stlouisfed.org/fred/series/observations";
const FRED_KEY = process.env.FRED_API_KEY;

export interface MonthlyPoint {
  time: number; // unix seconds, first of month UTC
  value: number;
}

export type DominoState = "expanding" | "rolling_over" | "fallen";

// Per-domino sequence-position flag. Sequence is causal: each domino is supposed
// to fall *because* the previous one fell, so "out of order" means this domino
// started declining before one of its predecessors did.
//
// - "healthy"      — still expanding (hasn't peaked / hasn't started declining).
//                    Not evaluated for order; it has nothing to violate yet.
// - "in_order"     — has started declining (rolling_over or fallen) AND every
//                    earlier domino started declining at least as long ago.
// - "out_of_order" — has started declining BUT some earlier domino is still
//                    healthy, OR some earlier domino started declining MORE
//                    RECENTLY than this one (i.e. this one fell first).
// - "pending"      — kept for backward compatibility with the generated client;
//                    no longer emitted by the new logic.
export type OrderStatus = "in_order" | "out_of_order" | "healthy" | "pending";

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
  orderStatus: OrderStatus; // is this domino in its expected sequence position?
  data: MonthlyPoint[]; // last ~36 months for sparkline
}

export interface FedStatus {
  current: number | null;
  yearAgo: number | null;
  tightening: boolean; // current > yearAgo
  data: MonthlyPoint[]; // last 36 months
}

export type CmsSignal = "tight" | "normal" | "elevated" | "recessionary" | "insufficient";

// "Completed Months Supply" — the EPB Research refinement of months supply
// that filters for inventory actually marked as "completed". Raw months supply
// gave a false recession signal in 2022 because <10% of inventory was finished
// (vs. 20-30% historically), so a high MSACSR didn't mean homes were piling up
// on the market — they were piling up under construction.
export interface CompletedMonthsSupply {
  currentMonthsSupply: number | null;
  currentCompletedMonthsSupply: number | null;
  currentPctCompleted: number | null; // 0..100
  gap: number | null; // raw - completed
  asOf: number | null; // unix seconds
  signal: CmsSignal;
  headline: string;
  explainer: string;
  monthsSupplyHistory: MonthlyPoint[]; // last ~10 years
  completedMonthsSupplyHistory: MonthlyPoint[]; // aligned, last ~10 years
  pctCompletedHistory: MonthlyPoint[]; // % completed, last ~10 years
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
  // Plain-English fields (deterministic templates) — backend is single source of truth.
  headlineLabel: string; // "FALSE START" | "LATE STAGE" | "ARMED" | "WATCHING" | "DORMANT" | "EXPANSION"
  headlineSubtitle: string; // one-line explainer under the label
  summary: string; // sentence replacing "X fallen · Y rolling · Z steady"
  fedContext: string; // "Fed Funds 3.64% — down from 5.33% peak…"
  completedMonthsSupply: CompletedMonthsSupply;
  lastUpdated: number;
}

const SERIES: Array<{ id: DominoStatus["id"]; label: string; series: string }> = [
  { id: "newSales", label: "New Home Sales", series: "HSN1F" },
  { id: "permits", label: "Building Permits", series: "PERMIT" },
  { id: "underConstruction", label: "Under Construction", series: "UNDCONTSA" },
  { id: "employment", label: "Construction Employment", series: "CES2023600001" },
  { id: "homePrices", label: "Case-Shiller Home Prices", series: "CSUSHPINSA" },
];

async function fetchFredAll(series: string, observationStart = "1990-01-01"): Promise<MonthlyPoint[]> {
  if (!FRED_KEY) throw new Error("FRED_API_KEY not set");
  const url = `${FRED_BASE}?series_id=${series}&api_key=${FRED_KEY}&file_type=json&observation_start=${observationStart}`;
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
      orderStatus: "pending",
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
    orderStatus: "pending", // overwritten in computeOrderStatuses() once we know the whole array
    data: points.slice(-36),
  };
}

// Per-domino sequence-position flag. The sequence is causal: each domino is
// supposed to fall because the previous one fell, so a domino is "out of order"
// if it started declining before one of its predecessors did.
//
// "Started declining" = state is rolling_over OR fallen (anything past peak).
// "Healthy" = state is expanding (still at or near a fresh high).
//
// Rules, applied per-domino:
//   1. If this domino is still healthy → "healthy" (no order judgement yet).
//   2. If this is the first domino → "in_order" (no predecessor to violate).
//   3. Otherwise, scan every earlier domino:
//        - if any earlier domino is still healthy → this fell first → "out_of_order"
//        - if any earlier domino has a SMALLER monthsSincePeak than this one,
//          that means the earlier domino started declining MORE RECENTLY (i.e.
//          this one fell before it) → "out_of_order"
//   4. Otherwise → "in_order".
function computeOrderStatuses(dominoes: DominoStatus[]): OrderStatus[] {
  return dominoes.map((d, i) => {
    // 1. Still healthy — nothing to evaluate.
    if (d.state === "expanding") return "healthy";

    // 2. First domino can't be out of order — no predecessor exists.
    if (i === 0) return "in_order";

    // 3. Compare against every earlier domino.
    const myMonths = d.monthsSincePeak;
    for (let j = 0; j < i; j++) {
      const earlier = dominoes[j];
      // 3a. Earlier domino is still healthy → this one moved first → out of order.
      if (earlier.state === "expanding") return "out_of_order";
      // 3b. Earlier domino started declining MORE RECENTLY than this one.
      //     Smaller monthsSincePeak = peaked later = started falling later.
      //     If we don't know either side's monthsSincePeak, skip the check.
      if (
        earlier.monthsSincePeak != null &&
        myMonths != null &&
        earlier.monthsSincePeak < myMonths
      ) {
        return "out_of_order";
      }
    }

    // 4. Every earlier domino started declining at least as long ago — sequence intact.
    return "in_order";
  });
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

// ─── Plain-English templates (deterministic — same inputs → same string) ─────

const SHORT_LABELS: Record<DominoStatus["id"], string> = {
  newSales: "New Home Sales",
  permits: "Building Permits",
  underConstruction: "Building Activity",
  employment: "Construction Jobs",
  homePrices: "Home Prices",
};

interface HeadlineCopy {
  label: string;
  subtitle: string;
}

function makeHeadline(
  dominoes: DominoStatus[],
  fed: FedStatus,
  stage: number,
  sequenceValid: boolean
): HeadlineCopy {
  const fallenCount = dominoes.filter((d) => d.fallen).length;
  if (fallenCount === 0) {
    return fed.tightening
      ? {
          label: "WATCHING",
          subtitle:
            "Fed is tightening — the trigger that usually starts the housing chain — but no domino has fallen yet.",
        }
      : {
          label: "DORMANT",
          subtitle:
            "Fed isn't tightening and no housing dominoes have fallen. No housing-led signal.",
        };
  }
  if (!sequenceValid) {
    return {
      label: "FALSE START",
      subtitle:
        "Housing is weakening, but in the wrong order for a real recession signal.",
    };
  }
  if (stage >= 4) {
    return {
      label: "LATE STAGE",
      subtitle:
        "Dominoes are falling in the correct order and the chain is deep — this is the pattern that precedes recessions.",
    };
  }
  return {
    label: "ARMED",
    subtitle:
      "Dominoes are starting to fall in the correct order. When the chain runs in this sequence, it tends to keep going.",
  };
}

function makeSummary(dominoes: DominoStatus[], sequenceValid: boolean): string {
  const fallenCount = dominoes.filter((d) => d.fallen).length;
  const rollingCount = dominoes.filter((d) => d.state === "rolling_over").length;
  const standingCount = dominoes.length - fallenCount - rollingCount;
  const fallWord = fallenCount === 1 ? "domino" : "dominoes";

  if (fallenCount === 0 && rollingCount === 0) {
    return "All 5 dominoes still standing — nothing rolling over yet.";
  }
  if (fallenCount === 0) {
    return `${rollingCount} wobbling, ${standingCount} still standing. No domino has fully fallen.`;
  }

  // Tail clause depends on whether the first domino (newSales) led the way.
  const firstFallen = dominoes[0].fallen;
  const tail = sequenceValid
    ? firstFallen
      ? "and they fell in the correct order."
      : "but the lead-off domino held."
    : "but the wrong ones fell first.";

  return `${fallenCount} ${fallWord} down, ${rollingCount} wobbling, ${standingCount} still standing — ${tail}`;
}

function makeFedContext(fed: FedStatus, fedAll: MonthlyPoint[]): string {
  if (fed.current == null) {
    return "Fed funds data unavailable.";
  }
  // 5-year rolling peak for "down from X% peak" context.
  const window = fedAll.slice(-60);
  let peak = window[0];
  for (const p of window) if (p.value > peak.value) peak = p;

  const cur = fed.current.toFixed(2);
  if (peak.value > fed.current + 0.25) {
    return `Fed Funds ${cur}% — down from ${peak.value.toFixed(2)}% peak, easing pressure on housing.`;
  }
  if (fed.tightening && fed.yearAgo != null) {
    return `Fed Funds ${cur}% — up from ${fed.yearAgo.toFixed(2)}% a year ago, tightening pressure on housing.`;
  }
  return `Fed Funds ${cur}% — roughly flat, neutral pressure on housing.`;
}

// ─── Completed Months Supply (EPB Research refinement) ──────────────────────
//
// Raw months supply (MSACSR) was a reliable recession lead until 2022, when it
// hit ~10.6 (recession territory) but no recession came — because <10% of new
// home inventory was actually completed. Builders were sitting on a backlog of
// homes still under construction, not finished homes piling up on lots. Once
// you weight by % completed, the false signal disappears and the metric still
// works.
//
// Completed Months Supply = MSACSR * (NHFSEPCS / NHFSEPTS)
//   MSACSR   — Monthly Supply of New Houses (months)
//   NHFSEPCS — New Houses for Sale, Completed
//   NHFSEPTS — New Houses for Sale, Total
//
// We tolerate any of these series being unavailable and degrade gracefully.

async function fetchFredSafe(
  series: string,
  observationStart = "1990-01-01"
): Promise<MonthlyPoint[]> {
  try {
    return await fetchFredAll(series, observationStart);
  } catch (err) {
    logger.warn({ err, series }, "Failed to fetch FRED series; continuing without it");
    return [];
  }
}

function computeCompletedMonthsSupply(
  msacsr: MonthlyPoint[],
  completed: MonthlyPoint[],
  total: MonthlyPoint[]
): CompletedMonthsSupply {
  // Index inventory series by timestamp for alignment with MSACSR.
  const completedByTs = new Map(completed.map((p) => [p.time, p.value]));
  const totalByTs = new Map(total.map((p) => [p.time, p.value]));

  const msHistory: MonthlyPoint[] = [];
  const cmsHistory: MonthlyPoint[] = [];
  const pctHistory: MonthlyPoint[] = [];
  for (const ms of msacsr) {
    const c = completedByTs.get(ms.time);
    const t = totalByTs.get(ms.time);
    msHistory.push(ms);
    if (c != null && t != null && t > 0) {
      const pct = c / t;
      cmsHistory.push({ time: ms.time, value: ms.value * pct });
      pctHistory.push({ time: ms.time, value: pct * 100 });
    }
  }

  // Return the full available FRED history. MSACSR starts in 1963 and the
  // inventory composition series start in 1973, so this gives the chart
  // multiple recessions to anchor against (1973-75, 1980, 1981-82, 1990-91,
  // 2001, 2008, 2020) — necessary for the metric to show its track record.
  const msHist10y = msHistory;
  const cmsHist10y = cmsHistory;
  const pctHist10y = pctHistory;

  if (msHistory.length === 0 || cmsHistory.length === 0) {
    return {
      currentMonthsSupply: null,
      currentCompletedMonthsSupply: null,
      currentPctCompleted: null,
      gap: null,
      asOf: null,
      signal: "insufficient",
      headline: "Completed Months Supply data unavailable.",
      explainer:
        "We couldn't pull the new-home inventory composition from FRED, so we can't separate the raw months supply signal from the completion mix right now.",
      monthsSupplyHistory: msHist10y,
      completedMonthsSupplyHistory: cmsHist10y,
      pctCompletedHistory: pctHist10y,
    };
  }

  // Anchor the "current reading" to the latest date that exists in ALL three
  // source series. MSACSR can release a month before the stage-of-construction
  // breakdown, so taking the raw MSACSR's last point would misalign the gap
  // and the explainer ("raw MS today vs CMS one month ago"). Using the latest
  // common date keeps every current-value field on the same as-of month.
  const msTsSet = new Set(msacsr.map((p) => p.time));
  const sharedTs = cmsHistory
    .map((p) => p.time)
    .filter((t) => msTsSet.has(t));

  if (sharedTs.length === 0) {
    return {
      currentMonthsSupply: null,
      currentCompletedMonthsSupply: null,
      currentPctCompleted: null,
      gap: null,
      asOf: null,
      signal: "insufficient",
      headline: "Completed Months Supply data unavailable.",
      explainer:
        "Months-supply and inventory-composition series have no overlapping dates, so we can't anchor today's reading to a common month.",
      monthsSupplyHistory: msHist10y,
      completedMonthsSupplyHistory: cmsHist10y,
      pctCompletedHistory: pctHist10y,
    };
  }

  const anchorTs = sharedTs[sharedTs.length - 1];
  const msByTs = new Map(msacsr.map((p) => [p.time, p.value]));
  const cmsByTs = new Map(cmsHistory.map((p) => [p.time, p.value]));

  const currentMs = msByTs.get(anchorTs)!;
  const currentCms = cmsByTs.get(anchorTs)!;

  // Trim both history arrays to end at the shared anchor month, so the dual-
  // line chart's gray (raw) and blue (completed) series cover the same window
  // and any visual subtraction at a given x-coordinate is genuine.
  const msHistAligned = msHist10y.filter((p) => p.time <= anchorTs);
  const cmsHistAligned = cmsHist10y.filter((p) => p.time <= anchorTs);
  const pctHistAligned = pctHist10y.filter((p) => p.time <= anchorTs);
  const lastCompleted = completedByTs.get(anchorTs);
  const lastTotal = totalByTs.get(anchorTs);
  const pctCompleted =
    lastCompleted != null && lastTotal != null && lastTotal > 0
      ? (lastCompleted / lastTotal) * 100
      : null;
  const gap = currentMs - currentCms;

  // Bucket the *completed* months supply (CMS), since that's the corrected signal.
  // Bands chosen to mirror the raw MSACSR bands (>7 warning, >8 recessionary)
  // but applied to CMS, which never overshot historically the way raw MSACSR did.
  let signal: CmsSignal;
  if (currentCms >= 8) signal = "recessionary";
  else if (currentCms >= 7) signal = "elevated";
  else if (currentCms >= 4) signal = "normal";
  else signal = "tight";

  const cmsTxt = currentCms.toFixed(1);
  const msTxt = currentMs.toFixed(1);
  const pctTxt = pctCompleted != null ? `${pctCompleted.toFixed(0)}%` : "—";

  let headline: string;
  switch (signal) {
    case "recessionary":
      headline = `Completed Months Supply at ${cmsTxt} — recession-territory reading.`;
      break;
    case "elevated":
      headline = `Completed Months Supply at ${cmsTxt} — elevated, the corrected signal is firing.`;
      break;
    case "normal":
      headline = `Completed Months Supply at ${cmsTxt} — within the historical normal range.`;
      break;
    case "tight":
      headline = `Completed Months Supply at ${cmsTxt} — supply of finished homes is tight.`;
      break;
    default:
      headline = "Completed Months Supply data unavailable.";
  }

  const gapBig = Math.abs(gap) >= 2;
  const explainer = gapBig
    ? `Raw months supply reads ${msTxt} but only ${pctTxt} of new-home inventory is actually completed, so the corrected metric sits at ${cmsTxt}. The gap means a lot of "inventory" is still under construction — the same composition effect that produced the false 2022 recession signal.`
    : `Raw months supply reads ${msTxt} and the completion-mix-adjusted version reads ${cmsTxt}, with ${pctTxt} of inventory finished. The two metrics are tracking close together, so today's signal isn't being distorted by an unusual construction backlog.`;

  return {
    currentMonthsSupply: currentMs,
    currentCompletedMonthsSupply: currentCms,
    currentPctCompleted: pctCompleted,
    gap,
    asOf: anchorTs,
    signal,
    headline,
    explainer,
    monthsSupplyHistory: msHistAligned,
    completedMonthsSupplyHistory: cmsHistAligned,
    pctCompletedHistory: pctHistAligned,
  };
}

export async function fetchHousingPayload(): Promise<HousingPayload> {
  logger.info("Fetching housing FRED series...");

  const [fedfundsAll, msacsrAll, completedAll, totalAll, ...seriesData] = await Promise.all([
    fetchFredAll("FEDFUNDS"),
    // Pull the CMS series from their FRED inception (MSACSR=1963, inventory
    // series=1973) so the chart spans every postwar recession, not just the
    // last three. The other dominoes still use the default 1990 start.
    fetchFredSafe("MSACSR", "1963-01-01"),
    fetchFredSafe("NHFSEPCS", "1973-01-01"),
    fetchFredSafe("NHFSEPTS", "1973-01-01"),
    ...SERIES.map((s) => fetchFredAll(s.series)),
  ]);

  const dominoesRaw: DominoStatus[] = SERIES.map((meta, i) => computeDomino(meta, seriesData[i]));

  // orderStatus is per-domino but depends on the whole array, so we set it after.
  const orderStatuses = computeOrderStatuses(dominoesRaw);
  const dominoes: DominoStatus[] = dominoesRaw.map((d, i) => ({
    ...d,
    orderStatus: orderStatuses[i],
  }));

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

  // Plain-English templates from the same numbers.
  const headline = makeHeadline(dominoes, fed, stage, sequenceValid);
  const summary = makeSummary(dominoes, sequenceValid);
  const fedContext = makeFedContext(fed, fedfundsAll);

  const completedMonthsSupply = computeCompletedMonthsSupply(
    msacsrAll,
    completedAll,
    totalAll,
  );

  return {
    fed,
    dominoes,
    stage,
    stageLabel,
    expectedTimingMonths,
    expectedTimingNote,
    sequenceValid,
    sequenceNote,
    headlineLabel: headline.label,
    headlineSubtitle: headline.subtitle,
    summary,
    fedContext,
    completedMonthsSupply,
    lastUpdated: Math.floor(Date.now() / 1000),
  };
}
