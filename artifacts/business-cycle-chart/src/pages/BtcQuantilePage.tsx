import {
  useGetBtcQuantile,
  useRefreshBtcQuantile,
  getGetBtcQuantileQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import type {
  BtcQuantilePayload,
  BtcQuantilePoint,
  BtcCyclePeak,
} from "@workspace/api-client-react";
import {
  ComposedChart,
  Line,
  Area,
  XAxis,
  YAxis,
  ReferenceLine,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
} from "recharts";
import TopBar from "@/components/TopBar";
import { useToast } from "@/hooks/use-toast";

// ─── Formatters ───────────────────────────────────────────────────────────────

function fmtPrice(n: number | null | undefined): string {
  if (n == null || !isFinite(n)) return "—";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${Math.round(n).toLocaleString("en-US")}`;
  return `$${n.toFixed(2)}`;
}

function fmtPct(n: number | null | undefined, digits = 1): string {
  if (n == null || !isFinite(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(digits)}%`;
}

function fmtTimestamp(unix: number): string {
  return new Date(unix * 1000).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function ordinal(n: number): string {
  const r = Math.round(n);
  const s = ["th", "st", "nd", "rd"];
  const v = r % 100;
  return r + (s[(v - 20) % 10] || s[v] || s[0]);
}

// ─── Constants ────────────────────────────────────────────────────────────────
//
// Display x-axis transform. This is the GENESIS used only for the log-time axis —
// it is intentionally separate from the model's anchor (the model uses its own
// fixed constants inside the backend). Jan 1, 2009 matches the model anchor.

const GENESIS_S = Math.floor(Date.UTC(2009, 0, 1) / 1000);
const DAY_S = 86400;

function toLogDays(unixSec: number): number {
  return Math.log(Math.max(1, (unixSec - GENESIS_S) / DAY_S));
}

// Seven-quantile fan, colored dark green → dark red to match the paper's Figure 1.
const QLINES: Array<{ key: keyof BtcQuantilePoint; color: string; label: string }> = [
  { key: "q01", color: "#1a6b2f", label: "1%" },
  { key: "q10", color: "#4a9d4f", label: "10%" },
  { key: "q25", color: "#8cc34f", label: "25%" },
  { key: "q50", color: "#c8b94a", label: "50%" },
  { key: "q75", color: "#e09a3e", label: "75%" },
  { key: "q95", color: "#d35f3a", label: "95%" },
  { key: "q99", color: "#a52828", label: "99%" },
];

const GOLD = "#d4af37";

// ─── Chart ────────────────────────────────────────────────────────────────────
//
// Recharts ComposedChart in true log-log space:
//   X-axis = log(days since genesis)  →  XAxis type="number" (linear over pre-transformed values)
//   Y-axis = log(price)               →  YAxis scale="log" (Recharts handles the log transform)
//
// Layers (back → front):
//   1. golden dislocation zone (Area between disl1 top and disl4 bottom)
//   2. four dashed dislocation lines below q01
//   3. seven-quantile fan (q01..q99), no fills between them
//   4. BTC price line on top

interface ChartProps {
  series: BtcQuantilePoint[];
  cyclePeaks: BtcCyclePeak[];
}

const Y_TICKS = [
  0.1, 0.3, 1, 5, 10, 50, 100, 300, 1_000, 3_000, 10_000, 30_000, 100_000, 300_000, 1_000_000,
];

function fmtYTick(v: number): string {
  if (v >= 1_000_000) return `$${v / 1_000_000}M`;
  if (v >= 1_000) return `$${v / 1_000}K`;
  if (v < 1) return `$${v}`;
  return `$${v}`;
}

type ChartDatum = {
  ld: number; // log(days since genesis) — the X coordinate
  price?: number;
  q01: number;
  q10: number;
  q25: number;
  q50: number;
  q75: number;
  q95: number;
  q99: number;
  disl1: number;
  disl2: number;
  disl3: number;
  disl4: number;
  gold: [number, number]; // [disl4 (bottom), disl1 (top)]
};

function BtcQuantileChart({ series, cyclePeaks }: ChartProps) {
  const mono = "'JetBrains Mono', monospace";
  const nowSec = Math.floor(Date.now() / 1000);

  if (series.length < 4) {
    return (
      <div
        style={{
          height: 520,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "rgba(180,180,200,0.35)",
          fontFamily: mono,
          fontSize: 13,
        }}
      >
        no data — click Refresh to load
      </div>
    );
  }

  const chartData: ChartDatum[] = series.map((p) => ({
    ld: toLogDays(p.time),
    price: p.price ?? undefined,
    q01: p.q01,
    q10: p.q10,
    q25: p.q25,
    q50: p.q50,
    q75: p.q75,
    q95: p.q95,
    q99: p.q99,
    disl1: p.disl1,
    disl2: p.disl2,
    disl3: p.disl3,
    disl4: p.disl4,
    gold: [p.disl4, p.disl1],
  }));

  const histSeries = series.filter((p) => p.price != null);
  const lastHistLd = toLogDays(histSeries[histSeries.length - 1]?.time ?? nowSec);
  const nowLd = toLogDays(nowSec);

  // Y domain — include dislocation floor (disl4) up to the top quantile (q99).
  const allVals = series.flatMap((p) => [
    p.disl4,
    p.q99,
    ...(p.price != null ? [p.price] : []),
  ]);
  const yMin = Math.min(...allVals) * 0.7;
  const yMax = Math.max(...allVals) * 1.4;
  const yTicks = Y_TICKS.filter((t) => t >= yMin * 0.9 && t <= yMax * 1.1);

  // X domain (logDays) — spans from first series point to end of projection
  const xMin = chartData[0].ld;
  const xMax = chartData[chartData.length - 1].ld;

  // Year-boundary ticks: compute logDays for Jan 1 of each year
  const startYear = new Date(series[0].time * 1000).getUTCFullYear();
  const endYear = new Date(series[series.length - 1].time * 1000).getUTCFullYear();
  const yearStep = endYear - startYear > 14 ? 2 : 1;
  const yearTicks: number[] = [];
  for (let y = Math.ceil(startYear / yearStep) * yearStep; y <= endYear; y += yearStep) {
    const t = Math.floor(new Date(`${y}-01-01T00:00:00Z`).getTime() / 1000);
    const ld = toLogDays(t);
    if (ld >= xMin && ld <= xMax) yearTicks.push(ld);
  }

  const peakAnnotations = cyclePeaks.map((p) => ({
    ...p,
    ld: toLogDays(p.time),
  }));

  return (
    <div>
      {/* Legend */}
      <div style={{ display: "flex", gap: 14, padding: "0 0 10px 76px", flexWrap: "wrap" }}>
        {QLINES.map((q) => (
          <div key={q.key} style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <svg width="18" height="10">
              <line x1={0} y1={5} x2={18} y2={5} stroke={q.color} strokeWidth={1.8} />
            </svg>
            <span style={{ fontSize: 9, fontFamily: mono, color: "rgba(180,180,200,0.6)" }}>
              {q.label}
            </span>
          </div>
        ))}
        <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <svg width="18" height="10">
            <rect x={0} y={2} width={18} height={6} fill={GOLD} fillOpacity={0.18} />
          </svg>
          <span style={{ fontSize: 9, fontFamily: mono, color: "rgba(180,180,200,0.6)" }}>
            dislocation zone
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <svg width="18" height="10">
            <line x1={0} y1={5} x2={18} y2={5} stroke="rgba(247,147,26,0.9)" strokeWidth={1.8} />
          </svg>
          <span style={{ fontSize: 9, fontFamily: mono, color: "rgba(180,180,200,0.6)" }}>
            BTC price
          </span>
        </div>
      </div>

      <ResponsiveContainer width="100%" height={500}>
        <ComposedChart data={chartData} margin={{ top: 10, right: 20, bottom: 28, left: 8 }}>
          {/* X-axis: log(days since genesis) — linear over pre-transformed values = log scale */}
          <XAxis
            dataKey="ld"
            type="number"
            domain={[xMin, xMax]}
            ticks={yearTicks}
            tickFormatter={(ld: number) => {
              const days = Math.exp(ld);
              const t = GENESIS_S + days * DAY_S;
              return String(new Date(t * 1000).getUTCFullYear());
            }}
            tick={{ fontSize: 10, fontFamily: mono, fill: "rgba(180,180,200,0.5)" }}
            axisLine={false}
            tickLine={false}
          />

          {/* Y-axis: log scale price */}
          <YAxis
            scale="log"
            domain={[yMin, yMax]}
            ticks={yTicks}
            tickFormatter={fmtYTick}
            tick={{ fontSize: 10, fontFamily: mono, fill: "rgba(247,147,26,0.6)" }}
            axisLine={false}
            tickLine={false}
            width={68}
            allowDataOverflow
          />

          {/* Projection zone shading */}
          <ReferenceArea x1={lastHistLd} x2={xMax} fill="rgba(180,180,200,0.025)" stroke="none" />

          {/* Golden dislocation zone: Area between disl4 (bottom) and disl1 (top) */}
          <Area
            type="monotone"
            dataKey="gold"
            fill={GOLD}
            fillOpacity={0.16}
            stroke="none"
            dot={false}
            isAnimationActive={false}
            legendType="none"
          />

          {/* Four dashed dislocation lines below q01 */}
          {(["disl1", "disl2", "disl3", "disl4"] as const).map((k) => (
            <Line
              key={k}
              type="monotone"
              dataKey={k}
              stroke={GOLD}
              strokeOpacity={0.55}
              strokeDasharray="4 4"
              strokeWidth={0.9}
              dot={false}
              isAnimationActive={false}
              legendType="none"
            />
          ))}

          {/* Seven-quantile fan (no fills between) */}
          {QLINES.map((q) => (
            <Line
              key={q.key}
              type="monotone"
              dataKey={q.key}
              stroke={q.color}
              strokeWidth={1.4}
              dot={false}
              isAnimationActive={false}
              legendType="none"
            />
          ))}

          {/* BTC price (null values leave a natural gap in the projection zone) */}
          <Line
            type="monotone"
            dataKey="price"
            stroke="rgba(247,147,26,0.95)"
            strokeWidth={1.7}
            dot={false}
            isAnimationActive={false}
            connectNulls={false}
            legendType="none"
          />

          {/* Today marker */}
          {nowLd >= xMin && nowLd <= xMax && (
            <ReferenceLine x={nowLd} stroke="rgba(220,225,235,0.25)" strokeDasharray="3 3"
              label={{ value: "today", position: "insideTopRight", fontSize: 9, fontFamily: mono, fill: "rgba(220,225,235,0.4)" }}
            />
          )}

          {/* Cycle peak markers */}
          {peakAnnotations.map((peak) => (
            <ReferenceLine key={peak.label} x={peak.ld}
              stroke="rgba(220,225,235,0.18)" strokeDasharray="2 3"
              label={{ value: `${peak.label}  ${fmtPrice(peak.price)}`, position: "insideTopLeft", fontSize: 8, fontFamily: mono, fill: "rgba(247,147,26,0.65)" }}
            />
          ))}

          <Tooltip content={() => null} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

// ─── Stat card ────────────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: string;
}) {
  return (
    <div
      style={{
        background: "hsl(230 12% 11%)",
        border: "1px solid hsl(230 10% 16%)",
        borderRadius: 8,
        padding: "14px 18px",
        minWidth: 148,
        flex: "1 1 148px",
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontFamily: "'JetBrains Mono', monospace",
          color: "rgba(180,180,200,0.5)",
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          marginBottom: 6,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 22,
          fontFamily: "'JetBrains Mono', monospace",
          fontWeight: 700,
          color: accent ?? "rgba(220,225,235,0.95)",
          letterSpacing: "-0.02em",
          lineHeight: 1,
          marginBottom: sub ? 6 : 0,
        }}
      >
        {value}
      </div>
      {sub && (
        <div
          style={{
            fontSize: 11,
            fontFamily: "'JetBrains Mono', monospace",
            color: "rgba(180,180,200,0.45)",
            marginTop: 4,
          }}
        >
          {sub}
        </div>
      )}
    </div>
  );
}

// ─── Percentile bar ──────────────────────────────────────────────────────────

function PercentileBar({ pct }: { pct: number | null | undefined }) {
  if (pct == null) return null;
  const clamped = Math.max(0, Math.min(100, pct));
  // Color: green at 0%, yellow at 50%, red at 100%
  const r = Math.round(clamped < 50 ? (clamped / 50) * 200 : 200);
  const g = Math.round(clamped < 50 ? 200 : ((100 - clamped) / 50) * 200);
  const color = `rgb(${r}, ${g}, 80)`;

  return (
    <div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: 10,
          fontFamily: "'JetBrains Mono', monospace",
          color: "rgba(180,180,200,0.4)",
          marginBottom: 5,
        }}
      >
        <span>Q1% (floor)</span>
        <span>Q99% (top)</span>
      </div>
      <div
        style={{
          height: 6,
          borderRadius: 3,
          background: "hsl(230 10% 16%)",
          position: "relative",
        }}
      >
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            bottom: 0,
            width: `${clamped}%`,
            borderRadius: 3,
            background: `linear-gradient(to right, rgba(52,211,153,0.7), ${color})`,
            transition: "width 0.4s ease",
          }}
        />
        <div
          style={{
            position: "absolute",
            top: -3,
            left: `${clamped}%`,
            transform: "translateX(-50%)",
            width: 12,
            height: 12,
            borderRadius: "50%",
            background: color,
            border: "2px solid hsl(230 14% 8%)",
            boxShadow: `0 0 6px ${color}80`,
          }}
        />
      </div>
      <div
        style={{
          textAlign: "center",
          marginTop: 8,
          fontSize: 12,
          fontFamily: "'JetBrains Mono', monospace",
          color,
          fontWeight: 700,
        }}
      >
        {ordinal(clamped)} percentile across the Q1%–Q99% quantile fan
      </div>
    </div>
  );
}

