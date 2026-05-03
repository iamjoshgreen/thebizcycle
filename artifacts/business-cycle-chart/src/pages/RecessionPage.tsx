import { useCallback, useMemo } from "react";
import { useGetRecession, useRefreshRecession } from "@workspace/api-client-react";
import type {
  RecessionPayload,
  SectorStats,
  MonthlyPoint,
  NberRecessionInterval,
} from "@workspace/api-client-react";
import TopBar from "@/components/TopBar";
import { useToast } from "@/hooks/use-toast";

// ─── Status colors ────────────────────────────────────────────────────────────

const STATUS_COLORS: Record<
  string,
  { fg: string; bg: string; border: string; dot: string; soft: string }
> = {
  expansion: {
    fg: "rgba(180,210,200,0.95)",
    bg: "hsl(160 30% 12% / 0.5)",
    border: "rgba(80,180,140,0.35)",
    dot: "#10B981",
    soft: "rgba(16,185,129,0.12)",
  },
  warning: {
    fg: "rgba(255,210,140,0.95)",
    bg: "hsl(35 60% 12% / 0.55)",
    border: "rgba(245,160,40,0.45)",
    dot: "#F59E0B",
    soft: "rgba(245,158,11,0.12)",
  },
  signal: {
    fg: "rgba(255,170,170,0.95)",
    bg: "hsl(0 50% 14% / 0.55)",
    border: "rgba(239,80,80,0.55)",
    dot: "#EF4444",
    soft: "rgba(239,68,68,0.14)",
  },
  insufficient: {
    fg: "rgba(180,180,200,0.85)",
    bg: "hsl(230 14% 11% / 0.5)",
    border: "rgba(140,140,160,0.35)",
    dot: "#94A3B8",
    soft: "rgba(148,163,184,0.12)",
  },
};

const STATUS_LABEL: Record<string, string> = {
  expansion: "OK",
  warning: "WARN",
  signal: "RED",
  insufficient: "—",
};

// ─── Formatters ───────────────────────────────────────────────────────────────

