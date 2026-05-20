import YahooFinanceClass from "yahoo-finance2";
import { logger } from "./logger.js";
import { fetchWithRetry } from "./fetchWithRetry.js";

const yahooFinance = new YahooFinanceClass();

const FRED_BASE = "https://api.stlouisfed.org/fred/series/observations";
const FRED_KEY = process.env.FRED_API_KEY;

// ─── Types (mirror the OpenAPI schema) ────────────────────────────────────────

export type GliComponentId = "fed" | "ecb" | "boj" | "boe" | "pboc";

export type GliStatus = "expanding" | "stalling" | "contracting" | "insufficient";

export interface GliComponent {
  id: GliComponentId;
  label: string;
  series: string;
  available: boolean;
  latestUsdTrillions: number | null;
  mom4wPct: number | null;
  weeklyContributionUsdB: number | null;
  note: string | null;
}

export interface GliPoint {
  time: number;
  value: number;
}

export interface NberRecessionInterval {
  start: number;
  end: number;
}

export interface GliPayload {
  latestTime: number | null;
  latestGliUsdT: number | null;
  mom4wPct: number | null;
  yoyPct: number | null;
  roc13wAnnPct: number | null;
  roc26wAnnPct: number | null;
  status: GliStatus;
  statusLabel: string;
  statusBlurb: string;
  components: GliComponent[];
  history: GliPoint[];
  normalizedHistory: GliPoint[];
  normalizedSmaHistory: GliPoint[];
  normalizedWithM2History: GliPoint[];
  normalizedWithM2SmaHistory: GliPoint[];
  fxNeutralHistory: GliPoint[];
  anchorTime: number | null;
  asiaDataThrough: number | null;
  m2Available: boolean;
  rocAnn13wHistory: GliPoint[];
  rocAnn26wHistory: GliPoint[];
  btcHistory: GliPoint[];
  spxHistory: GliPoint[];
  dxyHistory: GliPoint[];
  dxyLatest: number | null;
  dxyChange13wPct: number | null;
  dxyBlurb: string;
  nberRecessions: NberRecessionInterval[];
  defaultLagDays: number;
  lagPresets: number[];
  partialData: boolean;
  notes: string[];
  lastUpdated: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const OBS_START = "2003-01-01";
const DEFAULT_LAG_DAYS = 75;
const LAG_PRESETS = [56, 60, 75];
const WEEK_MS = 7 * 24 * 3600 * 1000;

// ─── FRED helpers ─────────────────────────────────────────────────────────────

interface FredPoint {
  time: number; // unix seconds at midnight UTC of the observation date
  value: number;
  dateStr: string; // YYYY-MM-DD
}

async function fetchFred(series: string): Promise<FredPoint[]> {
  if (!FRED_KEY) throw new Error("FRED_API_KEY not set");
  const url = `${FRED_BASE}?series_id=${series}&api_key=${FRED_KEY}&file_type=json&observation_start=${OBS_START}`;
  const resp = await fetchWithRetry(url, { label: `FRED ${series}` });
  if (!resp.ok) throw new Error(`FRED error ${resp.status} for ${series}`);
  const json = (await resp.json()) as {
    observations: Array<{ date: string; value: string }>;
  };
  const out: FredPoint[] = [];
  for (const obs of json.observations) {
    const v = parseFloat(obs.value);
    if (!isFinite(v)) continue;
    const ts = Math.floor(new Date(obs.date + "T00:00:00Z").getTime() / 1000);
    out.push({ time: ts, value: v, dateStr: obs.date });
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

async function tryFetchFred(series: string): Promise<FredPoint[] | null> {
  try {
    return await fetchFred(series);
  } catch (err) {
    logger.warn({ err, series }, "FRED fetch failed (gli)");
    return null;
  }
}

async function fetchUsrec(): Promise<FredPoint[] | null> {
  try {
    if (!FRED_KEY) throw new Error("FRED_API_KEY not set");
    const url = `${FRED_BASE}?series_id=USREC&api_key=${FRED_KEY}&file_type=json&observation_start=1990-01-01`;
    const resp = await fetchWithRetry(url, { label: "FRED USREC" });
    if (!resp.ok) throw new Error(`FRED error ${resp.status} for USREC`);
    const json = (await resp.json()) as {
      observations: Array<{ date: string; value: string }>;
    };
    const out: FredPoint[] = [];
    for (const obs of json.observations) {
      const v = parseFloat(obs.value);
      if (!isFinite(v)) continue;
      const ts = Math.floor(new Date(obs.date + "T00:00:00Z").getTime() / 1000);
      out.push({ time: ts, value: v, dateStr: obs.date });
    }
    return out;
  } catch (err) {
    logger.warn({ err }, "FRED USREC fetch failed (gli)");
    return null;
  }
}

// ─── Friday grid ──────────────────────────────────────────────────────────────

function toUnix(d: Date): number {
  return Math.floor(d.getTime() / 1000);
}

function fridayOnOrBefore(d: Date): Date {
  const out = new Date(d);
  out.setUTCHours(0, 0, 0, 0);
  const dow = out.getUTCDay(); // 0=Sun..6=Sat
  // Map to last Friday on or before
  // dow=5 → 0; dow=6 → 1; dow=0 → 2; dow=1 → 3; etc.
  const delta = (dow + 2) % 7;
  out.setUTCDate(out.getUTCDate() - delta);
  return out;
}

function fridaysBetween(startStr: string, endDate: Date): Date[] {
  const start = new Date(startStr + "T00:00:00Z");
  // first Friday on or after start
  const first = new Date(start);
  while (first.getUTCDay() !== 5) first.setUTCDate(first.getUTCDate() + 1);
  const lastFri = fridayOnOrBefore(endDate);
  const out: Date[] = [];
  for (let d = new Date(first); d <= lastFri; d.setUTCDate(d.getUTCDate() + 7)) {
    out.push(new Date(d));
  }
  return out;
}

// Forward-fill a sorted FredPoint[] to a Friday grid, returning the value
// as of (≤) each Friday (latest observation ≤ that date).
function forwardFill(points: FredPoint[] | null, fridays: Date[]): Map<number, number> {
  const out = new Map<number, number>();
  if (!points || points.length === 0) return out;
  let i = 0;
  let last: number | null = null;
  for (const friday of fridays) {
    const fts = toUnix(friday);
    while (i < points.length && points[i].time <= fts) {
      last = points[i].value;
      i++;
    }
    if (last != null) out.set(fts, last);
  }
  return out;
}

// ─── Yahoo helper ─────────────────────────────────────────────────────────────

interface YahooChartResult {
  quotes?: Array<{ date?: Date; close?: number | null }>;
}

async function yahooChartWithRetry(
  symbol: string,
  opts: { period1: string; period2: string; interval: "1wk" | "1d" | "1mo" },
): Promise<YahooChartResult | null> {
  const ATTEMPTS = 3;
  const BASE_DELAY = 400;
  const TIMEOUT_MS = 20_000;
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
      if (/Not Found|404|invalid|symbol/i.test(msg) && !/timeout|ECONN|ETIMEDOUT|network|fetch/i.test(msg)) {
        logger.warn({ symbol, err: msg }, "yahoo permanent failure");
        return null;
      }
      if (attempt === ATTEMPTS) break;
      await new Promise((r) => setTimeout(r, BASE_DELAY * 2 ** (attempt - 1)));
    }
  }
  logger.warn({ symbol, err: lastErr }, "yahoo fetch failed");
  return null;
}

function yahooToWeeklyMap(result: YahooChartResult | null): Map<number, number> {
  const out = new Map<number, number>();
  if (!result?.quotes) return out;
  for (const q of result.quotes) {
    if (!q.date || q.close == null) continue;
    // Anchor each weekly bar to its Friday (UTC)
    const d = new Date(q.date);
    d.setUTCHours(0, 0, 0, 0);
    const dow = d.getUTCDay();
    if (dow !== 5) {
      // shift forward to Friday of the same ISO week
      d.setUTCDate(d.getUTCDate() + (dow === 0 ? 5 : 5 - dow));
    }
    out.set(toUnix(d), q.close);
  }
  return out;
}

// ─── Component registry ──────────────────────────────────────────────────────
//
// Each component declares its FRED series, unit conversion to billions USD
// (using forward-filled FX maps), and a human label. For v1, BoE/PBoC have
// no reliable free source on FRED, so they are wired as null and surface as
// "unavailable" in the UI with a note.

interface ComponentSpec {
  id: GliComponentId;
  label: string;
  series: string;
  // Convert the raw FRED value to billions of USD, using FX maps where needed.
  // Returns null if FX is missing.
  toUsdB: (raw: number, ctx: { usdPerEur: number | null; usdPerJpy: number | null }) => number | null;
  // If the series is fundamentally unavailable in v1, set unavailableNote.
  unavailableNote?: string;
}

const COMPONENTS: ComponentSpec[] = [
  {
    id: "fed",
    label: "Federal Reserve (net of TGA + RRP)",
    series: "WALCL − WTREGEN − RRPONTSYD",
    toUsdB: (v) => v, // computed externally; raw is already in $B
  },
  {
    id: "ecb",
    label: "European Central Bank",
    series: "ECBASSETSW",
    // ECBASSETSW: Millions of Euros → /1000 → billions EUR → × usdPerEur
    toUsdB: (v, { usdPerEur }) => (usdPerEur == null ? null : (v / 1000) * usdPerEur),
  },
  {
    id: "boj",
    label: "Bank of Japan",
    series: "JPNASSETS",
    // JPNASSETS: 100 Million Yen units → × 0.1 → billions JPY → × usdPerJpy
    toUsdB: (v, { usdPerJpy }) => (usdPerJpy == null ? null : v * 0.1 * usdPerJpy),
  },
  {
    id: "pboc",
    label: "PBoC (FX reserves proxy)",
    series: "TRESEGCNM052N",
    // TRESEGCNM052N: Total Reserves excl. Gold for China, millions USD → /1000 → $B.
    // This is not the full PBoC balance sheet (~$6T) — FX reserves are ~$3.5T of it —
    // but it is the only reliable free active series and captures the FX-reserves
    // component of PBoC liquidity. The domestic-easing tools (MLF/PSL) are not in it.
    toUsdB: (v) => v / 1000,
  },
];

// ─── Status / blurb ───────────────────────────────────────────────────────────

function classifyStatus(
  latestRoc13w: number | null,
  mom4wPct: number | null,
): GliStatus {
  if (latestRoc13w == null && mom4wPct == null) return "insufficient";
  const roc = latestRoc13w ?? 0;
  const mom = mom4wPct ?? 0;
  if (roc > 2 && mom > 0) return "expanding";
  if (roc < -2 && mom < 0) return "contracting";
  return "stalling";
}

function statusCopy(s: GliStatus): { label: string; blurb: string } {
  switch (s) {
    case "expanding":
      return {
        label: "Liquidity expanding",
        blurb:
          "Central bank balance sheets net of sterilization are growing. Risk assets typically follow with a ~2-month lag — the bigger the acceleration, the bigger the catch-up trade.",
      };
    case "contracting":
      return {
        label: "Liquidity contracting",
        blurb:
          "Net global liquidity is falling. Risk assets tend to fade with a lag; rallies in this regime are usually mean reversions, not trend reversals.",
      };
    case "stalling":
      return {
        label: "Liquidity flat",
        blurb:
          "GLI is drifting sideways. Direction matters more than level — watch for a turn in the 13-week rate of change, which leads the price tape.",
      };
    default:
      return {
        label: "Insufficient data",
        blurb: "Not enough history to classify the liquidity regime yet.",
      };
  }
}

function dxyBlurbFor(
  liq: GliStatus,
  dxyChange13wPct: number | null,
): string {
  if (dxyChange13wPct == null) return "DXY context unavailable.";
  const dxyFalling = dxyChange13wPct < -0.5;
  const dxyRising = dxyChange13wPct > 0.5;
  if (liq === "expanding" && dxyFalling)
    return "Liquidity up, dollar down — the cleanest setup for BTC and global risk.";
  if (liq === "expanding" && dxyRising)
    return "Liquidity up but dollar firm — the bid is real but ex-US assets may lag.";
  if (liq === "contracting" && dxyRising)
    return "Liquidity down and dollar strong — defensive tape; rallies face headwinds.";
  if (liq === "contracting" && dxyFalling)
    return "Liquidity down but dollar soft — mixed signal; watch which turns first.";
  return "Direction in GLI and DXY are both modest — wait for a clearer move.";
}

// ─── Main entry ───────────────────────────────────────────────────────────────

export async function fetchGliPayload(): Promise<GliPayload> {
  const notes: string[] = [];

  // Fetch all FRED series we need in parallel.
  const [
    walcl,    // Fed total assets (millions USD, weekly)
    wtregen,  // TGA (millions USD, weekly)
    rrp,      // RRPONTSYD (billions USD, daily)
    ecb,      // ECBASSETSW (millions EUR, weekly)
    boj,      // JPNASSETS (100M JPY units, monthly)
    pboc,     // TRESEGCNM052N: China FX reserves (millions USD, monthly)
    dexusEu,  // DEXUSEU: USD per 1 EUR (daily)
    dexjpUs,  // DEXJPUS: JPY per 1 USD (daily)
    dxy,      // DTWEXBGS: nominal broad USD index (daily)
    usrec,
  ] = await Promise.all([
    tryFetchFred("WALCL"),
    tryFetchFred("WTREGEN"),
    tryFetchFred("RRPONTSYD"),
    tryFetchFred("ECBASSETSW"),
    tryFetchFred("JPNASSETS"),
    tryFetchFred("TRESEGCNM052N"),
    tryFetchFred("DEXUSEU"),
    tryFetchFred("DEXJPUS"),
    tryFetchFred("DTWEXBGS"),
    fetchUsrec(),
  ]);

  // ─── M2 / M3 money supply series (optional add-on, toggled in UI) ───────────
  const [m2us, m2cn, m3ez, m3jp, dexchUs] = await Promise.all([
    tryFetchFred("M2SL"),            // US M2, billions USD, monthly (SA)
    tryFetchFred("MYAGM2CNM189N"),   // China M2, 100M CNY, monthly (NSA)
    tryFetchFred("MYAGM3EZM196N"),   // Eurozone M3, millions EUR, monthly (NSA)
    tryFetchFred("MYAGM3JPM189N"),   // Japan M3, 100M JPY, monthly (NSA)
    tryFetchFred("DEXCHUS"),         // CNY per 1 USD, daily
  ]);
  const m2Available = !!(m2us && m2cn && m3ez && m3jp && dexchUs);
  if (!m2Available) {
    notes.push(
      "M2 overlay partially unavailable — toggle will be hidden or partial. Missing: " +
        [
          !m2us && "M2SL",
          !m2cn && "MYAGM2CNM189N",
          !m3ez && "MYAGM3EZM196N",
          !m3jp && "MYAGM3JPM189N",
          !dexchUs && "DEXCHUS",
        ].filter(Boolean).join(", "),
    );
  }

  if (!walcl) notes.push("Missing FRED series WALCL (Fed total assets)");
  if (!wtregen) notes.push("Missing FRED series WTREGEN (Treasury General Account)");
  if (!rrp) notes.push("Missing FRED series RRPONTSYD (Overnight RRP)");
  if (!ecb) notes.push("Missing FRED series ECBASSETSW (ECB total assets)");
  if (!boj) notes.push("Missing FRED series JPNASSETS (BoJ total assets)");
  if (!pboc) notes.push("Missing FRED series TRESEGCNM052N (China FX reserves)");
  if (!dexusEu) notes.push("Missing FRED series DEXUSEU (USD/EUR)");
  if (!dexjpUs) notes.push("Missing FRED series DEXJPUS (JPY/USD)");
  if (!dxy) notes.push("Missing FRED series DTWEXBGS (broad USD index)");

  // Transparency note: PBoC is a partial proxy (FX reserves only, not the full
  // balance sheet). It captures roughly $3.5T of ~$6T total — the domestic
  // easing tools (MLF/PSL) are not included. UK liquidity (BoE) is not in v1.
  notes.push(
    "PBoC component is China FX reserves (TRESEGCNM052N) — the only reliable free active series. It tracks the FX-reserve component of PBoC liquidity (~$3.5T) but understates domestic easing tools (MLF / PSL). BoE is not included.",
  );

  // Friday weekly grid. We start the chart at OBS_START and end at the
  // most recent completed Friday.
  const today = new Date();
  const fridays = fridaysBetween(OBS_START, today);

  // Forward-fill all series onto the Friday grid.
  const walclFf = forwardFill(walcl, fridays);   // millions USD
  const wtregenFf = forwardFill(wtregen, fridays); // millions USD
  const rrpFf = forwardFill(rrp, fridays);         // $B
  const ecbFf = forwardFill(ecb, fridays);         // millions EUR
  const bojFf = forwardFill(boj, fridays);         // 100M JPY units
  const pbocFf = forwardFill(pboc, fridays);       // millions USD
  const dexUsEuFf = forwardFill(dexusEu, fridays); // USD per EUR
  const dexJpUsFf = forwardFill(dexjpUs, fridays); // JPY per USD
  const dxyFf = forwardFill(dxy, fridays);         // index
  const m2usFf = forwardFill(m2us, fridays);       // $B USD
  const m2cnFf = forwardFill(m2cn, fridays);       // 100M CNY units
  const m3ezFf = forwardFill(m3ez, fridays);       // millions EUR
  const m3jpFf = forwardFill(m3jp, fridays);       // 100M JPY units
  const dexchUsFf = forwardFill(dexchUs, fridays); // CNY per USD

  // Build the GLI series + per-component USD-billion series on the grid.
  // Also keep per-component LOCAL-currency series (for the FX-neutral overlay).
  const fedUsdB = new Map<number, number>();
  const ecbUsdB = new Map<number, number>();
  const bojUsdB = new Map<number, number>();
  const pbocUsdB = new Map<number, number>();
  const ecbLocalB = new Map<number, number>();  // EUR billions
  const bojLocalB = new Map<number, number>();  // JPY billions
  const gli = new Map<number, number>(); // billions USD (CB only)
  const m2TotalB = new Map<number, number>(); // billions USD (M2/M3 stack)

  for (const friday of fridays) {
    const ts = toUnix(friday);
    const walclMUsd = walclFf.get(ts);
    const tga = wtregenFf.get(ts);
    const rrpV = rrpFf.get(ts);
    const ecbMEur = ecbFf.get(ts);
    const bojMJpy = bojFf.get(ts);
    const pbocMUsd = pbocFf.get(ts);
    const usdPerEur = dexUsEuFf.get(ts) ?? null;
    const dexJpy = dexJpUsFf.get(ts) ?? null;
    const usdPerJpy = dexJpy && dexJpy > 0 ? 1 / dexJpy : null;

    // Need all of Fed, ECB, BoJ, PBoC + FX to publish a GLI print for that week.
    if (walclMUsd == null || tga == null || rrpV == null) continue;
    if (ecbMEur == null || usdPerEur == null) continue;
    if (bojMJpy == null || usdPerJpy == null) continue;
    if (pbocMUsd == null) continue;

    // Unit conversion to billions USD:
    //   WALCL, WTREGEN: millions USD → /1000 → $B
    //   RRPONTSYD: already $B
    //   ECBASSETSW: millions EUR → /1000 → $B EUR → × usdPerEur
    //   JPNASSETS: 100M yen units → × 0.1 → $B yen → × usdPerJpy
    //   TRESEGCNM052N: millions USD → /1000 → $B (already USD-denominated)
    const fed = walclMUsd / 1000 - tga / 1000 - rrpV; // $B
    const ecbLoc = ecbMEur / 1000;                    // €B
    const bojLoc = bojMJpy * 0.1;                     // ¥B
    const ecbU = ecbLoc * usdPerEur;                  // $B
    const bojU = bojLoc * usdPerJpy;                  // $B
    const pbocU = pbocMUsd / 1000;                    // $B

    fedUsdB.set(ts, fed);
    ecbUsdB.set(ts, ecbU);
    bojUsdB.set(ts, bojU);
    pbocUsdB.set(ts, pbocU);
    ecbLocalB.set(ts, ecbLoc);
    bojLocalB.set(ts, bojLoc);
    gli.set(ts, fed + ecbU + bojU + pbocU);

    // M2/M3 stack (optional). Need all four + CNY FX + EUR FX + JPY FX.
    const m2usB = m2usFf.get(ts);             // $B
    const m2cnLoc = m2cnFf.get(ts);           // 100M CNY
    const m3ezLoc = m3ezFf.get(ts);           // millions EUR
    const m3jpLoc = m3jpFf.get(ts);           // 100M JPY
    const cnyPerUsd = dexchUsFf.get(ts) ?? null;
    const usdPerCny = cnyPerUsd && cnyPerUsd > 0 ? 1 / cnyPerUsd : null;
    if (
      m2usB != null && m2cnLoc != null && m3ezLoc != null && m3jpLoc != null &&
      usdPerCny != null
    ) {
      const m2cnUsdB = m2cnLoc * 0.1 * usdPerCny;         // 100M CNY → $B
      const m3ezUsdB = (m3ezLoc / 1000) * usdPerEur;      // millions EUR → $B
      const m3jpUsdB = m3jpLoc * 0.1 * usdPerJpy;         // 100M JPY → $B
      m2TotalB.set(ts, m2usB + m2cnUsdB + m3ezUsdB + m3jpUsdB);
    }
  }

  const gliHistory: GliPoint[] = Array.from(gli.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([time, v]) => ({ time, value: v / 1000 })); // billions → trillions

  // ─── Normalized index + 90d SMA + FX-neutral overlay ─────────────────────────
  // Anchor: first Friday on/after 2014-01-01 where every component publishes.
  const ANCHOR_SEED = Math.floor(new Date("2014-01-01T00:00:00Z").getTime() / 1000);
  let anchorTs: number | null = null;
  let fedAnchor = 0, ecbUsdAnchor = 0, bojUsdAnchor = 0, pbocAnchor = 0;
  let ecbLocAnchor = 0, bojLocAnchor = 0;
  for (const friday of fridays) {
    const ts = toUnix(friday);
    if (ts < ANCHOR_SEED) continue;
    const f = fedUsdB.get(ts);
    const eu = ecbUsdB.get(ts);
    const bu = bojUsdB.get(ts);
    const p = pbocUsdB.get(ts);
    const el = ecbLocalB.get(ts);
    const bl = bojLocalB.get(ts);
    if (f == null || eu == null || bu == null || p == null || el == null || bl == null) continue;
    anchorTs = ts;
    fedAnchor = f; ecbUsdAnchor = eu; bojUsdAnchor = bu; pbocAnchor = p;
    ecbLocAnchor = el; bojLocAnchor = bl;
    break;
  }
  const usdTotalAnchor = fedAnchor + ecbUsdAnchor + bojUsdAnchor + pbocAnchor;

  // Normalized USD GLI: rebased to 100 at anchor
  const normalizedHistory: GliPoint[] = anchorTs != null && usdTotalAnchor > 0
    ? gliHistory.map((p) => ({ time: p.time, value: (p.value * 1000) / usdTotalAnchor * 100 }))
    : [];

  // 90-day SMA ≈ 13 weekly bars (13 × 7d = 91d)
  function sma(series: GliPoint[], window: number): GliPoint[] {
    const out: GliPoint[] = [];
    if (series.length < window) return out;
    let sum = 0;
    for (let i = 0; i < window; i++) sum += series[i].value;
    out.push({ time: series[window - 1].time, value: sum / window });
    for (let i = window; i < series.length; i++) {
      sum += series[i].value - series[i - window].value;
      out.push({ time: series[i].time, value: sum / window });
    }
    return out;
  }
  const normalizedSmaHistory = sma(normalizedHistory, 13);

  // ─── GLI + M2 stack (matches the Pine "Master Global Liquidity" recipe) ─────
  // Build the combined series at every Friday where BOTH the CB stack and the
  // M2/M3 stack have a value, then rebase to 100 at the first Friday on/after
  // 2014-01-01 where the combined value is present.
  const combinedB = new Map<number, number>(); // billions USD
  for (const [t, cbB] of gli) {
    const m2B = m2TotalB.get(t);
    if (m2B == null) continue;
    combinedB.set(t, cbB + m2B);
  }
  const combinedHistoryB: GliPoint[] = Array.from(combinedB.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([time, v]) => ({ time, value: v }));

  let combinedAnchorB = 0;
  for (const p of combinedHistoryB) {
    if (p.time < ANCHOR_SEED) continue;
    combinedAnchorB = p.value;
    break;
  }
  const normalizedWithM2History: GliPoint[] =
    combinedAnchorB > 0
      ? combinedHistoryB.map((p) => ({ time: p.time, value: (p.value / combinedAnchorB) * 100 }))
      : [];
  const normalizedWithM2SmaHistory = sma(normalizedWithM2History, 13);

  // FX-neutral: weight each component by its USD share at anchor, but index each
  // by its LOCAL-currency value rebased to 100 at anchor. Strips dollar moves.
  const fxNeutralHistory: GliPoint[] = [];
  if (
    anchorTs != null && usdTotalAnchor > 0 &&
    fedAnchor > 0 && ecbLocAnchor > 0 && bojLocAnchor > 0 && pbocAnchor > 0
  ) {
    const wFed = fedAnchor / usdTotalAnchor;
    const wEcb = ecbUsdAnchor / usdTotalAnchor;
    const wBoj = bojUsdAnchor / usdTotalAnchor;
    const wPboc = pbocAnchor / usdTotalAnchor;
    for (const p of gliHistory) {
      const t = p.time;
      const fv = fedUsdB.get(t);
      const el = ecbLocalB.get(t);
      const bl = bojLocalB.get(t);
      const pv = pbocUsdB.get(t);
      if (fv == null || el == null || bl == null || pv == null) continue;
      const idx =
        wFed * (fv / fedAnchor) * 100 +
        wEcb * (el / ecbLocAnchor) * 100 +
        wBoj * (bl / bojLocAnchor) * 100 +
        wPboc * (pv / pbocAnchor) * 100;
      fxNeutralHistory.push({ time: t, value: idx });
    }
  }

  // Asia stale-data badge: latest raw observation date for BoJ and PBoC.
  const bojRawLatest = boj && boj.length > 0 ? boj[boj.length - 1].time : null;
  const pbocRawLatest = pboc && pboc.length > 0 ? pboc[pboc.length - 1].time : null;
  const asiaDataThrough =
    bojRawLatest != null && pbocRawLatest != null
      ? Math.min(bojRawLatest, pbocRawLatest)
      : (bojRawLatest ?? pbocRawLatest ?? null);

  // 13/26-week annualized rate of change.
  function annRoc(series: GliPoint[], weeks: number): GliPoint[] {
    const out: GliPoint[] = [];
    for (let i = weeks; i < series.length; i++) {
      const cur = series[i].value;
      const prev = series[i - weeks].value;
      if (prev <= 0) continue;
      const ratio = cur / prev;
      const ann = Math.pow(ratio, 52 / weeks) - 1;
      out.push({ time: series[i].time, value: ann * 100 });
    }
    return out;
  }
  const rocAnn13w = annRoc(gliHistory, 13);
  const rocAnn26w = annRoc(gliHistory, 26);

  // Headline metrics
  const latest = gliHistory.length > 0 ? gliHistory[gliHistory.length - 1] : null;
  const latestTime = latest?.time ?? null;
  const latestGliUsdT = latest?.value ?? null;

  function pctChangeBack(series: GliPoint[], weeks: number): number | null {
    if (series.length <= weeks) return null;
    const cur = series[series.length - 1].value;
    const prev = series[series.length - 1 - weeks].value;
    if (prev <= 0) return null;
    return ((cur - prev) / prev) * 100;
  }
  const mom4wPct = pctChangeBack(gliHistory, 4);
  const yoyPct = pctChangeBack(gliHistory, 52);

  const latestRoc13w =
    rocAnn13w.length > 0 ? rocAnn13w[rocAnn13w.length - 1].value : null;
  const latestRoc26w =
    rocAnn26w.length > 0 ? rocAnn26w[rocAnn26w.length - 1].value : null;

  const status = classifyStatus(latestRoc13w, mom4wPct);
  const { label: statusLabel, blurb: statusBlurb } = statusCopy(status);

  // Per-component summaries
  function summarizeComponent(spec: ComponentSpec, seriesMap: Map<number, number>): GliComponent {
    if (spec.unavailableNote) {
      return {
        id: spec.id,
        label: spec.label,
        series: spec.series,
        available: false,
        latestUsdTrillions: null,
        mom4wPct: null,
        weeklyContributionUsdB: null,
        note: spec.unavailableNote,
      };
    }
    const sorted = Array.from(seriesMap.entries()).sort((a, b) => a[0] - b[0]);
    if (sorted.length === 0) {
      return {
        id: spec.id,
        label: spec.label,
        series: spec.series,
        available: false,
        latestUsdTrillions: null,
        mom4wPct: null,
        weeklyContributionUsdB: null,
        note: "No data points after joining with FX series",
      };
    }
    const last = sorted[sorted.length - 1][1]; // $B
    const fourBack = sorted.length > 4 ? sorted[sorted.length - 1 - 4][1] : null;
    const oneBack = sorted.length > 1 ? sorted[sorted.length - 2][1] : null;
    return {
      id: spec.id,
      label: spec.label,
      series: spec.series,
      available: true,
      latestUsdTrillions: last / 1000,
      mom4wPct: fourBack != null && fourBack !== 0 ? ((last - fourBack) / Math.abs(fourBack)) * 100 : null,
      weeklyContributionUsdB: oneBack != null ? last - oneBack : null,
      note: null,
    };
  }

  const components: GliComponent[] = [
    summarizeComponent(COMPONENTS[0], fedUsdB),
    summarizeComponent(COMPONENTS[1], ecbUsdB),
    summarizeComponent(COMPONENTS[2], bojUsdB),
    summarizeComponent(COMPONENTS[3], pbocUsdB),
  ];

  // DXY: weekly history + latest + 13w change
  const dxyHistory: GliPoint[] = Array.from(dxyFf.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([time, value]) => ({ time, value }));
  const dxyLatest =
    dxyHistory.length > 0 ? dxyHistory[dxyHistory.length - 1].value : null;
  const dxyChange13wPct =
    dxyHistory.length > 13 && dxyHistory[dxyHistory.length - 1 - 13].value > 0
      ? ((dxyHistory[dxyHistory.length - 1].value -
          dxyHistory[dxyHistory.length - 1 - 13].value) /
          dxyHistory[dxyHistory.length - 1 - 13].value) *
        100
      : null;

  const dxyBlurb = dxyBlurbFor(status, dxyChange13wPct);

  // BTC + SPX weekly close from Yahoo (best-effort)
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const period2 = tomorrow.toISOString().slice(0, 10);
  const [btcRes, spxRes] = await Promise.all([
    yahooChartWithRetry("BTC-USD", { period1: OBS_START, period2, interval: "1wk" }),
    yahooChartWithRetry("^GSPC", { period1: OBS_START, period2, interval: "1wk" }),
  ]);
  if (!btcRes) notes.push("Yahoo BTC-USD unavailable");
  if (!spxRes) notes.push("Yahoo ^GSPC unavailable");

  const btcMap = yahooToWeeklyMap(btcRes);
  const spxMap = yahooToWeeklyMap(spxRes);
  const btcHistory: GliPoint[] = Array.from(btcMap.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([time, value]) => ({ time, value }));
  const spxHistory: GliPoint[] = Array.from(spxMap.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([time, value]) => ({ time, value }));

  // NBER recession intervals (from monthly USREC), windowed to chart range
  const nberRecessions: NberRecessionInterval[] = [];
  if (usrec) {
    let inRec = false;
    let start = 0;
    for (let i = 0; i < usrec.length; i++) {
      const p = usrec[i];
      const isRec = p.value === 1;
      if (isRec && !inRec) {
        inRec = true;
        start = p.time;
      } else if (!isRec && inRec) {
        inRec = false;
        nberRecessions.push({ start, end: p.time });
      }
    }
    if (inRec) {
      nberRecessions.push({ start, end: toUnix(today) });
    }
  }

  const partialData =
    !walcl ||
    !wtregen ||
    !rrp ||
    !ecb ||
    !boj ||
    !pboc ||
    !dexusEu ||
    !dexjpUs ||
    !dxy ||
    gliHistory.length === 0;

  const lastTsMs = latestTime ? latestTime * 1000 : null;
  const stale =
    lastTsMs != null && Date.now() - lastTsMs > 21 * WEEK_MS;
  if (stale) {
    notes.push(
      "GLI history may be stale — at least one component series has not updated recently."
    );
  }

  return {
    latestTime,
    latestGliUsdT,
    mom4wPct,
    yoyPct,
    roc13wAnnPct: latestRoc13w,
    roc26wAnnPct: latestRoc26w,
    status,
    statusLabel,
    statusBlurb,
    components,
    history: gliHistory,
    normalizedHistory,
    normalizedSmaHistory,
    normalizedWithM2History,
    normalizedWithM2SmaHistory,
    fxNeutralHistory,
    anchorTime: anchorTs,
    asiaDataThrough,
    m2Available,
    rocAnn13wHistory: rocAnn13w,
    rocAnn26wHistory: rocAnn26w,
    btcHistory,
    spxHistory,
    dxyHistory,
    dxyLatest,
    dxyChange13wPct,
    dxyBlurb,
    nberRecessions,
    defaultLagDays: DEFAULT_LAG_DAYS,
    lagPresets: LAG_PRESETS,
    partialData,
    notes,
    lastUpdated: Math.floor(Date.now() / 1000),
  };
}
