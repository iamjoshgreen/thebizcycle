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

// ─── Chart ────────────────────────────────────────────────────────────────────

interface ChartProps {
  series: BtcQuantilePoint[];
  cyclePeaks: BtcCyclePeak[];
}

// Price level tick marks shown on the log Y-axis
const Y_TICKS = [50, 100, 300, 1_000, 3_000, 10_000, 30_000, 100_000, 300_000, 1_000_000];

function fmtYTick(v: number): string {
  if (v >= 1_000_000) return `$${v / 1_000_000}M`;
  if (v >= 1_000) return `$${v / 1_000}K`;
  return `$${v}`;
}

// ─── Recharts ComposedChart with log Y-axis ───────────────────────────────────
//
// X-axis: calendar time (unix seconds, linear).
// Y-axis: BTC price, log scale — Recharts handles the log transform natively.
// Bands (upper q=0.90, median q=0.50, lower q=0.10) plotted as dashed Lines.
// Fill between lower and upper achieved by layering two Areas with different fills.
// Area keys are aliased (upperFill / lowerFill) so the same dataKey is not shared
// between an Area and a Line, which would cause Recharts to render only one.

type ChartDatum = {
  time: number;
  price: number | undefined;
  upper: number;
  upperFill: number;
  median: number;
  lower: number;
  lowerFill: number;
};

