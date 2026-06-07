import { Fragment, useCallback } from "react";
import { useGetHousing, useRefreshHousing, getGetHousingQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import type {
  CompletedMonthsSupply,
  DominoStatus,
  MonthlyPoint,
} from "@workspace/api-client-react";
import TopBar from "@/components/TopBar";
import { useToast } from "@/hooks/use-toast";

// NBER-dated US recession periods (peak month → trough month). Sourced from
// the NBER Business Cycle Dating Committee. Used to overlay gray vertical
// bands on long-history charts so the metric's track record across cycles
// is legible. Stored as unix seconds for direct comparison with FRED data.
const NBER_RECESSIONS: { start: number; end: number }[] = [
  ["1969-12-01", "1970-11-01"],
  ["1973-11-01", "1975-03-01"],
  ["1980-01-01", "1980-07-01"],
  ["1981-07-01", "1982-11-01"],
  ["1990-07-01", "1991-03-01"],
  ["2001-03-01", "2001-11-01"],
  ["2007-12-01", "2009-06-01"],
  ["2020-02-01", "2020-04-01"],
].map(([s, e]) => ({
  start: Math.floor(Date.parse(s + "T00:00:00Z") / 1000),
  end: Math.floor(Date.parse(e + "T00:00:00Z") / 1000),
}));

const STATE_COLORS: Record<string, { fg: string; bg: string; border: string; dot: string }> = {
  expanding: {
    fg: "rgba(180,210,200,0.95)",
    bg: "hsl(160 30% 12% / 0.5)",
    border: "rgba(80,180,140,0.35)",
    dot: "#10B981",
  },
  rolling_over: {
    fg: "rgba(255,210,140,0.95)",
    bg: "hsl(35 60% 12% / 0.55)",
    border: "rgba(245,160,40,0.45)",
    dot: "#F59E0B",
  },
  fallen: {
    fg: "rgba(255,170,170,0.95)",
    bg: "hsl(0 50% 14% / 0.55)",
    border: "rgba(239,80,80,0.55)",
    dot: "#EF4444",
  },
};

function fmtMonth(ts: number | null): string {
  if (ts == null) return "—";
  return new Date(ts * 1000).toLocaleDateString("en-US", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

function fmtNum(n: number | null, digits = 1): string {
  if (n == null || !isFinite(n)) return "—";
  return n.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

function fmtPct(n: number | null, digits = 1): string {
  if (n == null || !isFinite(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(digits)}%`;
}

// ─── Sparkline ────────────────────────────────────────────────────────────────

interface SparklineProps {
  data: MonthlyPoint[];
  peakDate: number | null;
  state: string;
  width?: number;
  height?: number;
}

function Sparkline({ data, peakDate, state, width = 320, height = 80 }: SparklineProps) {
  if (data.length < 2) {
    return (
      <div
        style={{
          width,
          height,
          color: "rgba(180,180,200,0.3)",
          fontSize: 10,
          fontFamily: "'JetBrains Mono', monospace",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        no data
      </div>
    );
  }

  const xs = data.map((p) => p.time);
  const ys = data.map((p) => p.value);
  const xMin = xs[0];
  const xMax = xs[xs.length - 1];
  const yMin = Math.min(...ys);
  const yMax = Math.max(...ys);
  const xRange = xMax - xMin || 1;
  const yRange = yMax - yMin || 1;
  const pad = 4;

  const x = (t: number) => pad + ((t - xMin) / xRange) * (width - pad * 2);
  const y = (v: number) => height - pad - ((v - yMin) / yRange) * (height - pad * 2);

  const path = data
    .map((p, i) => `${i === 0 ? "M" : "L"} ${x(p.time).toFixed(2)} ${y(p.value).toFixed(2)}`)
    .join(" ");

  const stroke = STATE_COLORS[state]?.dot ?? "#94A3B8";
  const peakX = peakDate != null ? x(peakDate) : null;
  const peakPoint = peakDate != null ? data.find((d) => d.time === peakDate) : null;
  const peakY = peakPoint ? y(peakPoint.value) : null;
  const lastPt = data[data.length - 1];

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      style={{ display: "block", width: "100%", height }}
    >
      {/* baseline */}
      <line
        x1={pad}
        x2={width - pad}
        y1={height - pad}
        y2={height - pad}
        stroke="rgba(255,255,255,0.04)"
        strokeWidth={1}
      />
      {/* peak vertical marker */}
      {peakX != null && (
        <line
          x1={peakX}
          x2={peakX}
          y1={pad}
          y2={height - pad}
          stroke="rgba(200,200,220,0.18)"
          strokeWidth={1}
          strokeDasharray="2 2"
        />
      )}
      {/* line */}
      <path d={path} fill="none" stroke={stroke} strokeWidth={1.4} strokeLinejoin="round" strokeLinecap="round" />
      {/* peak dot */}
      {peakX != null && peakY != null && (
        <circle cx={peakX} cy={peakY} r={2.5} fill="rgba(200,200,220,0.7)" />
      )}
      {/* current dot */}
      <circle cx={x(lastPt.time)} cy={y(lastPt.value)} r={2.5} fill={stroke} />
    </svg>
  );
}

// ─── Completed Months Supply chart ───────────────────────────────────────────

interface CmsChartProps {
  monthsSupply: MonthlyPoint[];
  completed: MonthlyPoint[];
  width?: number;
  height?: number;
}

function CmsChart({ monthsSupply, completed, width = 1200, height = 280 }: CmsChartProps) {
  if (monthsSupply.length < 2 || completed.length < 2) {
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
        no data
      </div>
    );
  }

  const padL = 44;
  const padR = 14;
  const padT = 12;
  const padB = 26;

  const allTimes = [...monthsSupply, ...completed].map((p) => p.time);
  const xMin = Math.min(...allTimes);
  const xMax = Math.max(...allTimes);
  const xRange = xMax - xMin || 1;

  const allVals = [...monthsSupply, ...completed].map((p) => p.value);
  const yDataMax = Math.max(...allVals);
  const yMin = 0;
  const yMax = Math.max(12, Math.ceil(yDataMax + 1));
  const yRange = yMax - yMin || 1;

  const x = (t: number) => padL + ((t - xMin) / xRange) * (width - padL - padR);
  const y = (v: number) => padT + ((yMax - v) / yRange) * (height - padT - padB);

  const path = (data: MonthlyPoint[]) =>
    data
      .map((p, i) => `${i === 0 ? "M" : "L"} ${x(p.time).toFixed(2)} ${y(p.value).toFixed(2)}`)
      .join(" ");

  // Threshold lines (the historical recession bands for raw months supply).
  const thresholds = [
    { v: 7, label: "7 · elevated", color: "rgba(245,158,11,0.45)" },
    { v: 8, label: "8 · recession-territory", color: "rgba(239,68,68,0.5)" },
  ];

  // Y ticks at integer intervals.
  const yTicks: number[] = [];
  for (let v = 0; v <= yMax; v += 2) yTicks.push(v);

  // X ticks: density adapts to the time span so a 60-year chart isn't a wall
  // of labels and a 10-year chart isn't sparse.
  const startYear = new Date(xMin * 1000).getUTCFullYear();
  const endYear = new Date(xMax * 1000).getUTCFullYear();
  const span = endYear - startYear;
  const tickStep = span > 40 ? 10 : span > 20 ? 5 : 2;
  const xTicks: { x: number; label: string }[] = [];
  for (let yr = Math.ceil(startYear / tickStep) * tickStep; yr <= endYear; yr += tickStep) {
    const ts = Math.floor(Date.UTC(yr, 0, 1) / 1000);
    if (ts < xMin || ts > xMax) continue;
    xTicks.push({ x: x(ts), label: String(yr) });
  }

  const lastMs = monthsSupply[monthsSupply.length - 1];
  const lastCms = completed[completed.length - 1];

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      style={{ display: "block", width: "100%", height }}
    >
      {/* NBER recession bands — gray vertical shading for each historical
          recession that overlaps the visible window. Drawn first so the lines
          and threshold bands sit on top. */}
      {NBER_RECESSIONS.filter((r) => r.end >= xMin && r.start <= xMax).map((r) => {
        const x1 = x(Math.max(r.start, xMin));
        const x2 = x(Math.min(r.end, xMax));
        return (
          <rect
            key={r.start}
            x={x1}
            y={padT}
            width={Math.max(1, x2 - x1)}
            height={height - padT - padB}
            fill="rgba(180,180,200,0.13)"
          />
        );
      })}

      {/* Threshold band shading (above 7 = warning, above 8 = recession) */}
      <rect
        x={padL}
        y={y(yMax)}
        width={width - padL - padR}
        height={Math.max(0, y(8) - y(yMax))}
        fill="rgba(239,68,68,0.06)"
      />
      <rect
        x={padL}
        y={y(8)}
        width={width - padL - padR}
        height={Math.max(0, y(7) - y(8))}
        fill="rgba(245,158,11,0.06)"
      />

      {/* Y grid + labels */}
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
            x={padL - 6}
            y={y(v) + 3}
            textAnchor="end"
            fill="rgba(180,180,200,0.5)"
            fontFamily="'JetBrains Mono', monospace"
            fontSize={10}
          >
            {v}
          </text>
        </g>
      ))}

      {/* X tick labels */}
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
      {thresholds.map((t) => (
        <line
          key={t.v}
          x1={padL}
          x2={width - padR}
          y1={y(t.v)}
          y2={y(t.v)}
          stroke={t.color}
          strokeWidth={1}
          strokeDasharray="3 3"
        />
      ))}

      {/* Raw months supply — muted line */}
      <path
        d={path(monthsSupply)}
        fill="none"
        stroke="rgba(180,180,200,0.55)"
        strokeWidth={1.3}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {/* Completed months supply — accent line */}
      <path
        d={path(completed)}
        fill="none"
        stroke="rgba(96,165,250,0.95)"
        strokeWidth={1.6}
        strokeLinejoin="round"
        strokeLinecap="round"
      />

      {/* Current dots */}
      <circle cx={x(lastMs.time)} cy={y(lastMs.value)} r={3} fill="rgba(220,225,235,0.9)" />
      <circle cx={x(lastCms.time)} cy={y(lastCms.value)} r={3.5} fill="rgba(96,165,250,1)" />
    </svg>
  );
}

// ─── % of New Home Inventory That's Completed chart ──────────────────────────

interface PctCompletedChartProps {
  data: MonthlyPoint[];
  width?: number;
  height?: number;
}

function PctCompletedChart({ data, width = 1200, height = 240 }: PctCompletedChartProps) {
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
        no data
      </div>
    );
  }

  const padL = 44;
  const padR = 14;
  const padT = 12;
  const padB = 26;

  const xMin = data[0].time;
  const xMax = data[data.length - 1].time;
  const xRange = xMax - xMin || 1;

  const vals = data.map((p) => p.value);
  const yDataMax = Math.max(...vals);
  const yMin = 0;
  const yMax = Math.max(40, Math.ceil((yDataMax + 5) / 5) * 5);
  const yRange = yMax - yMin || 1;

  const x = (t: number) => padL + ((t - xMin) / xRange) * (width - padL - padR);
  const y = (v: number) => padT + ((yMax - v) / yRange) * (height - padT - padB);

  const path = data
    .map((p, i) => `${i === 0 ? "M" : "L"} ${x(p.time).toFixed(2)} ${y(p.value).toFixed(2)}`)
    .join(" ");

  // The "historically normal" 20-30% band — the EPB article's reference range.
  const bandTop = 30;
  const bandBottom = 20;

  const yTicks: number[] = [];
  for (let v = 0; v <= yMax; v += 10) yTicks.push(v);

  const startYear = new Date(xMin * 1000).getUTCFullYear();
  const endYear = new Date(xMax * 1000).getUTCFullYear();
  const span = endYear - startYear;
  const tickStep = span > 40 ? 10 : span > 20 ? 5 : 2;
  const xTicks: { x: number; label: string }[] = [];
  for (let yr = Math.ceil(startYear / tickStep) * tickStep; yr <= endYear; yr += tickStep) {
    const ts = Math.floor(Date.UTC(yr, 0, 1) / 1000);
    if (ts < xMin || ts > xMax) continue;
    xTicks.push({ x: x(ts), label: String(yr) });
  }

  const last = data[data.length - 1];

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      style={{ display: "block", width: "100%", height }}
    >
      {/* NBER recession bands */}
      {NBER_RECESSIONS.filter((r) => r.end >= xMin && r.start <= xMax).map((r) => {
        const x1 = x(Math.max(r.start, xMin));
        const x2 = x(Math.min(r.end, xMax));
        return (
          <rect
            key={r.start}
            x={x1}
            y={padT}
            width={Math.max(1, x2 - x1)}
            height={height - padT - padB}
            fill="rgba(180,180,200,0.13)"
          />
        );
      })}

      {/* Historical "normal" band: 20-30% completed */}
      <rect
        x={padL}
        y={y(bandTop)}
        width={width - padL - padR}
        height={Math.max(0, y(bandBottom) - y(bandTop))}
        fill="rgba(96,165,250,0.05)"
      />
      <line
        x1={padL}
        x2={width - padR}
        y1={y(bandTop)}
        y2={y(bandTop)}
        stroke="rgba(96,165,250,0.3)"
        strokeWidth={1}
        strokeDasharray="3 3"
      />
      <line
        x1={padL}
        x2={width - padR}
        y1={y(bandBottom)}
        y2={y(bandBottom)}
        stroke="rgba(96,165,250,0.3)"
        strokeWidth={1}
        strokeDasharray="3 3"
      />

      {/* Y grid + labels */}
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
            x={padL - 6}
            y={y(v) + 3}
            textAnchor="end"
            fill="rgba(180,180,200,0.5)"
            fontFamily="'JetBrains Mono', monospace"
            fontSize={10}
          >
            {v}%
          </text>
        </g>
      ))}

      {/* X tick labels */}
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

      <path
        d={path}
        fill="none"
        stroke="rgba(96,165,250,0.95)"
        strokeWidth={1.6}
        strokeLinejoin="round"
        strokeLinecap="round"
      />

      <circle cx={x(last.time)} cy={y(last.value)} r={3.5} fill="rgba(96,165,250,1)" />
    </svg>
  );
}

// Plain-English signal pill colors for the CMS card.
const CMS_SIGNAL_THEME: Record<
  string,
  { fg: string; bg: string; border: string; dot: string; label: string }
> = {
  tight: {
    fg: "rgba(180,210,200,0.95)",
    bg: "hsl(160 30% 12% / 0.5)",
    border: "rgba(80,180,140,0.4)",
    dot: "#10B981",
    label: "TIGHT",
  },
  normal: {
    fg: "rgba(180,210,200,0.95)",
    bg: "hsl(160 30% 12% / 0.45)",
    border: "rgba(80,180,140,0.35)",
    dot: "#10B981",
    label: "NORMAL",
  },
  elevated: {
    fg: "rgba(255,210,140,0.95)",
    bg: "hsl(35 60% 12% / 0.55)",
    border: "rgba(245,160,40,0.5)",
    dot: "#F59E0B",
    label: "ELEVATED",
  },
  recessionary: {
    fg: "rgba(255,170,170,0.95)",
    bg: "hsl(0 50% 14% / 0.55)",
    border: "rgba(239,80,80,0.55)",
    dot: "#EF4444",
    label: "RECESSIONARY",
  },
  insufficient: {
    fg: "rgba(180,180,200,0.85)",
    bg: "hsl(230 14% 11% / 0.5)",
    border: "rgba(140,140,160,0.35)",
    dot: "#94A3B8",
    label: "—",
  },
};

function CompletedMonthsSupplySection({ cms }: { cms: CompletedMonthsSupply }) {
  const theme = CMS_SIGNAL_THEME[cms.signal] ?? CMS_SIGNAL_THEME.insufficient;

  return (
    <div
      style={{
        background: "hsl(230 14% 9% / 0.45)",
        border: "1px solid hsl(230 10% 16%)",
        borderRadius: 10,
        padding: "18px 20px",
        display: "flex",
        flexDirection: "column",
        gap: 16,
      }}
      data-testid="completed-months-supply"
    >
      {/* Header row */}
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 10,
        }}
      >
        <div>
          <div
            style={{
              color: "rgba(180,180,200,0.5)",
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 11,
              letterSpacing: "0.12em",
            }}
          >
            ADVANCED INDICATOR · COMPLETED MONTHS SUPPLY
          </div>
          <div
            style={{
              color: "rgba(225,230,240,0.95)",
              fontFamily: "'Inter', sans-serif",
              fontSize: 16,
              fontWeight: 600,
              letterSpacing: "-0.01em",
              marginTop: 4,
            }}
          >
            The 2022 false-signal fix for months supply
          </div>
        </div>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "4px 10px",
            background: theme.bg,
            border: `1px solid ${theme.border}`,
            color: theme.fg,
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: "0.08em",
            borderRadius: 4,
          }}
        >
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: theme.dot,
              display: "inline-block",
            }}
          />
          {theme.label}
        </span>
      </div>

      {/* Headline + explainer */}
      <div>
        <div
          style={{
            color: "rgba(235,240,250,0.95)",
            fontFamily: "'Inter', sans-serif",
            fontSize: 17,
            fontWeight: 500,
            lineHeight: 1.45,
          }}
          data-testid="cms-headline"
        >
          {cms.headline}
        </div>
        <div
          style={{
            color: "rgba(190,195,210,0.7)",
            fontFamily: "'Inter', sans-serif",
            fontSize: 13,
            lineHeight: 1.55,
            marginTop: 8,
          }}
          data-testid="cms-explainer"
        >
          {cms.explainer}
        </div>
      </div>

      {/* Stat row */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
          gap: 12,
        }}
      >
        <CmsStat
          label="Raw Months Supply"
          value={cms.currentMonthsSupply != null ? cms.currentMonthsSupply.toFixed(1) : "—"}
          accent="rgba(220,225,235,0.9)"
        />
        <CmsStat
          label="Completed Months Supply"
          value={
            cms.currentCompletedMonthsSupply != null
              ? cms.currentCompletedMonthsSupply.toFixed(1)
              : "—"
          }
          accent="rgba(96,165,250,1)"
        />
        <CmsStat
          label="% Inventory Completed"
          value={
            cms.currentPctCompleted != null ? `${cms.currentPctCompleted.toFixed(0)}%` : "—"
          }
          accent="rgba(220,225,235,0.9)"
        />
        <CmsStat
          label="Gap (raw − completed)"
          value={cms.gap != null ? cms.gap.toFixed(1) : "—"}
          accent={cms.gap != null && cms.gap >= 2 ? "rgba(245,158,11,0.95)" : "rgba(220,225,235,0.9)"}
        />
      </div>

      {/* Chart + legend */}
      <div>
        <div
          style={{
            display: "flex",
            gap: 16,
            color: "rgba(180,180,200,0.55)",
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 11,
            marginBottom: 6,
            flexWrap: "wrap",
          }}
        >
          <LegendDot color="rgba(180,180,200,0.55)" label="Raw months supply (MSACSR)" />
          <LegendDot color="rgba(96,165,250,0.95)" label="Completed months supply" />
          <LegendDot color="rgba(245,158,11,0.6)" label="7 · elevated" />
          <LegendDot color="rgba(239,68,68,0.6)" label="8 · recession-territory" />
          <LegendDot color="rgba(180,180,200,0.35)" label="NBER recession" />
        </div>
        <CmsChart
          monthsSupply={cms.monthsSupplyHistory}
          completed={cms.completedMonthsSupplyHistory}
        />
      </div>

      {/* Companion chart: % of new-home inventory that's actually completed.
          This is the "why" behind the gap in the chart above — the EPB article's
          composition story made visible. */}
      <div>
        <div
          style={{
            color: "rgba(220,225,235,0.85)",
            fontFamily: "'Inter', sans-serif",
            fontSize: 14,
            fontWeight: 600,
            marginBottom: 4,
          }}
        >
          % of new-home inventory that's completed
        </div>
        <div
          style={{
            color: "rgba(180,180,200,0.6)",
            fontFamily: "'Inter', sans-serif",
            fontSize: 12,
            lineHeight: 1.5,
            marginBottom: 10,
          }}
        >
          When this drops, raw months supply overstates the recession signal — fewer of the homes
          counted as "supply" are actually move-in ready. Historically this sits in the 20–30%
          band; the 2021 collapse to ~8% is what produced the false 2022 signal.
        </div>
        <div
          style={{
            display: "flex",
            gap: 16,
            color: "rgba(180,180,200,0.55)",
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 11,
            marginBottom: 6,
            flexWrap: "wrap",
          }}
        >
          <LegendDot color="rgba(96,165,250,0.95)" label="% completed (NHFSEPCS / NHFSEPTS)" />
          <LegendDot color="rgba(96,165,250,0.5)" label="20–30% · historical normal band" />
          <LegendDot color="rgba(180,180,200,0.35)" label="NBER recession" />
        </div>
        <PctCompletedChart data={cms.pctCompletedHistory} />
      </div>

      <div
        style={{
          color: "rgba(180,180,200,0.45)",
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 11,
          lineHeight: 1.5,
        }}
      >
        FRED: MSACSR · NHFSEPCS · NHFSEPTS · methodology refinement per EPB Research
      </div>
    </div>
  );
}

function CmsStat({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <div
      style={{
        background: "hsl(230 14% 7% / 0.55)",
        border: "1px solid hsl(230 10% 14%)",
        borderRadius: 8,
        padding: "12px 14px",
      }}
    >
      <div
        style={{
          color: "rgba(180,180,200,0.55)",
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 10,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
        }}
      >
        {label}
      </div>
      <div
        style={{
          color: accent,
          fontFamily: "'Inter', sans-serif",
          fontSize: 26,
          fontWeight: 700,
          letterSpacing: "-0.02em",
          lineHeight: 1.1,
          marginTop: 4,
        }}
      >
        {value}
      </div>
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
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

// ─── Domino Card ──────────────────────────────────────────────────────────────

const SHORT_LABELS: Record<string, string> = {
  newSales: "New Home Sales",
  permits: "Building Permits",
  underConstruction: "Building Activity",
  employment: "Construction Jobs",
  homePrices: "Home Prices",
};

// Plain-English description of what each card represents and what its
// position in the chain tells you.
const DOMINO_MEANING: Record<string, string> = {
  newSales:
    "Earliest warning. When buyers stop showing up, every other housing data point follows.",
  permits:
    "Builders pull permits months before they break ground. A drop here means they're losing confidence in demand.",
  underConstruction:
    "How much builders are actually building right now. Falls when projects finish faster than new ones start.",
  employment:
    "Construction sector payrolls. Builders are slow to fire, so this falls late — but when it does, it spreads to the rest of the economy.",
  homePrices:
    "Always the last to move. Sellers cling to old prices until they can't.",
};

// Plain-English badge for the per-card sequence-position flag.
// "in_order"     → green ✓ "in order"     — declining in proper sequence
// "out_of_order" → amber ✗ "out of order" — declined before a predecessor did
// "healthy"      → green ✓ "healthy"      — still expanding, no judgement to make
// "pending"      → muted — "pending"      — legacy fallback (no longer emitted)
function OrderBadge({ status }: { status: DominoStatus["orderStatus"] }) {
  const config: Record<DominoStatus["orderStatus"], { fg: string; bg: string; border: string; icon: string; text: string }> = {
    in_order: {
      fg: "rgba(180,210,200,0.95)",
      bg: "hsl(160 30% 12% / 0.6)",
      border: "rgba(80,180,140,0.45)",
      icon: "✓",
      text: "in order",
    },
    out_of_order: {
      fg: "rgba(255,210,140,0.95)",
      bg: "hsl(35 60% 12% / 0.6)",
      border: "rgba(245,160,40,0.5)",
      icon: "✗",
      text: "out of order",
    },
    healthy: {
      fg: "rgba(180,210,200,0.95)",
      bg: "hsl(160 30% 12% / 0.6)",
      border: "rgba(80,180,140,0.45)",
      icon: "✓",
      text: "healthy",
    },
    pending: {
      fg: "rgba(180,180,200,0.6)",
      bg: "hsl(230 14% 11% / 0.5)",
      border: "rgba(140,140,160,0.3)",
      icon: "—",
      text: "pending",
    },
  };
  const c = config[status];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "2px 8px",
        background: c.bg,
        border: `1px solid ${c.border}`,
        color: c.fg,
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        borderRadius: 4,
      }}
      data-testid={`order-${status}`}
    >
      <span style={{ fontSize: 12, lineHeight: 1 }}>{c.icon}</span>
      {c.text}
    </span>
  );
}

// Arrow between domino cards — shows the expected falling order visually.
function DominoArrow() {
  return (
    <div
      className="rotate-90 sm:rotate-0"
      style={{
        flex: "0 0 24px",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "rgba(180,180,200,0.35)",
        fontSize: 22,
        fontWeight: 300,
        userSelect: "none",
      }}
      aria-hidden
    >
      →
    </div>
  );
}

function DominoCard({ d, index }: { d: DominoStatus; index: number }) {
  const c = STATE_COLORS[d.state] ?? STATE_COLORS.expanding;
  const stateLabel = d.state === "fallen" ? "FALLEN" : d.state === "rolling_over" ? "ROLLING" : "OK";
  const shortLabel = SHORT_LABELS[d.id] ?? d.label;
  const meaning = DOMINO_MEANING[d.id] ?? "";

  return (
    <div
      style={{
        flex: "1 1 0",
        minWidth: 0,
        background: c.bg,
        border: `1px solid ${c.border}`,
        borderRadius: 10,
        padding: "18px 20px",
        display: "flex",
        flexDirection: "column",
        gap: 14,
      }}
      data-testid={`domino-${d.id}`}
    >
      {/* Step number + name (top row), order badge on its own row below to
          avoid overlapping the (often two-line) title in narrow cards. */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, minWidth: 0 }}>
          <span
            style={{
              color: "rgba(180,180,200,0.7)",
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 13,
              fontWeight: 700,
              flexShrink: 0,
              background: "rgba(255,255,255,0.05)",
              borderRadius: "50%",
              width: 22,
              height: 22,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              lineHeight: 1,
            }}
          >
            {index + 1}
          </span>
          <span
            style={{
              color: "rgba(230,235,245,0.98)",
              fontFamily: "'Inter', sans-serif",
              fontSize: 17,
              fontWeight: 600,
              letterSpacing: "-0.01em",
              lineHeight: 1.2,
              flex: 1,
              minWidth: 0,
            }}
          >
            {shortLabel}
          </span>
        </div>
        <div>
          <OrderBadge status={d.orderStatus} />
        </div>
      </div>

      {/* Hero: % off peak + status pill side by side */}
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10 }}>
        <div
          style={{
            color: c.fg,
            fontFamily: "'Inter', sans-serif",
            fontSize: 32,
            fontWeight: 700,
            letterSpacing: "-0.025em",
            lineHeight: 1,
          }}
        >
          {fmtPct(d.pctOffPeak)}
        </div>
        <span
          style={{
            background: c.dot,
            color: "#0A0A0D",
            fontFamily: "'Inter', sans-serif",
            fontSize: 10,
            fontWeight: 800,
            letterSpacing: "0.08em",
            padding: "3px 8px",
            borderRadius: 4,
            flexShrink: 0,
          }}
        >
          {stateLabel}
        </span>
      </div>

      <div
        style={{
          color: "rgba(180,180,200,0.55)",
          fontFamily: "'Inter', sans-serif",
          fontSize: 13,
          marginTop: -8,
        }}
      >
        {d.monthsSincePeak === 0
          ? d.roc6m != null
            ? `at a new 24-month high · ${fmtPct(d.roc6m)} over 6mo`
            : "at a new 24-month high · still rising"
          : `from peak · ${d.monthsSincePeak ?? "—"} mo ago`}
      </div>

      {/* Sparkline */}
      <Sparkline data={d.data} peakDate={d.peakDate} state={d.state} width={300} height={56} />

      {/* What this card means in plain English */}
      <div
        style={{
          color: "rgba(180,185,200,0.6)",
          fontFamily: "'Inter', sans-serif",
          fontSize: 12,
          lineHeight: 1.5,
          borderTop: "1px solid rgba(255,255,255,0.05)",
          paddingTop: 10,
          marginTop: 2,
        }}
      >
        {meaning}
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function HousingPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data, isLoading, isError } = useGetHousing();
  const refreshMutation = useRefreshHousing();

  const handleRefresh = useCallback(() => {
    refreshMutation.mutate(undefined, {
      onSuccess: (fresh) => {
        queryClient.setQueryData(getGetHousingQueryKey(), fresh);
        queryClient.invalidateQueries({ queryKey: getGetHousingQueryKey() });
      },
      onError: (err) =>
        toast({
          title: "Refresh failed",
          description: err instanceof Error ? err.message : "Could not reach FRED",
          variant: "destructive",
        }),
    });
  }, [refreshMutation, queryClient, toast]);

  const payload = data;
  const lastUpdated = payload?.lastUpdated ?? null;
  const noData = !isLoading && !payload;

  return (
    <div className="flex flex-col w-full h-full overflow-hidden" style={{ background: "#0A0A0D" }}>
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
              style={{ borderTopColor: "hsl(224 100% 58%)", borderRightColor: "hsl(224 100% 58% / 0.3)" }}
            />
            <span style={{ color: "hsl(220 10% 40%)", fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}>
              Loading from database…
            </span>
          </div>
        )}

        {noData && (
          <div className="flex flex-col items-center justify-center gap-2 py-20 text-center">
            <span style={{ color: "rgba(220,225,235,0.85)", fontFamily: "'Inter', sans-serif", fontSize: 14 }}>
              {isError ? "No housing data in the database yet." : "No housing data."}
            </span>
            <span style={{ color: "rgba(200,200,220,0.5)", fontFamily: "'JetBrains Mono', monospace", fontSize: 11 }}>
              Click Refresh to load fresh data from FRED.
            </span>
          </div>
        )}

        {payload && (() => {
          // Counts still drive the at-a-glance "DOMINOES FALLEN" card below.
          const fallenCount = payload.dominoes.filter((d) => d.fallen).length;
          const rollingCount = payload.dominoes.filter((d) => d.state === "rolling_over").length;

          // Verdict + plain-English copy now come from the backend so the
          // numbers, colors, and copy can never drift out of sync.
          const verdict = payload.headlineLabel;
          const VERDICT_THEME: Record<string, { color: string; bg: string; border: string }> = {
            "FALSE START": { color: "#F59E0B", bg: "hsl(35 60% 11% / 0.7)", border: "rgba(245,160,40,0.6)" },
            "LATE STAGE": { color: "#EF4444", bg: "hsl(0 50% 12% / 0.7)", border: "rgba(239,80,80,0.6)" },
            ARMED: { color: "#F59E0B", bg: "hsl(35 60% 11% / 0.7)", border: "rgba(245,160,40,0.6)" },
            WATCHING: { color: "#60A5FA", bg: "hsl(220 40% 11% / 0.6)", border: "rgba(96,165,250,0.4)" },
            DORMANT: { color: "#10B981", bg: "hsl(160 30% 11% / 0.6)", border: "rgba(80,180,140,0.4)" },
            EXPANSION: { color: "#10B981", bg: "hsl(160 30% 11% / 0.6)", border: "rgba(80,180,140,0.4)" },
          };
          const theme = VERDICT_THEME[verdict] ?? VERDICT_THEME.WATCHING;
          const verdictColor = theme.color;
          const verdictBg = theme.bg;
          const verdictBorder = theme.border;

          return (
          <div style={{ display: "flex", flexDirection: "column", gap: 28, maxWidth: 1600, margin: "0 auto" }}>
            {/* Verdict banner */}
            <div
              style={{
                background: verdictBg,
                border: `1px solid ${verdictBorder}`,
                borderRadius: 12,
                padding: "clamp(16px, 4vw, 26px) clamp(16px, 4vw, 30px)",
                display: "flex",
                gap: "clamp(14px, 3vw, 32px)",
                alignItems: "center",
                flexWrap: "wrap",
              }}
              data-testid="verdict-banner"
            >
              <div style={{ flex: "0 1 auto", minWidth: 0 }}>
                <div
                  style={{
                    color: "rgba(180,180,200,0.5)",
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 11,
                    letterSpacing: "0.12em",
                  }}
                >
                  HOUSING CYCLE
                </div>
                <div
                  style={{
                    color: verdictColor,
                    fontFamily: "'Inter', sans-serif",
                    fontSize: "clamp(34px, 9vw, 56px)",
                    fontWeight: 800,
                    letterSpacing: "-0.03em",
                    lineHeight: 1,
                    marginTop: 6,
                  }}
                >
                  {verdict}
                </div>
              </div>
              <div style={{ flex: "1 1 260px", minWidth: 0 }}>
                {/* One-line plain-English subtitle — the 30-second takeaway. */}
                <div
                  style={{
                    color: "rgba(235,240,250,0.95)",
                    fontFamily: "'Inter', sans-serif",
                    fontSize: 17,
                    lineHeight: 1.45,
                    fontWeight: 500,
                  }}
                  data-testid="headline-subtitle"
                >
                  {payload.headlineSubtitle}
                </div>
                {/* Plain-English summary sentence — replaces the count row. */}
                <div
                  style={{
                    color: "rgba(200,205,220,0.75)",
                    fontFamily: "'Inter', sans-serif",
                    fontSize: 14,
                    lineHeight: 1.5,
                    marginTop: 8,
                  }}
                  data-testid="housing-summary"
                >
                  {payload.summary}
                </div>
                {/* Fed context line — humanized rate context. */}
                <div
                  style={{
                    color: "rgba(180,185,200,0.7)",
                    fontFamily: "'Inter', sans-serif",
                    fontSize: 13,
                    lineHeight: 1.5,
                    marginTop: 4,
                  }}
                  data-testid="housing-fed-context"
                >
                  {payload.fedContext}
                </div>
              </div>
            </div>

            {/* How this works — 3-column strategy explainer */}
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
                  title: "Track 5 housing data points",
                  body:
                    "New home sales, building permits, building activity, construction jobs, and home prices. They're the five links in the housing supply chain.",
                },
                {
                  label: "WHY",
                  title: "Housing leads the economy",
                  body:
                    "When the Fed tightens, housing breaks first. A real downturn moves through these five in a fixed mechanical order — buyers respond to rates, builders respond to buyers, payrolls respond to builders.",
                },
                {
                  label: "HOW",
                  title: "Order matters more than count",
                  body:
                    "If they peak in order — sales → permits → activity → jobs → prices — recession typically follows 12 to 36 months later. If they fall out of order, it's noise (rate spike, supply shock) and the signal resets.",
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

            {/* HIDDEN: legacy stat row (kept structure for future re-add) */}
            <div style={{ display: "none" }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 14 }}>
              {/* Fed gate */}
              <div
                style={{
                  background: payload.fed.tightening
                    ? "hsl(0 40% 12% / 0.55)"
                    : "hsl(220 30% 12% / 0.5)",
                  border: payload.fed.tightening
                    ? "1px solid rgba(239,80,80,0.45)"
                    : "1px solid hsl(230 10% 18%)",
                  borderRadius: 8,
                  padding: "16px 18px",
                }}
                data-testid="fed-gate"
              >
                <div
                  style={{
                    color: "rgba(180,180,200,0.55)",
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 11,
                    letterSpacing: "0.1em",
                  }}
                >
                  GATE · FED POLICY
                </div>
                <div
                  style={{
                    color: payload.fed.tightening
                      ? "rgba(255,170,170,0.98)"
                      : "rgba(180,210,200,0.92)",
                    fontFamily: "'Inter', sans-serif",
                    fontSize: 17,
                    fontWeight: 700,
                    marginTop: 6,
                    lineHeight: 1.25,
                  }}
                >
                  {payload.fed.tightening ? "Tightening" : "Not tightening"}
                </div>
                <div
                  style={{
                    color: "rgba(200,205,215,0.7)",
                    fontFamily: "'Inter', sans-serif",
                    fontSize: 13,
                    marginTop: 2,
                  }}
                >
                  {payload.fed.tightening ? "Sequence is armed" : "Sequence is dormant"}
                </div>
                <div
                  style={{
                    color: "rgba(180,180,200,0.6)",
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 12,
                    marginTop: 8,
                  }}
                >
                  Fed funds {fmtNum(payload.fed.current, 2)}%
                  <span style={{ color: "rgba(180,180,200,0.35)" }}> · 12mo ago </span>
                  {fmtNum(payload.fed.yearAgo, 2)}%
                </div>
              </div>

              {/* Fallen count — at-a-glance */}
              <div
                style={{
                  background:
                    fallenCount >= 3
                      ? "hsl(0 50% 14% / 0.6)"
                      : fallenCount >= 1
                        ? "hsl(35 60% 12% / 0.55)"
                        : "hsl(230 14% 9% / 0.7)",
                  border:
                    fallenCount >= 3
                      ? "1px solid rgba(239,80,80,0.55)"
                      : fallenCount >= 1
                        ? "1px solid rgba(245,160,40,0.45)"
                        : "1px solid hsl(230 10% 18%)",
                  borderRadius: 8,
                  padding: "16px 18px",
                  display: "flex",
                  flexDirection: "column",
                }}
                data-testid="fallen-count"
              >
                <div
                  style={{
                    color: "rgba(180,180,200,0.55)",
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 11,
                    letterSpacing: "0.1em",
                  }}
                >
                  DOMINOES FALLEN
                </div>
                <div
                  style={{
                    color:
                      fallenCount >= 3
                        ? "rgba(255,170,170,0.98)"
                        : fallenCount >= 1
                          ? "rgba(255,210,140,0.95)"
                          : "rgba(180,210,200,0.85)",
                    fontFamily: "'Inter', sans-serif",
                    fontSize: 36,
                    fontWeight: 800,
                    letterSpacing: "-0.03em",
                    marginTop: 4,
                    lineHeight: 1,
                  }}
                >
                  {fallenCount}<span style={{ color: "rgba(180,180,200,0.4)", fontSize: 22, fontWeight: 600 }}> / 5</span>
                </div>
                <div
                  style={{
                    color: "rgba(200,205,215,0.65)",
                    fontFamily: "'Inter', sans-serif",
                    fontSize: 12,
                    marginTop: 6,
                  }}
                >
                  +{rollingCount} rolling over
                </div>
              </div>

              {/* Stage */}
              <div
                style={{
                  background: "hsl(230 14% 9% / 0.75)",
                  border: "1px solid hsl(230 10% 18%)",
                  borderRadius: 8,
                  padding: "16px 18px",
                }}
                data-testid="stage-card"
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <div
                    style={{
                      color: "rgba(180,180,200,0.55)",
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 11,
                      letterSpacing: "0.1em",
                    }}
                  >
                    CONSECUTIVE STAGE SCORE
                  </div>
                  <div
                    style={{
                      color: "rgba(225,230,240,0.95)",
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 17,
                      fontWeight: 700,
                    }}
                  >
                    {payload.stage} / 5
                  </div>
                </div>
                <div
                  style={{
                    color: "rgba(225,230,240,0.95)",
                    fontFamily: "'Inter', sans-serif",
                    fontSize: 16,
                    fontWeight: 600,
                    marginTop: 6,
                    lineHeight: 1.3,
                  }}
                >
                  {payload.stageLabel}
                </div>
                {payload.expectedTimingNote && (
                  <div
                    style={{
                      color: "rgba(255,210,140,0.95)",
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 12,
                      marginTop: 8,
                    }}
                  >
                    ⚠ {payload.expectedTimingNote}
                  </div>
                )}
                {/* Stage progress bar */}
                <div
                  style={{
                    display: "flex",
                    gap: 4,
                    marginTop: 10,
                  }}
                >
                  {[0, 1, 2, 3, 4].map((i) => (
                    <div
                      key={i}
                      style={{
                        flex: 1,
                        height: 8,
                        borderRadius: 2,
                        background: i < payload.stage ? "#EF4444" : "rgba(255,255,255,0.07)",
                      }}
                    />
                  ))}
                </div>
              </div>

              {/* Sequence integrity */}
              <div
                style={{
                  background: payload.sequenceValid
                    ? "hsl(160 30% 12% / 0.5)"
                    : "hsl(35 60% 12% / 0.6)",
                  border: payload.sequenceValid
                    ? "1px solid rgba(80,180,140,0.4)"
                    : "1px solid rgba(245,160,40,0.55)",
                  borderRadius: 8,
                  padding: "16px 18px",
                }}
                data-testid="sequence-integrity"
              >
                <div
                  style={{
                    color: "rgba(180,180,200,0.55)",
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 11,
                    letterSpacing: "0.1em",
                  }}
                >
                  SEQUENCE INTEGRITY
                </div>
                <div
                  style={{
                    color: payload.sequenceValid
                      ? "rgba(180,210,200,0.98)"
                      : "rgba(255,210,140,0.98)",
                    fontFamily: "'Inter', sans-serif",
                    fontSize: 17,
                    fontWeight: 700,
                    marginTop: 6,
                  }}
                >
                  {payload.sequenceValid ? "In order" : "False start"}
                </div>
                <div
                  style={{
                    color: "rgba(200,205,215,0.7)",
                    fontFamily: "'Inter', sans-serif",
                    fontSize: 13,
                    marginTop: 4,
                    lineHeight: 1.4,
                  }}
                >
                  {payload.sequenceNote}
                </div>
              </div>
            </div>
            </div>

            {/* Section label for dominoes */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: -8,
              }}
            >
              <div>
                <div
                  style={{
                    color: "rgba(180,180,200,0.5)",
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 12,
                    letterSpacing: "0.12em",
                  }}
                >
                  THE 5 DOMINOES · LEFT TO RIGHT
                </div>
                <div
                  style={{
                    color: "rgba(180,185,200,0.65)",
                    fontFamily: "'Inter', sans-serif",
                    fontSize: 13,
                    marginTop: 4,
                    maxWidth: 900,
                    lineHeight: 1.5,
                  }}
                >
                  In a real housing-led recession, these fall in order — left to right. Each one leads the next
                  by months. When something falls out of order, it usually means a one-off shock, not the start
                  of a downturn.
                </div>
              </div>
            </div>

            {/* Domino row — cards separated by directional arrows so the
                expected falling order is visually obvious. Stacks vertically
                on mobile (with down-arrows) and lays out horizontally on
                tablet/desktop. */}
            <div
              className="flex flex-col sm:flex-row"
              style={{ gap: 6, alignItems: "stretch" }}
            >
              {payload.dominoes.map((d, i) => (
                <Fragment key={d.id}>
                  {i > 0 && <DominoArrow />}
                  <DominoCard d={d} index={i} />
                </Fragment>
              ))}
            </div>

            {/* Completed Months Supply — methodological refinement of the
                classic months-supply leading indicator. Sits below the dominoes
                because it's a deeper-dive read for users who want the corrected
                signal that explains the 2022 false alarm. */}
            {payload.completedMonthsSupply && (
              <CompletedMonthsSupplySection cms={payload.completedMonthsSupply} />
            )}

            {/* Footer note — single line */}
            <div
              style={{
                color: "rgba(180,180,200,0.4)",
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 11,
                lineHeight: 1.5,
                marginTop: 4,
              }}
            >
              FRED data · "fallen" = ≥3 months past peak, ≥5% below peak, 3-mo trend negative
            </div>
          </div>
          );
        })()}
      </div>
    </div>
  );
}
