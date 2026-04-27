import { useCallback, useMemo } from "react";
import { useGetCyclical, useRefreshCyclical } from "@workspace/api-client-react";
import type {
  CyclicalPayload,
  CyclicalComponent,
  CyclicalGrowthPoint,
  NberRecessionInterval,
  CyclicalQuarterEntry,
} from "@workspace/api-client-react";
import TopBar from "@/components/TopBar";
import { useToast } from "@/hooks/use-toast";

// ─── Status colors ────────────────────────────────────────────────────────────

const STATUS_COLORS: Record<
  string,
  { fg: string; bg: string; border: string; dot: string; soft: string }
> = {
  strong: {
    fg: "rgba(180,210,200,0.95)",
    bg: "hsl(160 30% 12% / 0.5)",
    border: "rgba(80,180,140,0.45)",
    dot: "#10B981",
    soft: "rgba(16,185,129,0.14)",
  },
  expansion: {
    fg: "rgba(200,220,200,0.95)",
    bg: "hsl(150 20% 12% / 0.5)",
    border: "rgba(120,180,120,0.35)",
    dot: "#84CC16",
    soft: "rgba(132,204,22,0.12)",
  },
  decelerating: {
    fg: "rgba(255,210,140,0.95)",
    bg: "hsl(35 60% 12% / 0.55)",
    border: "rgba(245,160,40,0.45)",
    dot: "#F59E0B",
    soft: "rgba(245,158,11,0.14)",
  },
  contraction: {
    fg: "rgba(255,170,170,0.95)",
    bg: "hsl(0 50% 14% / 0.55)",
    border: "rgba(239,80,80,0.55)",
    dot: "#EF4444",
    soft: "rgba(239,68,68,0.16)",
  },
  insufficient: {
    fg: "rgba(180,180,200,0.85)",
    bg: "hsl(230 14% 11% / 0.5)",
    border: "rgba(140,140,160,0.35)",
    dot: "#94A3B8",
    soft: "rgba(148,163,184,0.12)",
  },
};

// ─── Formatters ───────────────────────────────────────────────────────────────