function BtcQuantileChart({ series, cyclePeaks }: ChartProps) {
  const mono = "'JetBrains Mono', monospace";
  const bg = "hsl(230, 14%, 8%)";
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
    time: p.time,
    price: p.price ?? undefined,
    upper: p.upper,
    upperFill: p.upper,
    median: p.median,
    lower: p.lower,
    lowerFill: p.lower,
  }));

  const histSeries = series.filter((p) => p.price != null);
  const lastHistTime = histSeries[histSeries.length - 1]?.time ?? nowSec;

  // Y domain with padding above and below
  const allVals = series.flatMap((p) => [
    p.lower,
    p.upper,
    ...(p.price != null ? [p.price] : []),
  ]);
  const yMin = Math.min(...allVals) * 0.65;
  const yMax = Math.max(...allVals) * 1.5;
  const yTicks = Y_TICKS.filter((t) => t >= yMin * 0.9 && t <= yMax * 1.1);

  // X domain and year-boundary ticks
  const xMin = series[0].time;
  const xMax = series[series.length - 1].time;
  const startYear = new Date(xMin * 1000).getUTCFullYear();
  const endYear = new Date(xMax * 1000).getUTCFullYear();
  const yearStep = endYear - startYear > 10 ? 2 : 1;
  const yearTicks: number[] = [];
  for (let y = Math.ceil(startYear / yearStep) * yearStep; y <= endYear; y += yearStep) {
    yearTicks.push(Math.floor(new Date(`${y}-01-01T00:00:00Z`).getTime() / 1000));
  }

  // Only annotate cycle peaks that fall within the chart's x-range
  const visiblePeaks = cyclePeaks.filter((p) => p.time >= xMin && p.time <= xMax);

  return (
    <div>
      {/* Legend */}
      <div
        style={{
          display: "flex",
          gap: 20,
          padding: "0 0 10px 76px",
          flexWrap: "wrap",
        }}
      >
        {[
          { label: "q=0.90 (upper)", color: "rgba(239,100,100,0.8)", dash: "5 4" },
          { label: "q=0.50 (median)", color: "rgba(180,180,200,0.5)", dash: "3 4" },
          { label: "q=0.10 (lower)", color: "rgba(52,211,153,0.8)", dash: "5 4" },
          { label: "BTC price", color: "rgba(247,147,26,0.9)", dash: "" },
        ].map((item) => (
          <div
            key={item.label}
            style={{ display: "flex", alignItems: "center", gap: 6 }}
          >
            <svg width="20" height="10">
              <line
                x1={0}
                y1={5}
                x2={20}
                y2={5}
                stroke={item.color}
                strokeWidth={item.dash ? 1.2 : 1.6}
                strokeDasharray={item.dash || undefined}
              />
            </svg>
            <span
              style={{
                fontSize: 9,
                fontFamily: mono,
                color: "rgba(180,180,200,0.6)",
              }}
            >
              {item.label}
            </span>
          </div>
        ))}
      </div>

      <ResponsiveContainer width="100%" height={500}>
        <ComposedChart
          data={chartData}
          margin={{ top: 10, right: 20, bottom: 28, left: 8 }}
        >
          <XAxis
            dataKey="time"
            type="number"
            domain={[xMin, xMax]}
            ticks={yearTicks}
            tickFormatter={(t: number) =>
              String(new Date(t * 1000).getUTCFullYear())
            }
            tick={{ fontSize: 10, fontFamily: mono, fill: "rgba(180,180,200,0.5)" }}
            axisLine={false}
            tickLine={false}
          />
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

          {/* Projection zone */}
          <ReferenceArea
            x1={lastHistTime}
            x2={xMax}
            fill="rgba(180,180,200,0.025)"
            stroke="none"
          />

          {/* Band fill: layer upperFill (red tint to bottom) then lowerFill (bg to bottom)
              to produce a net fill only between lower and upper bands. */}
          <Area
            type="monotone"
            dataKey="upperFill"
            fill="rgba(200,160,80,0.1)"
            stroke="none"
            dot={false}
            isAnimationActive={false}
            legendType="none"
          />
          <Area
            type="monotone"
            dataKey="lowerFill"
            fill={bg}
            stroke="none"
            dot={false}
            isAnimationActive={false}
            legendType="none"
          />

          {/* Quantile band lines */}
          <Line
            type="monotone"
            dataKey="upper"
            stroke="rgba(239,100,100,0.7)"
            strokeDasharray="5 4"
            strokeWidth={1.25}
            dot={false}
            isAnimationActive={false}
            legendType="none"
          />
          <Line
            type="monotone"
            dataKey="median"
            stroke="rgba(180,180,200,0.4)"
            strokeDasharray="3 4"
            strokeWidth={1}
            dot={false}
            isAnimationActive={false}
            legendType="none"
          />
          <Line
            type="monotone"
            dataKey="lower"
            stroke="rgba(52,211,153,0.7)"
            strokeDasharray="5 4"
            strokeWidth={1.25}
            dot={false}
            isAnimationActive={false}
            legendType="none"
          />

          {/* BTC price — null gaps naturally break the line in projection zone */}
          <Line
            type="monotone"
            dataKey="price"
            stroke="rgba(247,147,26,0.9)"
            strokeWidth={1.6}
            dot={false}
            isAnimationActive={false}
            connectNulls={false}
            legendType="none"
          />

          {/* Today marker */}
          {nowSec >= xMin && nowSec <= xMax && (
            <ReferenceLine
              x={nowSec}
              stroke="rgba(220,225,235,0.25)"
              strokeDasharray="3 3"
              label={{
                value: "today",
                position: "insideTopRight",
                fontSize: 9,
                fontFamily: mono,
                fill: "rgba(220,225,235,0.4)",
              }}
            />
          )}

          {/* Cycle peak vertical lines + labels */}
          {visiblePeaks.map((peak) => (
            <ReferenceLine
              key={peak.label}
              x={peak.time}
              stroke="rgba(220,225,235,0.15)"
              strokeDasharray="2 3"
              label={{
                value: `${peak.label}  ${Math.round(peak.pctOfUpper * 100)}%↑`,
                position: "insideTopLeft",
                fontSize: 8,
                fontFamily: mono,
                fill: "rgba(247,147,26,0.7)",
              }}
            />
          ))}

          {/* Suppress default tooltip */}
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
        <span>Support (q=0.10)</span>
        <span>Resistance (q=0.90)</span>
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
        {ordinal(clamped)} percentile between support and resistance bands
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
            {["Cycle Peak", "Date", "Peak Price", "Upper Band", "% of Upper Band"].map(
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
              p.pctOfUpper > 0.85
                ? "rgba(52,211,153,0.9)"
                : p.pctOfUpper > 0.65
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
                <td style={numCell}>{fmtPrice(p.upperBand)}</td>
                <td style={{ ...numCell, color: pctColor, fontWeight: 700 }}>
                  {(p.pctOfUpper * 100).toFixed(1)}%
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

  // % gap to upper band
  const gapToUpper =
    data?.currentPrice != null && data?.currentUpper != null && data.currentUpper > 0
      ? ((data.currentUpper - data.currentPrice) / data.currentPrice) * 100
      : null;

  // gap from current price to lower band (positive = lower band is above price = unusual)
  const gapToLower =
    data?.currentPrice != null && data?.currentLower != null && data.currentLower > 0
      ? ((data.currentLower - data.currentPrice) / data.currentPrice) * 100
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
            Log-log quantile regression on Bitcoin's full price history. The upper band
            curves inward across cycles; the lower band holds as a near-straight power law.
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
              label="Band Position"
              value={pctDisplay}
              sub={
                data.currentPercentile != null && gapToLower != null && gapToLower > 0
                  ? "below q=0.10 support band"
                  : "between q=0.10 and q=0.90"
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
              label="Upper Band (q=0.90)"
              value={fmtPrice(data.currentUpper)}
              sub={gapToUpper != null ? `${fmtPct(gapToUpper)} above current price` : undefined}
              accent="rgba(239,100,100,0.8)"
            />
            <StatCard
              label="Lower Band (q=0.10)"
              value={fmtPrice(data.currentLower)}
              sub={lowerBandSub}
              accent="rgba(52,211,153,0.8)"
            />
            <StatCard label="Median (q=0.50)" value={fmtPrice(data.currentMedian)} />
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
              Fetches BTC-USD history from Yahoo Finance and fits quantile bands (~20s)
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
                  title: "What the bands show",
                  text:
                    "Bitcoin's price has historically oscillated between two power-law boundaries in log-log space. The lower band (q=0.10) describes where price has repeatedly found structural support — a near-straight power law since 2014. The upper band (q=0.90) describes where speculative peaks have occurred — but with a quadratic term that causes it to bend inward over time.",
                },
                {
                  title: "The asymmetry",
                  text:
                    "Each cycle peak has reached a smaller fraction of the upper band than the previous one — diminishing speculative returns. The quadratic curvature in the upper tail captures this as a single parameter. The lower tail carries no statistically significant curvature. The difference is the formal counterpart to the diminishing-returns pattern.",
                },
                {
                  title: "What it is not",
                  text:
                    "The upper band is not a price target, ceiling, or 'fair value.' The lower band is not a guaranteed floor. The percentile position measures where price sits within its historical distribution — not the probability of future gains or losses. These are distributional summaries, not forecasts.",
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