// ─── Cycle peaks table ────────────────────────────────────────────────────────

function CyclePeaksTable({ peaks }: { peaks: BtcCyclePeak[] }) {
  if (peaks.length === 0) return null;

  const cellStyle: React.CSSProperties = {
    padding: "10px 14px",
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 12,
    color: "rgba(220,225,235,0.85)",
    borderBottom: "1px solid hsl(230 10% 13%)",
    whiteSpace: "nowrap",
  };
  const numCell: React.CSSProperties = { ...cellStyle, textAlign: "right" };

  return (
    <div style={{ overflowX: "auto" }}>
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          fontSize: 12,
        }}
      >
        <thead>
          <tr>
            {["Cycle Peak", "Date", "Peak Price", "Q99% Band", "% of Q99%"].map(
              (h) => (
                <th
                  key={h}
                  style={{
                    ...cellStyle,
                    textAlign: h === "Cycle Peak" || h === "Date" ? "left" : "right",
                    color: "rgba(180,180,200,0.45)",
                    fontWeight: 600,
                    fontSize: 10,
                    letterSpacing: "0.06em",
                    textTransform: "uppercase",
                    borderBottom: "1px solid hsl(230 10% 16%)",
                  }}
                >
                  {h}
                </th>
              ),
            )}
          </tr>
        </thead>
        <tbody>
          {peaks.map((p) => {
            const pctColor =
              p.pctOfQ99 > 0.85
                ? "rgba(52,211,153,0.9)"
                : p.pctOfQ99 > 0.65
                ? "rgba(245,158,11,0.9)"
                : "rgba(239,100,100,0.9)";
            return (
              <tr key={p.label}>
                <td style={{ ...cellStyle, fontWeight: 700, color: "rgba(247,147,26,0.9)" }}>
                  {p.label}
                </td>
                <td style={cellStyle}>
                  {new Date(p.time * 1000).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                  })}
                </td>
                <td style={numCell}>{fmtPrice(p.price)}</td>
                <td style={numCell}>{fmtPrice(p.q99)}</td>
                <td style={{ ...numCell, color: pctColor, fontWeight: 700 }}>
                  {(p.pctOfQ99 * 100).toFixed(1)}%
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div
        style={{
          paddingTop: 10,
          fontSize: 11,
          fontFamily: "'JetBrains Mono', monospace",
          color: "rgba(180,180,200,0.35)",
        }}
      >
        Each cycle peak reached a smaller fraction of the upper band — the core asymmetry the
        model captures.
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function BtcQuantilePage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data, isLoading, error } = useGetBtcQuantile<BtcQuantilePayload>();

  const { mutate: refresh, isPending: isRefreshing } = useRefreshBtcQuantile({
    mutation: {
      onSuccess: (payload) => {
        queryClient.setQueryData(getGetBtcQuantileQueryKey(), payload);
        toast({ title: "BTC Quantile data refreshed" });
      },
      onError: (err) => {
        const msg = err instanceof Error ? err.message : "Refresh failed";
        toast({ title: "Refresh failed", description: msg, variant: "destructive" });
      },
    },
  });

  const isNoData = !isLoading && (error != null || data == null);

  const bg = "hsl(230 14% 8%)";
  const mono = "'JetBrains Mono', monospace";
  const sans = "'Inter', sans-serif";

  const currentPriceDisplay = data?.currentPrice != null ? fmtPrice(data.currentPrice) : "—";
  const pctDisplay =
    data?.currentPercentile != null
      ? `${ordinal(Math.round(data.currentPercentile))} pct.`
      : "—";

  // % gap from current price up to the Q95 band
  const gapToUpper =
    data?.currentPrice != null && data?.currentQ95 != null && data.currentQ95 > 0
      ? ((data.currentQ95 - data.currentPrice) / data.currentPrice) * 100
      : null;

  // gap from current price to Q10 band (positive = Q10 is above price = unusually low)
  const gapToLower =
    data?.currentPrice != null && data?.currentQ10 != null && data.currentQ10 > 0
      ? ((data.currentQ10 - data.currentPrice) / data.currentPrice) * 100
      : null;

  const lowerBandSub =
    gapToLower == null
      ? undefined
      : gapToLower > 0
      ? `${fmtPct(gapToLower)} above current price`
      : `${fmtPct(-gapToLower)} below current price`;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        background: bg,
        overflowY: "auto",
      }}
    >
      <TopBar
        lastUpdated={data?.lastUpdated ?? null}
        isRefreshing={isRefreshing}
        onRefresh={() => refresh()}
      />

      <div style={{ padding: "24px 20px 48px", maxWidth: 1200, margin: "0 auto", width: "100%" }}>
        {/* Page header */}
        <div style={{ marginBottom: 24 }}>
          <h1
            style={{
              fontSize: 20,
              fontFamily: sans,
              fontWeight: 700,
              color: "rgba(220,225,235,0.97)",
              letterSpacing: "-0.02em",
              marginBottom: 6,
            }}
          >
            BTC Asymmetric Quantile Bands
          </h1>
          <p
            style={{
              fontSize: 13,
              fontFamily: sans,
              color: "rgba(180,180,200,0.55)",
              lineHeight: 1.5,
              maxWidth: 640,
            }}
          >
            Seven fixed-coefficient quantiles (Table 3) of Bitcoin's price in log-log space.
            The upper quantiles curve inward across cycles — the asymmetric tail curvature —
            while the lower quantiles hold a near-straight power law. Deterministic, not fitted.
          </p>
        </div>

        {/* Stats row */}
        {data && (
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 10,
              marginBottom: 20,
            }}
          >
            <StatCard
              label="Current Price"
              value={currentPriceDisplay}
              sub={
                data.currentPrice != null
                  ? `Weekly close · ${new Date((data.series.find((p) => p.price != null) ? data.series.filter((p) => p.price != null).at(-1)!.time : 0) * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`
                  : undefined
              }
              accent="rgba(247,147,26,0.95)"
            />
            <StatCard
              label="Quantile Position"
              value={pctDisplay}
              sub={
                data.currentPercentile != null && data.currentPercentile < 1
                  ? "below the Q1% floor"
                  : "within the Q1%–Q99% fan"
              }
              accent={
                data.currentPercentile != null
                  ? data.currentPercentile > 75
                    ? "rgba(239,100,100,0.9)"
                    : data.currentPercentile < 25
                    ? "rgba(52,211,153,0.9)"
                    : "rgba(245,158,11,0.9)"
                  : undefined
              }
            />
            <StatCard
              label="Q95% Band"
              value={fmtPrice(data.currentQ95)}
              sub={gapToUpper != null ? `${fmtPct(gapToUpper)} above current price` : undefined}
              accent="rgba(211,95,58,0.85)"
            />
            <StatCard
              label="Q10% Band"
              value={fmtPrice(data.currentQ10)}
              sub={lowerBandSub}
              accent="rgba(74,157,79,0.85)"
            />
            <StatCard label="Q50% Median" value={fmtPrice(data.currentQ50)} accent="rgba(200,185,74,0.9)" />
          </div>
        )}

        {/* Loading / no-data state */}
        {isLoading && (
          <div
            style={{
              height: 520,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "rgba(180,180,200,0.35)",
              fontFamily: mono,
              fontSize: 13,
            }}
          >
            loading…
          </div>
        )}

        {isNoData && !isLoading && (
          <div
            style={{
              height: 520,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 12,
              color: "rgba(180,180,200,0.4)",
              fontFamily: mono,
              fontSize: 13,
            }}
          >
            <span>No data yet</span>
            <button
              onClick={() => refresh()}
              disabled={isRefreshing}
              style={{
                background: "hsl(224 100% 58% / 0.12)",
                border: "1px solid hsl(224 100% 58% / 0.25)",
                color: "hsl(224 100% 72%)",
                borderRadius: 6,
                padding: "8px 18px",
                fontSize: 13,
                fontFamily: mono,
                cursor: isRefreshing ? "not-allowed" : "pointer",
                opacity: isRefreshing ? 0.6 : 1,
              }}
            >
              {isRefreshing ? "Refreshing…" : "Refresh to load data"}
            </button>
            <span style={{ fontSize: 11, color: "rgba(180,180,200,0.3)" }}>
              Fetches BTC-USD history from Yahoo Finance and applies the fixed model (~5s)
            </span>
          </div>
        )}

        {/* Chart */}
        {data && data.series.length > 0 && (
          <div
            style={{
              border: "1px solid hsl(230 10% 14%)",
              borderRadius: 10,
              overflow: "hidden",
              background: "hsl(230 12% 9.5%)",
              marginBottom: 20,
            }}
          >
            <BtcQuantileChart series={data.series} cyclePeaks={data.cyclePeaks} />
          </div>
        )}

        {/* Percentile bar */}
        {data?.currentPercentile != null && (
          <div
            style={{
              background: "hsl(230 12% 11%)",
              border: "1px solid hsl(230 10% 16%)",
              borderRadius: 8,
              padding: "16px 20px",
              marginBottom: 20,
            }}
          >
            <PercentileBar pct={data.currentPercentile} />
          </div>
        )}

        {/* Cycle peaks table */}
        {data && data.cyclePeaks.length > 0 && (
          <div
            style={{
              background: "hsl(230 12% 11%)",
              border: "1px solid hsl(230 10% 16%)",
              borderRadius: 8,
              marginBottom: 20,
              overflow: "hidden",
            }}
          >
            <div
              style={{
                padding: "14px 18px 10px",
                fontSize: 11,
                fontFamily: mono,
                color: "rgba(180,180,200,0.4)",
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                borderBottom: "1px solid hsl(230 10% 13%)",
              }}
            >
              Historical Cycle Peaks
            </div>
            <div style={{ padding: "0 0 8px" }}>
              <CyclePeaksTable peaks={data.cyclePeaks} />
            </div>
          </div>
        )}

        {/* Model note + methodology */}
        {data && (
          <div
            style={{
              background: "hsl(230 12% 11%)",
              border: "1px solid hsl(230 10% 16%)",
              borderRadius: 8,
              padding: "18px 20px",
            }}
          >
            <div
              style={{
                fontSize: 12,
                fontFamily: mono,
                color: "rgba(180,180,200,0.4)",
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                marginBottom: 14,
              }}
            >
              Methodology &amp; Limits
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
                gap: 20,
              }}
            >
              {[
                {
                  title: "What the fan shows",
                  text:
                    "Seven quantiles (1, 10, 25, 50, 75, 95, 99%) of Bitcoin's price as fixed-coefficient curves in log-log space: log₁₀(price) = c + a·x + b·x², where x = ln(days since Jan 1 2009) − 7.9914. The coefficients come from Table 3 of the paper and are not re-estimated — the same curves render every time. Per date, the seven values are sorted ascending (rearrangement) to guarantee they never cross.",
                },
                {
                  title: "The asymmetry",
                  text:
                    "The upper quantiles carry a strong negative curvature (b ≈ −0.33) so they bend inward over time, while the lower quantiles are almost straight (b ≈ −0.02). That gap is the asymmetric tail curvature: speculative peaks reach a smaller multiple of trend each cycle, but the downside floor holds a near-constant power law. The cycle-peak table shows each top reaching a smaller fraction of Q99%.",
                },
                {
                  title: "Dislocation zone",
                  text:
                    "The four gold dashed lines sit 7.4%, 17.4%, 22.6%, and 34.6% below the Q1% quantile. The shaded golden band between the top and bottom lines marks the historical 'deep dislocation' region — where price has only briefly traded during capitulations. It is descriptive, not a buy signal.",
                },
                {
                  title: "What it is not",
                  text:
                    "The quantiles are not price targets, ceilings, or 'fair value,' and Q1% is not a guaranteed floor. The percentile readout shows where price sits within this fixed distribution today — not the probability of future gains or losses. The 2-year projection simply extends the deterministic curves; it is not a forecast.",
                },
                {
                  title: "Data & model",
                  text: data.modelNote,
                },
              ].map((block) => (
                <div key={block.title}>
                  <div
                    style={{
                      fontSize: 13,
                      fontFamily: sans,
                      fontWeight: 600,
                      color: "rgba(220,225,235,0.85)",
                      marginBottom: 6,
                      letterSpacing: "-0.01em",
                    }}
                  >
                    {block.title}
                  </div>
                  <div
                    style={{
                      fontSize: 12,
                      fontFamily: sans,
                      color: "rgba(180,180,200,0.55)",
                      lineHeight: 1.6,
                    }}
                  >
                    {block.text}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