function fmtPct(n: number | null | undefined, digits = 1): string {
  if (n == null || !isFinite(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(digits)}%`;
}

function fmtNum(n: number | null | undefined, digits = 0): string {
  if (n == null || !isFinite(n)) return "—";
  return n.toLocaleString("en-US", {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  });
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

function quarterLabel(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  const q = Math.floor(d.getUTCMonth() / 3) + 1;
  return `${d.getUTCFullYear()} Q${q}`;
}

// ─── Components table ─────────────────────────────────────────────────────────

function ComponentRow({ c }: { c: CyclicalComponent }) {
  const cellStyle: React.CSSProperties = {
    padding: "12px 14px",
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 13,
    color: "rgba(220,225,235,0.9)",
    borderBottom: "1px solid hsl(230 10% 14%)",
    whiteSpace: "nowrap",
  };
  const numCell: React.CSSProperties = { ...cellStyle, textAlign: "right" };
  const negColor = "rgba(255,170,170,0.95)";
  const posColor = "rgba(180,220,200,0.95)";
  const colorFor = (n: number | null | undefined) =>
    n == null ? cellStyle.color : n < 0 ? negColor : posColor;

  return (
    <tr data-testid={`cyclical-component-${c.id}`}>
      <td
        style={{
          ...cellStyle,
          fontFamily: "'Inter', sans-serif",
          fontSize: 14,
          fontWeight: 600,
          color: "rgba(230,235,245,0.98)",
          letterSpacing: "-0.01em",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span>{c.label}</span>
          <span
            style={{
              color: "rgba(180,180,200,0.4)",
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 11,
              fontWeight: 500,
            }}
          >
            {c.series}
          </span>
        </div>
      </td>
      <td style={numCell}>
        {c.latestLevel != null ? `$${fmtNum(c.latestLevel, 0)}B` : "—"}
      </td>
      <td style={numCell}>{c.shareOfGdpPct != null ? fmtPct(c.shareOfGdpPct, 1) : "—"}</td>
      <td style={{ ...numCell, color: colorFor(c.qoqAnnPct), fontWeight: 600 }}>
        {fmtPct(c.qoqAnnPct)}
      </td>
      <td style={{ ...numCell, color: colorFor(c.yoyPct), fontWeight: 600 }}>
        {fmtPct(c.yoyPct)}
      </td>
      <td style={numCell}>{fmtPct(c.contractionPctSince1956, 1)}</td>
    </tr>
  );
}

// ─── Recent sequence chips ────────────────────────────────────────────────────

function SequenceChips({ seq }: { seq: CyclicalQuarterEntry[] }) {
  if (seq.length === 0) return null;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
      {seq.map((q, i) => {
        const v = q.value;
        const negative = v != null && v < 0;
        const dim = v != null && v >= 0 && v < 2;
        return (
          <div key={q.time} style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div
              data-testid={`cyclical-seq-${i}`}
              style={{
                padding: "8px 12px",
                borderRadius: 8,
                background: negative
                  ? "hsl(0 50% 14% / 0.55)"
                  : dim
                  ? "hsl(35 50% 12% / 0.55)"
                  : "hsl(150 25% 12% / 0.5)",
                border: `1px solid ${
                  negative
                    ? "rgba(239,80,80,0.5)"
                    : dim
                    ? "rgba(245,158,11,0.4)"
                    : "rgba(120,180,120,0.35)"
                }`,
                fontFamily: "'JetBrains Mono', monospace",
                minWidth: 100,
              }}
            >
              <div
                style={{
                  fontSize: 10,
                  letterSpacing: "0.08em",
                  color: "rgba(180,180,200,0.55)",
                  textTransform: "uppercase",
                }}
              >
                {q.quarterLabel}
              </div>
              <div
                style={{
                  fontSize: 18,
                  fontWeight: 700,
                  marginTop: 2,
                  color: negative
                    ? "rgba(255,170,170,0.95)"
                    : dim
                    ? "rgba(255,210,140,0.95)"
                    : "rgba(190,220,200,0.98)",
                }}
              >
                {fmtPct(v, 1)}
              </div>
            </div>
            {i < seq.length - 1 && (
              <span style={{ color: "rgba(180,180,200,0.35)", fontSize: 18 }}>→</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Historical chart (bars + MA4 line + NBER shading) ───────────────────────

interface ChartProps {
  history: CyclicalGrowthPoint[];
  ma4: CyclicalGrowthPoint[];
  recessions: NberRecessionInterval[];
  width?: number;
  height?: number;
}

function CyclicalChart({
  history,
  ma4,
  recessions,
  width = 1180,
  height = 360,
}: ChartProps) {
  if (history.length < 2) {
    return (
      <div
        style={{
          height,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "rgba(180,180,200,0.4)",
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 12,
        }}
      >
        no historical data
      </div>
    );
  }

  // Chart area
  const padL = 56;
  const padR = 16;
  const padT = 20;
  const padB = 28;
  const innerW = width - padL - padR;
  const innerH = height - padT - padB;

  const t0 = history[0].time;
  const t1 = history[history.length - 1].time;
  const span = Math.max(1, t1 - t0);
  const x = (t: number) => padL + ((t - t0) / span) * innerW;

  const values = history.map((p) => p.value);
  // Symmetric-ish y range with reasonable clipping for outlier crisis prints.
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const yMin = Math.max(-50, Math.min(-15, Math.floor(rawMin / 5) * 5));
  const yMax = Math.min(50, Math.max(15, Math.ceil(rawMax / 5) * 5));
  const y = (v: number) => {
    const clamped = Math.max(yMin, Math.min(yMax, v));
    return padT + (1 - (clamped - yMin) / (yMax - yMin)) * innerH;
  };
  const yZero = y(0);

  // Approx pixel width of one quarter for bar sizing (3 months apart).
  const quarterPx = innerW / Math.max(1, history.length - 1);
  const barW = Math.max(1.5, quarterPx * 0.85);

  // Y-axis grid at 0, ±5, ±10, ±15...
  const gridLines: number[] = [];
  for (let v = 0; v <= yMax; v += 5) gridLines.push(v);
  for (let v = -5; v >= yMin; v -= 5) gridLines.push(v);

  // MA4 path
  const ma4Path = ma4
    .map((p, i) => `${i === 0 ? "M" : "L"}${x(p.time).toFixed(1)},${y(p.value).toFixed(1)}`)
    .join(" ");

  // Year ticks every 10 years
  const yearTicks: number[] = [];
  const startYear = Math.ceil(new Date(t0 * 1000).getUTCFullYear() / 10) * 10;
  const endYear = new Date(t1 * 1000).getUTCFullYear();
  for (let y0 = startYear; y0 <= endYear; y0 += 10) yearTicks.push(y0);

  const tickX = (year: number) =>
    x(Math.floor(new Date(`${year}-01-01T00:00:00Z`).getTime() / 1000));

  return (
    <svg
      width="100%"
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      style={{ display: "block" }}
      data-testid="cyclical-chart"
    >
      {/* Recession shading */}
      {recessions.map((r, i) => {
        const x1 = Math.max(padL, x(r.start));
        const x2 = Math.min(width - padR, x(r.end));
        if (x2 <= padL || x1 >= width - padR) return null;
        return (
          <rect
            key={i}
            x={x1}
            y={padT}
            width={Math.max(1, x2 - x1)}
            height={innerH}
            fill="rgba(180,180,200,0.06)"
          />
        );
      })}

      {/* Y grid */}
      {gridLines.map((v) => (
        <g key={v}>
          <line
            x1={padL}
            x2={width - padR}
            y1={y(v)}
            y2={y(v)}
            stroke={v === 0 ? "rgba(180,180,200,0.35)" : "rgba(180,180,200,0.08)"}
            strokeWidth={v === 0 ? 1 : 0.75}
            strokeDasharray={v === 0 ? "" : "2 4"}
          />
          <text
            x={padL - 8}
            y={y(v) + 3}
            textAnchor="end"
            fontSize={10}
            fontFamily="'JetBrains Mono', monospace"
            fill="rgba(180,180,200,0.5)"
          >
            {v > 0 ? `+${v}` : v}
          </text>
        </g>
      ))}

      {/* Bars */}
      {history.map((p) => {
        const cx = x(p.time);
        const cy = y(p.value);
        const top = Math.min(cy, yZero);
        const h = Math.abs(cy - yZero);
        const positive = p.value >= 0;
        return (
          <rect
            key={p.time}
            x={cx - barW / 2}
            y={top}
            width={barW}
            height={Math.max(0.5, h)}
            fill={positive ? "rgba(120,180,140,0.55)" : "rgba(239,100,100,0.7)"}
          />
        );
      })}

      {/* MA4 line */}
      {ma4.length > 1 && (
        <path
          d={ma4Path}
          fill="none"
          stroke="hsl(224 100% 72%)"
          strokeWidth={1.6}
          opacity={0.95}
        />
      )}

      {/* X axis ticks */}
      {yearTicks.map((yr) => (
        <text
          key={yr}
          x={tickX(yr)}
          y={height - 8}
          textAnchor="middle"
          fontSize={10}
          fontFamily="'JetBrains Mono', monospace"
          fill="rgba(180,180,200,0.5)"
        >
          {yr}
        </text>
      ))}

      {/* "You are here" callout for the last bar */}
      {(() => {
        const last = history[history.length - 1];
        const cx = x(last.time);
        const cy = y(last.value);
        const labelOnLeft = cx > width - 130;
        const lx = labelOnLeft ? cx - 12 : cx + 12;
        const lAnchor: "start" | "end" = labelOnLeft ? "end" : "start";
        return (
          <g>
            <circle
              cx={cx}
              cy={cy}
              r={4}
              fill="hsl(224 100% 72%)"
              stroke="hsl(230 14% 8%)"
              strokeWidth={1.5}
            />
            <text
              x={lx}
              y={cy - 8}
              textAnchor={lAnchor}
              fontSize={11}
              fontFamily="'JetBrains Mono', monospace"
              fill="rgba(220,230,255,0.95)"
              fontWeight={600}
            >
              {quarterLabel(last.time)} · {fmtPct(last.value, 1)}
            </text>
          </g>
        );
      })()}
    </svg>
  );
}

// ─── Contraction-frequency stats ──────────────────────────────────────────────

function ContractionStat({
  label,
  pct,
  highlight = false,
}: {
  label: string;
  pct: number | null;
  highlight?: boolean;
}) {
  return (
    <div
      style={{
        flex: 1,
        padding: 16,
        borderRadius: 10,
        background: highlight ? "hsl(0 35% 14% / 0.4)" : "hsl(230 12% 11% / 0.6)",
        border: `1px solid ${
          highlight ? "rgba(239,80,80,0.4)" : "hsl(230 10% 16%)"
        }`,
      }}
    >
      <div
        style={{
          fontSize: 10,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "rgba(180,180,200,0.55)",
          fontFamily: "'JetBrains Mono', monospace",
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 26,
          fontWeight: 700,
          fontFamily: "'JetBrains Mono', monospace",
          color: highlight ? "rgba(255,170,170,0.98)" : "rgba(220,225,235,0.98)",
          marginTop: 4,
        }}
      >
        {pct != null ? `${pct.toFixed(1)}%` : "—"}
      </div>
      <div
        style={{
          fontSize: 11,
          color: "rgba(180,180,200,0.55)",
          fontFamily: "'Inter', sans-serif",
          marginTop: 2,
        }}
      >
        of quarters with YoY contraction
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function CyclicalPage() {
  const { data, isLoading, error, refetch } = useGetCyclical();
  const refresh = useRefreshCyclical();
  const { toast } = useToast();

  const payload = data as CyclicalPayload | undefined;

  const onRefresh = useCallback(async () => {
    try {
      await refresh.mutateAsync();
      await refetch();
      toast({ title: "Cyclical GDP data refreshed" });
    } catch (err) {
      toast({
        title: "Refresh failed",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    }
  }, [refresh, refetch, toast]);

  const headlineColors = useMemo(() => {
    const status = payload?.status ?? "insufficient";
    return STATUS_COLORS[status] ?? STATUS_COLORS.insufficient;
  }, [payload?.status]);

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "hsl(230 14% 6%)",
        color: "rgba(220,225,235,0.9)",
        display: "flex",
        flexDirection: "column",
      }}
      data-testid="cyclical-page"
    >
      <TopBar
        lastUpdated={payload?.lastUpdated ?? null}
        isRefreshing={refresh.isPending}
        onRefresh={onRefresh}
      />

      {isLoading && (
        <div
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "rgba(180,180,200,0.5)",
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 13,
          }}
        >
          loading cyclical GDP data…
        </div>
      )}

      {error && (
        <div
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "rgba(255,170,170,0.9)",
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 13,
          }}
        >
          failed to load cyclical GDP data
        </div>
      )}

      {payload && (
        <div
          style={{
            padding: "20px 24px 32px",
            display: "flex",
            flexDirection: "column",
            gap: 20,
            maxWidth: 1280,
            width: "100%",
            margin: "0 auto",
          }}
        >
          {/* Headline card */}
          <section
            style={{
              padding: 20,
              borderRadius: 12,
              background: "hsl(230 14% 9%)",
              border: "1px solid hsl(230 10% 14%)",
              display: "flex",
              flexDirection: "column",
              gap: 16,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "flex-start",
                justifyContent: "space-between",
                gap: 24,
                flexWrap: "wrap",
              }}
            >
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <div
                  style={{
                    fontSize: 11,
                    letterSpacing: "0.1em",
                    textTransform: "uppercase",
                    color: "rgba(180,180,200,0.55)",
                    fontFamily: "'JetBrains Mono', monospace",
                  }}
                >
                  Cyclical GDP · {payload.latestQuarterLabel}
                </div>
                <div
                  style={{
                    fontSize: 28,
                    fontWeight: 700,
                    color: "rgba(230,235,245,0.98)",
                    letterSpacing: "-0.02em",
                    fontFamily: "'Inter', sans-serif",
                  }}
                  data-testid="cyclical-title"
                >
                  Durables + Residential Investment + Business Equipment
                </div>
                <div
                  style={{
                    fontSize: 13,
                    color: "rgba(180,180,200,0.65)",
                    maxWidth: 760,
                    lineHeight: 1.45,
                  }}
                >
                  The ~20% of GDP that's interest-rate sensitive and discretionary.
                  Stable services, government spending, and net exports are stripped
                  out — the cycle signal lives here.
                </div>
              </div>
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "flex-end",
                  gap: 8,
                  minWidth: 220,
                }}
              >
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "4px 10px",
                    borderRadius: 6,
                    background: headlineColors.soft,
                    border: `1px solid ${headlineColors.border}`,
                    color: headlineColors.fg,
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 11,
                    fontWeight: 700,
                    letterSpacing: "0.08em",
                    textTransform: "uppercase",
                  }}
                  data-testid="cyclical-status"
                >
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: "50%",
                      background: headlineColors.dot,
                    }}
                  />
                  {payload.statusLabel}
                </span>
                <div
                  style={{
                    fontSize: 48,
                    fontWeight: 700,
                    fontFamily: "'JetBrains Mono', monospace",
                    color: headlineColors.fg,
                    letterSpacing: "-0.02em",
                    lineHeight: 1,
                  }}
                  data-testid="cyclical-headline-pct"
                >
                  {fmtPct(payload.latestQoqAnnPct, 1)}
                </div>
                <div
                  style={{
                    fontSize: 11,
                    color: "rgba(180,180,200,0.55)",
                    fontFamily: "'JetBrains Mono', monospace",
                  }}
                >
                  QoQ ann · YoY {fmtPct(payload.latestYoyPct, 1)} · share of GDP{" "}
                  {payload.cyclicalSharePct != null
                    ? fmtPct(payload.cyclicalSharePct, 1)
                    : "—"}
                </div>
              </div>
            </div>

            <div
              style={{
                fontSize: 13,
                color: "rgba(220,225,235,0.85)",
                lineHeight: 1.5,
                padding: "10px 14px",
                background: "hsl(230 14% 7%)",
                border: "1px solid hsl(230 10% 14%)",
                borderRadius: 8,
              }}
              data-testid="cyclical-blurb"
            >
              {payload.statusBlurb}
            </div>

            {/* 4-quarter sequence */}
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div
                style={{
                  fontSize: 11,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  color: "rgba(180,180,200,0.55)",
                  fontFamily: "'JetBrains Mono', monospace",
                }}
              >
                Last 4 quarters · QoQ annualized growth
              </div>
              <SequenceChips seq={payload.recentSequence} />
            </div>
          </section>

          {/* Components table */}
          <section
            style={{
              padding: 0,
              borderRadius: 12,
              background: "hsl(230 14% 9%)",
              border: "1px solid hsl(230 10% 14%)",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                padding: "14px 18px",
                borderBottom: "1px solid hsl(230 10% 14%)",
                display: "flex",
                alignItems: "baseline",
                justifyContent: "space-between",
              }}
            >
              <div
                style={{
                  fontSize: 14,
                  fontWeight: 700,
                  color: "rgba(230,235,245,0.98)",
                  letterSpacing: "-0.01em",
                  fontFamily: "'Inter', sans-serif",
                }}
              >
                Components · {payload.latestQuarterLabel}
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: "rgba(180,180,200,0.55)",
                  fontFamily: "'JetBrains Mono', monospace",
                }}
              >
                Real, chained 2017 dollars · SAAR
              </div>
            </div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    {[
                      "Component",
                      "Latest level",
                      "% of GDP",
                      "QoQ ann",
                      "YoY",
                      "Contracted (since 1956)",
                    ].map((h, i) => (
                      <th
                        key={h}
                        style={{
                          padding: "10px 14px",
                          textAlign: i === 0 ? "left" : "right",
                          fontSize: 10,
                          letterSpacing: "0.08em",
                          textTransform: "uppercase",
                          color: "rgba(180,180,200,0.45)",
                          fontFamily: "'JetBrains Mono', monospace",
                          fontWeight: 600,
                          borderBottom: "1px solid hsl(230 10% 14%)",
                        }}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {payload.components.map((c) => (
                    <ComponentRow key={c.id} c={c} />
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* Contraction-frequency stats */}
          <section
            style={{
              padding: 18,
              borderRadius: 12,
              background: "hsl(230 14% 9%)",
              border: "1px solid hsl(230 10% 14%)",
              display: "flex",
              flexDirection: "column",
              gap: 14,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                justifyContent: "space-between",
              }}
            >
              <div
                style={{
                  fontSize: 14,
                  fontWeight: 700,
                  color: "rgba(230,235,245,0.98)",
                  letterSpacing: "-0.01em",
                  fontFamily: "'Inter', sans-serif",
                }}
              >
                Why this 20% matters · contraction frequency since{" "}
                {payload.contractionStats.sinceYear}
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: "rgba(180,180,200,0.55)",
                  fontFamily: "'JetBrains Mono', monospace",
                }}
              >
                {payload.contractionStats.quartersCounted} quarters · YoY basis
              </div>
            </div>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              <ContractionStat
                label="Cyclical GDP"
                pct={payload.contractionStats.cyclicalPct}
                highlight
              />
              <ContractionStat
                label="Total Real GDP"
                pct={payload.contractionStats.totalGdpPct}
              />
              <ContractionStat
                label="Non-cyclical GDP"
                pct={payload.contractionStats.nonCyclicalPct}
              />
            </div>
            <div
              style={{
                fontSize: 12,
                color: "rgba(180,180,200,0.65)",
                lineHeight: 1.5,
              }}
            >
              The non-cyclical 80% almost never contracts. By the time total GDP
              prints negative, the cyclical bucket has usually been contracting
              for several quarters — that's the signal hidden underneath a
              stable headline.
            </div>
          </section>

          {/* Historical chart */}
          <section
            style={{
              padding: 18,
              borderRadius: 12,
              background: "hsl(230 14% 9%)",
              border: "1px solid hsl(230 10% 14%)",
              display: "flex",
              flexDirection: "column",
              gap: 14,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                justifyContent: "space-between",
                gap: 12,
              }}
            >
              <div
                style={{
                  fontSize: 14,
                  fontWeight: 700,
                  color: "rgba(230,235,245,0.98)",
                  letterSpacing: "-0.01em",
                  fontFamily: "'Inter', sans-serif",
                }}
              >
                Cyclical GDP — QoQ annualized growth
              </div>
              <div
                style={{
                  display: "flex",
                  gap: 16,
                  fontSize: 11,
                  color: "rgba(180,180,200,0.65)",
                  fontFamily: "'JetBrains Mono', monospace",
                  flexWrap: "wrap",
                }}
              >
                <span>
                  <span
                    style={{
                      display: "inline-block",
                      width: 10,
                      height: 10,
                      background: "rgba(120,180,140,0.55)",
                      marginRight: 6,
                      verticalAlign: "middle",
                    }}
                  />
                  expansion
                </span>
                <span>
                  <span
                    style={{
                      display: "inline-block",
                      width: 10,
                      height: 10,
                      background: "rgba(239,100,100,0.7)",
                      marginRight: 6,
                      verticalAlign: "middle",
                    }}
                  />
                  contraction
                </span>
                <span>
                  <span
                    style={{
                      display: "inline-block",
                      width: 14,
                      height: 2,
                      background: "hsl(224 100% 72%)",
                      marginRight: 6,
                      verticalAlign: "middle",
                    }}
                  />
                  4Q avg
                </span>
                <span>
                  <span
                    style={{
                      display: "inline-block",
                      width: 10,
                      height: 10,
                      background: "rgba(180,180,200,0.06)",
                      border: "1px solid rgba(180,180,200,0.15)",
                      marginRight: 6,
                      verticalAlign: "middle",
                    }}
                  />
                  NBER recession
                </span>
              </div>
            </div>
            <CyclicalChart
              history={payload.cyclicalGrowthHistory}
              ma4={payload.cyclicalMa4History}
              recessions={payload.nberRecessions}
            />
          </section>

          {/* Notes */}
          {payload.notes.length > 0 && (
            <section
              style={{
                padding: 14,
                borderRadius: 10,
                background: "hsl(35 30% 10% / 0.5)",
                border: "1px solid rgba(245,158,11,0.25)",
                fontSize: 12,
                color: "rgba(255,210,140,0.9)",
                fontFamily: "'JetBrains Mono', monospace",
              }}
            >
              {payload.notes.map((n, i) => (
                <div key={i}>• {n}</div>
              ))}
            </section>
          )}

          <div
            style={{
              fontSize: 10,
              color: "rgba(180,180,200,0.4)",
              fontFamily: "'JetBrains Mono', monospace",
              textAlign: "right",
            }}
          >
            Data: FRED (BEA NIPA series) ·{" "}
            {payload.lastUpdated ? `updated ${fmtTimestamp(payload.lastUpdated)}` : ""}
          </div>
        </div>
      )}
    </div>
  );
}