function fmtMonth(ts: number | null | undefined): string {
  if (ts == null) return "—";
  return new Date(ts * 1000).toLocaleDateString("en-US", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

function fmtNum(n: number | null | undefined, digits = 1): string {
  if (n == null || !isFinite(n)) return "—";
  return n.toLocaleString("en-US", {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  });
}

function fmtPct(n: number | null | undefined, digits = 1): string {
  if (n == null || !isFinite(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(digits)}%`;
}

// ─── Detail table ─────────────────────────────────────────────────────────────

function SectorRow({ s }: { s: SectorStats }) {
  const c = STATUS_COLORS[s.status] ?? STATUS_COLORS.insufficient;
  const cellStyle: React.CSSProperties = {
    padding: "12px 14px",
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 13,
    color: "rgba(220,225,235,0.9)",
    borderBottom: "1px solid hsl(230 10% 14%)",
    whiteSpace: "nowrap",
  };
  const numCellStyle: React.CSSProperties = { ...cellStyle, textAlign: "right" };

  return (
    <tr data-testid={`sector-row-${s.id}`}>
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
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "2px 8px",
              borderRadius: 4,
              background: c.soft,
              border: `1px solid ${c.border}`,
              color: c.fg,
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: "0.08em",
            }}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: c.dot,
                display: "inline-block",
              }}
            />
            {STATUS_LABEL[s.status]}
          </span>
          <span>{s.label}</span>
          <span
            style={{
              color: "rgba(180,180,200,0.4)",
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 11,
              fontWeight: 500,
            }}
          >
            {s.role === "leader" ? "leader" : "confirm"}
          </span>
        </div>
      </td>
      <td style={numCellStyle}>{fmtNum(s.current, 0)}</td>
      <td style={numCellStyle}>
        <div>{fmtNum(s.peakValue, 0)}</div>
        <div style={{ color: "rgba(180,180,200,0.45)", fontSize: 11, marginTop: 2 }}>
          {fmtMonth(s.peakDate)}
        </div>
      </td>
      <td style={{ ...numCellStyle, color: c.fg, fontWeight: 600 }}>{fmtPct(s.pctOffPeak)}</td>
      <td style={numCellStyle}>{s.monthsSincePeak ?? "—"}</td>
      <td
        style={{
          ...numCellStyle,
          color: s.yoyPct != null && s.yoyPct < 0 ? "rgba(255,170,170,0.95)" : numCellStyle.color,
        }}
      >
        {fmtPct(s.yoyPct)}
      </td>
      <td
        style={{
          ...numCellStyle,
          color: s.ann3mPct != null && s.ann3mPct < 0 ? "rgba(255,170,170,0.95)" : numCellStyle.color,
        }}
      >
        {fmtPct(s.ann3mPct)}
      </td>
    </tr>
  );
}

// ─── Historical CJI chart ─────────────────────────────────────────────────────

interface CjiChartProps {
  history: MonthlyPoint[];
  recessions: NberRecessionInterval[];
  width?: number;
  height?: number;
}

// "You are here" callout positioned to avoid clipping at the right edge.
function CjiChart({ history, recessions, width = 1200, height = 320 }: CjiChartProps) {
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

  const padL = 56;
  const padR = 16;
  const padT = 14;
  const padB = 28;

  const xMin = history[0].time;
  const xMax = history[history.length - 1].time;
  const xRange = xMax - xMin || 1;

  // Y: clamp range to [-12, +1] for readability; expand if data goes lower.
  const yDataMin = Math.min(...history.map((p) => p.value));
  const yMin = Math.min(-12, Math.floor(yDataMin / 2) * 2);
  const yMax = 1;
  const yRange = yMax - yMin;

  const x = (t: number) => padL + ((t - xMin) / xRange) * (width - padL - padR);
  const y = (v: number) => padT + ((yMax - v) / yRange) * (height - padT - padB);

  const linePath = history
    .map((p, i) => `${i === 0 ? "M" : "L"} ${x(p.time).toFixed(2)} ${y(p.value).toFixed(2)}`)
    .join(" ");

  // Bands: 0 to -0.5 green, -0.5 to -1.5 yellow, -1.5 to yMin red
  const bands = [
    { from: 0, to: -0.5, color: "rgba(16,185,129,0.10)" },
    { from: -0.5, to: -1.5, color: "rgba(245,158,11,0.10)" },
    { from: -1.5, to: yMin, color: "rgba(239,68,68,0.10)" },
  ];

  // Y-axis ticks
  const yTicks: number[] = [];
  for (let v = 0; v >= yMin; v -= 2) yTicks.push(v);

  // X-axis: decade ticks
  const startYear = new Date(xMin * 1000).getUTCFullYear();
  const endYear = new Date(xMax * 1000).getUTCFullYear();
  const xTicks: { x: number; label: string }[] = [];
  for (let yr = Math.ceil(startYear / 5) * 5; yr <= endYear; yr += 5) {
    const ts = Math.floor(Date.UTC(yr, 0, 1) / 1000);
    if (ts < xMin || ts > xMax) continue;
    xTicks.push({ x: x(ts), label: String(yr) });
  }

  const last = history[history.length - 1];
  const currentColor =
    last.value >= -0.5
      ? STATUS_COLORS.expansion.dot
      : last.value >= -1.5
        ? STATUS_COLORS.warning.dot
        : STATUS_COLORS.signal.dot;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      style={{ display: "block", width: "100%", height }}
    >
      {/* Bands */}
      {bands.map((b, i) => {
        const yTop = y(b.from);
        const yBot = y(b.to);
        return (
          <rect
            key={i}
            x={padL}
            y={Math.min(yTop, yBot)}
            width={width - padL - padR}
            height={Math.abs(yBot - yTop)}
            fill={b.color}
          />
        );
      })}

      {/* NBER recession shading */}
      {recessions.map((r, i) => {
        if (r.end < xMin || r.start > xMax) return null;
        const x1 = x(Math.max(r.start, xMin));
        const x2 = x(Math.min(r.end, xMax));
        return (
          <rect
            key={i}
            x={x1}
            y={padT}
            width={Math.max(2, x2 - x1)}
            height={height - padT - padB}
            fill="rgba(180,180,200,0.13)"
          />
        );
      })}

      {/* Y-axis grid + labels */}
      {yTicks.map((v) => (
        <g key={v}>
          <line
            x1={padL}
            x2={width - padR}
            y1={y(v)}
            y2={y(v)}
            stroke="rgba(255,255,255,0.04)"
            strokeWidth={1}
          />
          <text
            x={padL - 8}
            y={y(v) + 3}
            textAnchor="end"
            fill="rgba(180,180,200,0.5)"
            fontFamily="'JetBrains Mono', monospace"
            fontSize={10}
          >
            {v === 0 ? "0%" : `${v}%`}
          </text>
        </g>
      ))}

      {/* X-axis tick labels */}
      {xTicks.map((t) => (
        <g key={t.label}>
          <line
            x1={t.x}
            x2={t.x}
            y1={padT}
            y2={height - padB}
            stroke="rgba(255,255,255,0.025)"
            strokeWidth={1}
          />
          <text
            x={t.x}
            y={height - padB + 14}
            textAnchor="middle"
            fill="rgba(180,180,200,0.5)"
            fontFamily="'JetBrains Mono', monospace"
            fontSize={10}
          >
            {t.label}
          </text>
        </g>
      ))}

      {/* Threshold lines */}
      <line
        x1={padL}
        x2={width - padR}
        y1={y(-0.5)}
        y2={y(-0.5)}
        stroke="rgba(245,158,11,0.4)"
        strokeWidth={1}
        strokeDasharray="3 3"
      />
      <line
        x1={padL}
        x2={width - padR}
        y1={y(-1.5)}
        y2={y(-1.5)}
        stroke="rgba(239,68,68,0.45)"
        strokeWidth={1}
        strokeDasharray="3 3"
      />

      {/* CJI line */}
      <path
        d={linePath}
        fill="none"
        stroke="rgba(230,235,245,0.92)"
        strokeWidth={1.4}
        strokeLinejoin="round"
        strokeLinecap="round"
      />

      {/* Current dot — outer halo + solid center for visibility */}
      <circle
        cx={x(last.time)}
        cy={y(last.value)}
        r={7}
        fill={currentColor}
        opacity={0.22}
      />
      <circle cx={x(last.time)} cy={y(last.value)} r={3.5} fill={currentColor} />

      {/* "You are here" callout — line + label, anchored to the right side
          of the dot but flipped to the left if too close to the right edge.
          We compute the actual rect bounds first, then test against the chart
          inset bounds (and clamp on the opposite side as a safety net) so the
          label can never clip on either edge. */}
      {(() => {
        const dotX = x(last.time);
        const dotY = y(last.value);
        const labelText = `${last.value > 0 ? "+" : ""}${last.value.toFixed(2)}% today`;
        // Approximate width: ~6.6px per char in an 11px monospace font, plus
        // 14px of internal padding for the rounded rect.
        const labelW = labelText.length * 6.6 + 14;
        // When NOT flipped, the rect's right edge is dotX + 20 + labelW
        // (lineX2 = dotX+18, textX = lineX2+6, rectX = textX-4 = dotX+20).
        // When flipped, the rect's left edge is dotX - 24 - labelW.
        const wouldOverflowRight = dotX + 20 + labelW > width - padR;
        const flushRight = wouldOverflowRight;
        const lineX2 = flushRight ? dotX - 18 : dotX + 18;
        // Compute rect position then clamp into the inset chart area so it
        // can never escape on either side, even on extreme dot positions.
        const rawRectX = flushRight ? lineX2 - 6 - labelW : lineX2 + 6 - 4;
        const rectX = Math.max(padL, Math.min(width - padR - labelW, rawRectX));
        // Re-derive textX from the (possibly clamped) rectX so the text stays
        // aligned inside the rect regardless of clamping. textAnchor=start
        // grows rightward from textX; textAnchor=end grows leftward from textX.
        const textX = flushRight ? rectX + labelW - 6 : rectX + 4;
        // Push the label up a bit so it doesn't sit on the line itself,
        // but keep it inside the top inset so it can't clip vertically.
        const lineY2 = Math.max(padT + 12, dotY - 18);
        const textY = lineY2 + 4;
        return (
          <g>
            <line
              x1={dotX}
              y1={dotY}
              x2={lineX2}
              y2={lineY2}
              stroke={currentColor}
              strokeWidth={1}
              opacity={0.7}
            />
            <rect
              x={rectX}
              y={lineY2 - 9}
              width={labelW}
              height={18}
              rx={3}
              fill="rgba(15,15,20,0.92)"
              stroke={currentColor}
              strokeWidth={1}
              opacity={0.95}
            />
            <text
              x={textX}
              y={textY}
              textAnchor={flushRight ? "end" : "start"}
              fill={currentColor}
              fontFamily="'JetBrains Mono', monospace"
              fontSize={11}
              fontWeight={700}
            >
              {labelText}
            </text>
          </g>
        );
      })()}
    </svg>
  );
}

// ─── PAYEMS YoY context chart ─────────────────────────────────────────────────

interface PayemsChartProps {
  data: MonthlyPoint[];
  recessions: NberRecessionInterval[];
  width?: number;
  height?: number;
}

function PayemsChart({ data, recessions, width = 1200, height = 130 }: PayemsChartProps) {
  if (data.length < 2) {
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
        no PAYEMS data
      </div>
    );
  }

  const padL = 56;
  const padR = 16;
  const padT = 12;
  const padB = 22;

  const xMin = data[0].time;
  const xMax = data[data.length - 1].time;
  const xRange = xMax - xMin || 1;

  const yDataMin = Math.min(...data.map((p) => p.value));
  const yDataMax = Math.max(...data.map((p) => p.value));
  const yMin = Math.min(-6, Math.floor(yDataMin));
  const yMax = Math.max(5, Math.ceil(yDataMax));
  const yRange = yMax - yMin || 1;

  const x = (t: number) => padL + ((t - xMin) / xRange) * (width - padL - padR);
  const y = (v: number) => padT + ((yMax - v) / yRange) * (height - padT - padB);

  const linePath = data
    .map((p, i) => `${i === 0 ? "M" : "L"} ${x(p.time).toFixed(2)} ${y(p.value).toFixed(2)}`)
    .join(" ");

  const last = data[data.length - 1];

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      style={{ display: "block", width: "100%", height }}
    >
      {/* NBER shading */}
      {recessions.map((r, i) => {
        if (r.end < xMin || r.start > xMax) return null;
        const x1 = x(Math.max(r.start, xMin));
        const x2 = x(Math.min(r.end, xMax));
        return (
          <rect
            key={i}
            x={x1}
            y={padT}
            width={Math.max(2, x2 - x1)}
            height={height - padT - padB}
            fill="rgba(180,180,200,0.13)"
          />
        );
      })}

      {/* Zero line */}
      <line
        x1={padL}
        x2={width - padR}
        y1={y(0)}
        y2={y(0)}
        stroke="rgba(255,255,255,0.12)"
        strokeWidth={1}
      />
      <text
        x={padL - 8}
        y={y(0) + 3}
        textAnchor="end"
        fill="rgba(180,180,200,0.5)"
        fontFamily="'JetBrains Mono', monospace"
        fontSize={10}
      >
        0%
      </text>
      <text
        x={padL - 8}
        y={y(yMax) + 3}
        textAnchor="end"
        fill="rgba(180,180,200,0.5)"
        fontFamily="'JetBrains Mono', monospace"
        fontSize={10}
      >
        {yMax}%
      </text>
      <text
        x={padL - 8}
        y={y(yMin) + 3}
        textAnchor="end"
        fill="rgba(180,180,200,0.5)"
        fontFamily="'JetBrains Mono', monospace"
        fontSize={10}
      >
        {yMin}%
      </text>

      {/* Line */}
      <path
        d={linePath}
        fill="none"
        stroke="rgba(96,165,250,0.85)"
        strokeWidth={1.3}
        strokeLinejoin="round"
        strokeLinecap="round"
      />

      {/* Current dot */}
      <circle cx={x(last.time)} cy={y(last.value)} r={3} fill="rgba(96,165,250,1)" />
    </svg>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function RecessionPage() {
  const { toast } = useToast();
  const { data, isLoading } = useGetRecession();
  const refreshMutation = useRefreshRecession();

  const handleRefresh = useCallback(() => {
    refreshMutation.mutate(undefined, {
      onError: () =>
        toast({
          title: "Refresh failed",
          description: "Showing cached data",
          variant: "destructive",
        }),
    });
  }, [refreshMutation, toast]);

  const payload: RecessionPayload | undefined = refreshMutation.data ?? data;
  const lastUpdated = payload?.lastUpdated ?? null;

  const headlineColors = useMemo(
    () => STATUS_COLORS[payload?.cjiStatus ?? "insufficient"] ?? STATUS_COLORS.insufficient,
    [payload?.cjiStatus]
  );

  return (
    <div
      className="flex flex-col w-full h-full overflow-hidden"
      style={{ background: "#0A0A0D" }}
    >
      <TopBar
        lastUpdated={lastUpdated ?? null}
        isRefreshing={refreshMutation.isPending}
        onRefresh={handleRefresh}
      />

      <div className="flex-1 overflow-auto px-3 py-3 sm:px-6 sm:py-5">
        {isLoading && !payload && (
          <div className="flex flex-col items-center justify-center gap-3 py-20">
            <div
              className="w-5 h-5 rounded-full border-2 border-transparent animate-spin"
              style={{
                borderTopColor: "hsl(224 100% 58%)",
                borderRightColor: "hsl(224 100% 58% / 0.3)",
              }}
            />
            <span
              style={{
                color: "hsl(220 10% 40%)",
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 12,
              }}
            >
              Fetching FRED recession data…
            </span>
          </div>
        )}

        {payload && (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 24,
              maxWidth: 1600,
              margin: "0 auto",
            }}
          >
            {/* ── Headline ───────────────────────────────────── */}
            <div
              style={{
                background: headlineColors.bg,
                border: `1px solid ${headlineColors.border}`,
                borderRadius: 12,
                padding: "clamp(16px, 4vw, 26px) clamp(16px, 4vw, 30px)",
                display: "flex",
                gap: "clamp(14px, 3vw, 32px)",
                alignItems: "center",
                flexWrap: "wrap",
              }}
              data-testid="cji-headline"
            >
              <div style={{ flex: "0 1 auto", minWidth: 0, maxWidth: "100%" }}>
                <div
                  style={{
                    color: "rgba(180,180,200,0.5)",
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 11,
                    letterSpacing: "0.12em",
                  }}
                >
                  CYCLICAL JOBS INDEX (CJI)
                </div>
                <div
                  style={{
                    color: headlineColors.fg,
                    fontFamily: "'Inter', sans-serif",
                    fontSize: "clamp(40px, 11vw, 64px)",
                    fontWeight: 800,
                    letterSpacing: "-0.03em",
                    lineHeight: 1,
                    marginTop: 8,
                  }}
                  data-testid="cji-value"
                >
                  {payload.cji != null ? fmtPct(payload.cji, 2) : "—"}
                </div>
                <div
                  style={{
                    color: "rgba(180,180,200,0.55)",
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 11,
                    marginTop: 8,
                  }}
                >
                  Avg of % off-peak · Residential Construction <span style={{ whiteSpace: "nowrap" }}>& Durable Goods</span>
                </div>
              </div>
              <div style={{ flex: "1 1 260px", minWidth: 0 }}>
                <div
                  style={{
                    display: "inline-block",
                    background: headlineColors.dot,
                    color: "#0A0A0D",
                    fontFamily: "'Inter', sans-serif",
                    fontSize: 12,
                    fontWeight: 800,
                    letterSpacing: "0.06em",
                    padding: "5px 12px",
                    borderRadius: 4,
                    marginBottom: 12,
                  }}
                  data-testid="cji-label"
                >
                  {payload.cjiLabel.toUpperCase()}
                </div>
                {/* Plain-English translation — single sentence in human voice. */}
                <div
                  style={{
                    color: "rgba(235,240,250,0.95)",
                    fontFamily: "'Inter', sans-serif",
                    fontSize: 17,
                    fontWeight: 500,
                    lineHeight: 1.45,
                  }}
                  data-testid="cji-translation"
                >
                  {payload.cjiTranslation}
                </div>
                {/* Mechanical / "what it is" line, smaller and secondary. */}
                <div
                  style={{
                    color: "rgba(190,195,210,0.7)",
                    fontFamily: "'Inter', sans-serif",
                    fontSize: 13,
                    lineHeight: 1.5,
                    marginTop: 6,
                  }}
                >
                  {payload.cjiBlurb}
                </div>
                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    gap: 18,
                    marginTop: 14,
                    color: "rgba(180,180,200,0.65)",
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 12,
                  }}
                >
                  <span>
                    Data as of <strong style={{ color: "rgba(220,225,235,0.9)" }}>{fmtMonth(payload.dataAsOf)}</strong>
                  </span>
                  <span
                    style={{
                      color:
                        payload.cji != null && payload.cji <= -1.5
                          ? payload.confirmedRed
                            ? STATUS_COLORS.signal.fg
                            : STATUS_COLORS.warning.fg
                          : "rgba(180,180,200,0.65)",
                    }}
                    data-testid="confirmation-status"
                  >
                    {payload.confirmationStatus}
                  </span>
                  {payload.partialData && (
                    <span style={{ color: "rgba(245,158,11,0.85)" }}>
                      Partial data — see notes below
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* ── Strategy explainer ────────────────────────── */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                gap: 14,
              }}
              data-testid="strategy-explainer"
            >
              {[
                {
                  label: "WHAT",
                  title: "Track only the 2 cyclical sectors",
                  body:
                    "Residential Construction (CES2023610001) and Durable Goods Manufacturing (DMANEMP). Two confirmation series (Total Construction, Total Manufacturing) and PAYEMS for context.",
                },
                {
                  label: "WHY",
                  title: "Headline payrolls hide the signal",
                  body:
                    "Construction & manufacturing are only ~13% of private payrolls but account for up to 100% of recessionary job losses. Healthcare and education almost never contract, so they bury the cyclical turn in the headline number.",
                },
                {
                  label: "HOW",
                  title: "% off rolling 60-month peak, averaged",
                  body:
                    "CJI = average of how far each leader has fallen from its trailing 60-month peak. Green ≥ -0.5%, yellow -0.5 to -1.5%, red ≤ -1.5%. Red fires for real only when 3-month annualized is negative on both leaders for 2+ consecutive months.",
                },
              ].map((cell) => (
                <div
                  key={cell.label}
                  style={{
                    background: "hsl(230 14% 9% / 0.45)",
                    border: "1px solid hsl(230 10% 16%)",
                    borderRadius: 8,
                    padding: "14px 16px",
                  }}
                >
                  <div
                    style={{
                      color: "rgba(180,180,200,0.5)",
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 11,
                      letterSpacing: "0.12em",
                    }}
                  >
                    {cell.label}
                  </div>
                  <div
                    style={{
                      color: "rgba(225,230,240,0.95)",
                      fontFamily: "'Inter', sans-serif",
                      fontSize: 15,
                      fontWeight: 600,
                      letterSpacing: "-0.01em",
                      marginTop: 4,
                    }}
                  >
                    {cell.title}
                  </div>
                  <div
                    style={{
                      color: "rgba(180,185,200,0.7)",
                      fontFamily: "'Inter', sans-serif",
                      fontSize: 13,
                      lineHeight: 1.55,
                      marginTop: 6,
                    }}
                  >
                    {cell.body}
                  </div>
                </div>
              ))}
            </div>

            {/* ── Detail table ──────────────────────────────── */}
            <div
              style={{
                background: "hsl(230 14% 9% / 0.45)",
                border: "1px solid hsl(230 10% 16%)",
                borderRadius: 10,
                overflow: "hidden",
              }}
              data-testid="sector-table"
            >
              <div
                style={{
                  padding: "14px 16px",
                  borderBottom: "1px solid hsl(230 10% 14%)",
                  display: "flex",
                  alignItems: "baseline",
                  justifyContent: "space-between",
                }}
              >
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <div
                    style={{
                      color: "rgba(225,230,240,0.95)",
                      fontFamily: "'Inter', sans-serif",
                      fontSize: 15,
                      fontWeight: 600,
                      letterSpacing: "-0.01em",
                    }}
                  >
                    Sector detail
                  </div>
                  {/* Plain-English sector summary — glance read of the whole table. */}
                  <div
                    style={{
                      color: "rgba(220,225,235,0.85)",
                      fontFamily: "'Inter', sans-serif",
                      fontSize: 13,
                      lineHeight: 1.5,
                    }}
                    data-testid="sector-summary"
                  >
                    {payload.sectorSummary}
                  </div>
                </div>
                <div
                  style={{
                    color: "rgba(180,180,200,0.5)",
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 11,
                  }}
                >
                  Peak = trailing 60-month max · Recent Momentum = 3-month annualized
                </div>
              </div>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr>
                      {["Sector", "Current", "Peak", "% Off Peak", "Mo Since Peak", "YoY %", "Recent Momentum"].map(
                        (h, i) => (
                          <th
                            key={h}
                            style={{
                              padding: "10px 14px",
                              textAlign: i === 0 ? "left" : "right",
                              color: "rgba(180,180,200,0.55)",
                              fontFamily: "'JetBrains Mono', monospace",
                              fontSize: 10,
                              fontWeight: 600,
                              letterSpacing: "0.1em",
                              borderBottom: "1px solid hsl(230 10% 16%)",
                              textTransform: "uppercase",
                            }}
                          >
                            {h}
                          </th>
                        )
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {payload.sectors.map((s) => (
                      <SectorRow key={s.id} s={s} />
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* ── Historical CJI chart ──────────────────────── */}
            <div
              style={{
                background: "hsl(230 14% 9% / 0.45)",
                border: "1px solid hsl(230 10% 16%)",
                borderRadius: 10,
                padding: "16px 18px",
              }}
              data-testid="cji-chart"
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  justifyContent: "space-between",
                  marginBottom: 8,
                }}
              >
                <div
                  style={{
                    color: "rgba(225,230,240,0.95)",
                    fontFamily: "'Inter', sans-serif",
                    fontSize: 15,
                    fontWeight: 600,
                    letterSpacing: "-0.01em",
                  }}
                >
                  CJI vs. NBER recessions
                </div>
                <div
                  style={{
                    display: "flex",
                    gap: 14,
                    color: "rgba(180,180,200,0.55)",
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 11,
                  }}
                >
                  <LegendSwatch color="rgba(180,180,200,0.45)" label="NBER recession" />
                  <LegendSwatch color={STATUS_COLORS.expansion.dot} label="≥ -0.5%" />
                  <LegendSwatch color={STATUS_COLORS.warning.dot} label="-0.5 to -1.5%" />
                  <LegendSwatch color={STATUS_COLORS.signal.dot} label="≤ -1.5%" />
                </div>
              </div>
              <CjiChart history={payload.cjiHistory} recessions={payload.nberRecessions} />
              <div
                style={{
                  marginTop: 8,
                  color: "rgba(180,180,200,0.55)",
                  fontFamily: "'Inter', sans-serif",
                  fontSize: 12,
                  lineHeight: 1.5,
                }}
              >
                Notice how the line crosses into yellow and red <em>before</em> each gray
                NBER recession bar — that's the lead. When today's end of the line is in
                green, you're fine. Yellow means the clock has started. Red means position
                accordingly.
              </div>
            </div>

            {/* ── PAYEMS YoY context chart ──────────────────── */}
            <div
              style={{
                background: "hsl(230 14% 9% / 0.45)",
                border: "1px solid hsl(230 10% 16%)",
                borderRadius: 10,
                padding: "16px 18px",
              }}
              data-testid="payems-chart"
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  justifyContent: "space-between",
                  marginBottom: 8,
                }}
              >
                <div
                  style={{
                    color: "rgba(225,230,240,0.95)",
                    fontFamily: "'Inter', sans-serif",
                    fontSize: 14,
                    fontWeight: 600,
                    letterSpacing: "-0.01em",
                  }}
                >
                  Context: Total Nonfarm Payrolls (PAYEMS), YoY %
                </div>
                <div
                  style={{
                    color: "rgba(180,180,200,0.5)",
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 11,
                  }}
                >
                  the headline number — turns ~9-29 months <em>after</em> CJI
                </div>
              </div>
              <PayemsChart data={payload.payemsYoY} recessions={payload.nberRecessions} />
            </div>

            {/* ── Notes ─────────────────────────────────────── */}
            {payload.notes.length > 0 && (
              <div
                style={{
                  background: "hsl(35 60% 11% / 0.35)",
                  border: "1px solid rgba(245,160,40,0.25)",
                  borderRadius: 8,
                  padding: "12px 16px",
                  color: "rgba(225,210,180,0.85)",
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: 12,
                  lineHeight: 1.6,
                }}
                data-testid="notes"
              >
                <div
                  style={{
                    color: "rgba(245,160,40,0.85)",
                    fontWeight: 700,
                    letterSpacing: "0.08em",
                    marginBottom: 4,
                  }}
                >
                  NOTES
                </div>
                {payload.notes.map((n, i) => (
                  <div key={i}>· {n}</div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function LegendSwatch({ color, label }: { color: string; label: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
      <span
        style={{
          display: "inline-block",
          width: 10,
          height: 10,
          borderRadius: 2,
          background: color,
        }}
      />
      {label}
    </span>
  );
}
