import { useRef } from "react";
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
import TopBar from "@/components/TopBar";
import { useToast } from "@/hooks/use-toast";

// ─── Constants ────────────────────────────────────────────────────────────────

const GENESIS_S = Math.floor(new Date("2009-01-03T00:00:00Z").getTime() / 1000);
const DAY_S = 86400;

function logDays(unixSec: number): number {
  return Math.log(Math.max(1, (unixSec - GENESIS_S) / DAY_S));
}

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

const PRICE_LEVELS = [
  100, 300, 1_000, 3_000, 10_000, 30_000, 100_000, 300_000, 1_000_000,
];

interface ChartProps {
  series: BtcQuantilePoint[];
  cyclePeaks: BtcCyclePeak[];
  width?: number;
  height?: number;
}

function BtcQuantileChart({ series, cyclePeaks, width = 1180, height = 520 }: ChartProps) {
  const padL = 72;
  const padR = 18;
  const padT = 28;
  const padB = 36;
  const innerW = width - padL - padR;
  const innerH = height - padT - padB;

  if (series.length < 4) {
    return (
      <div
        style={{
          height,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "rgba(180,180,200,0.35)",
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 13,
        }}
      >
        no data — click Refresh to load
      </div>
    );
  }

  // ─── Coordinate helpers ──────────────────────────────────────────────────

  const allLogX = series.map((p) => logDays(p.time));
  const lxMin = allLogX[0];
  const lxMax = allLogX[allLogX.length - 1];
  const lxSpan = Math.max(0.001, lxMax - lxMin);

  const sx = (unixSec: number) =>
    padL + ((logDays(unixSec) - lxMin) / lxSpan) * innerW;

  // Y: log price. Collect all band values + actual prices for range.
  const allLogY: number[] = [];
  for (const p of series) {
    allLogY.push(Math.log(p.lower), Math.log(p.median), Math.log(p.upper));
    if (p.price != null && p.price > 0) allLogY.push(Math.log(p.price));
  }
  const lyMin = Math.min(...allLogY) - 0.15;
  const lyMax = Math.max(...allLogY) + 0.15;
  const lySpan = Math.max(0.001, lyMax - lyMin);

  const sy = (price: number) =>
    padT + (1 - (Math.log(price) - lyMin) / lySpan) * innerH;

  // ─── Path builders ────────────────────────────────────────────────────────

  function linePath(pts: Array<[number, number]>): string {
    return pts
      .map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`)
      .join(" ");
  }

  function bandPath(upper: Array<[number, number]>, lower: Array<[number, number]>): string {
    if (!upper.length) return "";
    const fwd = upper.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
    const rev = lower
      .slice()
      .reverse()
      .map(([x, y]) => `L${x.toFixed(1)},${y.toFixed(1)}`)
      .join(" ");
    return `${fwd} ${rev} Z`;
  }

  const historicalSeries = series.filter((p) => p.price != null);
  const nowSec = Math.floor(Date.now() / 1000);

  // Band curves — all points (historical + projection)
  const lowerPts: Array<[number, number]> = series.map((p) => [sx(p.time), sy(p.lower)]);
  const medianPts: Array<[number, number]> = series.map((p) => [sx(p.time), sy(p.median)]);
  const upperPts: Array<[number, number]> = series.map((p) => [sx(p.time), sy(p.upper)]);

  // Price line — historical only
  const pricePts: Array<[number, number]> = historicalSeries.map((p) => [
    sx(p.time),
    sy(p.price as number),
  ]);

  // Area fills
  const upperAreaPath = bandPath(upperPts, medianPts);
  const lowerAreaPath = bandPath(medianPts, lowerPts);

  // ─── Year ticks ──────────────────────────────────────────────────────────

  const yearStart = new Date(series[0].time * 1000).getUTCFullYear();
  const yearEnd = new Date(series[series.length - 1].time * 1000).getUTCFullYear() + 1;
  const yearStep = yearEnd - yearStart > 12 ? 2 : 1;
  const yearTicks: number[] = [];
  for (let y = Math.ceil(yearStart / yearStep) * yearStep; y <= yearEnd; y += yearStep) {
    yearTicks.push(y);
  }
  const yearSec = (y: number) =>
    Math.floor(new Date(`${y}-01-01T00:00:00Z`).getTime() / 1000);

  // ─── Y axis price levels ─────────────────────────────────────────────────

  const visibleLevels = PRICE_LEVELS.filter((p) => {
    const ly = Math.log(p);
    return ly >= lyMin && ly <= lyMax;
  });

  // ─── Today screen X ──────────────────────────────────────────────────────

  const nowX = sx(nowSec);
  const lastHistX = sx(historicalSeries[historicalSeries.length - 1]?.time ?? nowSec);

  return (
    <svg
      width="100%"
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      style={{ display: "block" }}
      data-testid="btc-quantile-chart"
    >
      {/* Projection zone shading */}
      {lastHistX < width - padR && (
        <rect
          x={lastHistX}
          y={padT}
          width={width - padR - lastHistX}
          height={innerH}
          fill="rgba(180,180,200,0.025)"
        />
      )}

      {/* Y axis price grid lines */}
      {visibleLevels.map((p) => {
        const yPos = sy(p);
        const label =
          p >= 1_000_000
            ? `$${p / 1_000_000}M`
            : p >= 1_000
            ? `$${p / 1_000}K`
            : `$${p}`;
        return (
          <g key={p}>
            <line
              x1={padL}
              x2={width - padR}
              y1={yPos}
              y2={yPos}
              stroke="rgba(247,147,26,0.06)"
              strokeWidth={0.6}
              strokeDasharray="3 5"
            />
            <text
              x={padL - 7}
              y={yPos + 3.5}
              textAnchor="end"
              fontSize={10}
              fontFamily="'JetBrains Mono', monospace"
              fill="rgba(247,147,26,0.6)"
            >
              {label}
            </text>
          </g>
        );
      })}

      {/* X axis year ticks */}
      {yearTicks.map((yr) => {
        const xPos = sx(yearSec(yr));
        if (xPos < padL || xPos > width - padR) return null;
        return (
          <g key={yr}>
            <line
              x1={xPos}
              x2={xPos}
              y1={padT}
              y2={padT + innerH}
              stroke="rgba(180,180,200,0.05)"
              strokeWidth={0.6}
            />
            <text
              x={xPos}
              y={height - 10}
              textAnchor="middle"
              fontSize={10}
              fontFamily="'JetBrains Mono', monospace"
              fill="rgba(180,180,200,0.5)"
            >
              {yr}
            </text>
          </g>
        );
      })}

      {/* Shaded areas between bands */}
      <path d={upperAreaPath} fill="rgba(239,100,100,0.08)" />
      <path d={lowerAreaPath} fill="rgba(52,211,153,0.06)" />

      {/* Band curves */}
      <path
        d={linePath(upperPts)}
        fill="none"
        stroke="rgba(239,100,100,0.65)"
        strokeWidth={1.25}
        strokeDasharray="5 4"
      />
      <path
        d={linePath(medianPts)}
        fill="none"
        stroke="rgba(180,180,200,0.4)"
        strokeWidth={1}
        strokeDasharray="3 4"
      />
      <path
        d={linePath(lowerPts)}
        fill="none"
        stroke="rgba(52,211,153,0.65)"
        strokeWidth={1.25}
        strokeDasharray="5 4"
      />

      {/* BTC price line */}
      <path
        d={linePath(pricePts)}
        fill="none"
        stroke="rgba(247,147,26,0.9)"
        strokeWidth={1.6}
      />

      {/* "Today" marker */}
      {nowX > padL && nowX < width - padR && (
        <g>
          <line
            x1={nowX}
            x2={nowX}
            y1={padT}
            y2={padT + innerH}
            stroke="rgba(220,225,235,0.2)"
            strokeWidth={0.75}
            strokeDasharray="3 3"
          />
          <text
            x={nowX + 4}
            y={padT + 12}
            fontSize={9}
            fontFamily="'JetBrains Mono', monospace"
            fill="rgba(220,225,235,0.35)"
          >
            today
          </text>
        </g>
      )}

      {/* Cycle peak markers */}
      {cyclePeaks.map((peak) => {
        const xPos = sx(peak.time);
        if (xPos < padL || xPos > width - padR) return null;
        const yPeakPrice = sy(peak.price);
        return (
          <g key={peak.label}>
            <line
              x1={xPos}
              x2={xPos}
              y1={padT}
              y2={padT + innerH}
              stroke="rgba(220,225,235,0.15)"
              strokeWidth={0.75}
              strokeDasharray="2 3"
            />
            {/* Diamond at peak price */}
            <polygon
              points={`${xPos},${yPeakPrice - 5} ${xPos + 4},${yPeakPrice} ${xPos},${yPeakPrice + 5} ${xPos - 4},${yPeakPrice}`}
              fill="rgba(247,147,26,0.8)"
            />
            <text
              x={xPos + 6}
              y={yPeakPrice - 8}
              fontSize={9}
              fontFamily="'JetBrains Mono', monospace"
              fill="rgba(247,147,26,0.75)"
            >
              {peak.label}
            </text>
            <text
              x={xPos + 6}
              y={yPeakPrice + 4}
              fontSize={8.5}
              fontFamily="'JetBrains Mono', monospace"
              fill="rgba(180,180,200,0.5)"
            >
              {(peak.pctOfUpper * 100).toFixed(0)}% of upper
            </text>
          </g>
        );
      })}

      {/* Legend */}
      <g>
        {[
          { label: "q=0.90 (upper)", color: "rgba(239,100,100,0.8)", dash: "5 4" },
          { label: "q=0.50 (median)", color: "rgba(180,180,200,0.5)", dash: "3 4" },
          { label: "q=0.10 (lower)", color: "rgba(52,211,153,0.8)", dash: "5 4" },
          { label: "BTC price", color: "rgba(247,147,26,0.9)", dash: "" },
        ].map((item, i) => (
          <g key={item.label} transform={`translate(${padL + 12 + i * 148}, ${padT + 10})`}>
            <line
              x1={0}
              x2={18}
              y1={5}
              y2={5}
              stroke={item.color}
              strokeWidth={item.dash ? 1.2 : 1.6}
              strokeDasharray={item.dash || undefined}
            />
            <text
              x={22}
              y={8.5}
              fontSize={9}
              fontFamily="'JetBrains Mono', monospace"
              fill="rgba(180,180,200,0.6)"
            >
              {item.label}
            </text>
          </g>
        ))}
      </g>
    </svg>
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
