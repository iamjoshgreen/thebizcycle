import { useCallback } from "react";
import { useGetRateShock, useRefreshRateShock, getGetRateShockQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import type {
  RateShockPayload,
  RateShockPoint,
  RateShockEpisode,
  RateShockTrigger,
  NberRecessionInterval,
} from "@workspace/api-client-react";
import TopBar from "@/components/TopBar";
import { useToast } from "@/hooks/use-toast";

// ─── Status colors ────────────────────────────────────────────────────────────

const STATUS_COLORS: Record<
  string,
  { fg: string; bg: string; border: string; dot: string; soft: string }
> = {
  calm: {
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
  shock: {
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

const CARD: React.CSSProperties = {
  background: "hsl(230 14% 9% / 0.45)",
  border: "1px solid hsl(230 10% 16%)",
  borderRadius: 10,
};

const EYEBROW: React.CSSProperties = {
  color: "rgba(180,180,200,0.5)",
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: 11,
  letterSpacing: "0.12em",
};

const CARD_TITLE: React.CSSProperties = {
  color: "rgba(225,230,240,0.95)",
  fontFamily: "'Inter', sans-serif",
  fontSize: 15,
  fontWeight: 600,
  letterSpacing: "-0.01em",
};

function statusForBp(bp: number, warn: number, shock: number): string {
  if (bp >= shock) return "shock";
  if (bp >= warn) return "warning";
  return "calm";
}

// ─── Formatters ───────────────────────────────────────────────────────────────

function fmtDay(ts: number | null | undefined, withYear = true): string {
  if (ts == null) return "—";
  return new Date(ts * 1000).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: withYear ? "numeric" : undefined,
    timeZone: "UTC",
  });
}

function fmtMonth(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString("en-US", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

function fmtBp(n: number | null | undefined): string {
  if (n == null || !isFinite(n)) return "—";
  return `${n > 0 ? "+" : ""}${n}bp`;
}

function fmtYield(n: number | null | undefined): string {
  if (n == null || !isFinite(n)) return "—";
  return `${n.toFixed(2)}%`;
}

// ─── Progress gauge ───────────────────────────────────────────────────────────

function Gauge({ value, warn, shock }: { value: number; warn: number; shock: number }) {
  const max = Math.max(shock * 1.5, value);
  const pct = (v: number) => `${(Math.max(0, Math.min(v, max)) / max) * 100}%`;
  const c = STATUS_COLORS[statusForBp(value, warn, shock)];
  return (
    <div style={{ marginTop: 14 }} data-testid="shock-gauge">
      <div
        style={{
          position: "relative",
          height: 10,
          borderRadius: 5,
          background: "hsl(230 12% 14%)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            bottom: 0,
            width: pct(value),
            background: c.dot,
            borderRadius: 5,
          }}
        />
        {[warn, shock].map((m) => (
          <div
            key={m}
            style={{
              position: "absolute",
              left: pct(m),
              top: 0,
              bottom: 0,
              width: 2,
              background: "#0A0A0D",
            }}
          />
        ))}
      </div>
      <div
        style={{
          position: "relative",
          height: 16,
          marginTop: 4,
          color: "rgba(180,180,200,0.55)",
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 10,
        }}
      >
        <span style={{ position: "absolute", left: 0 }}>0</span>
        <span style={{ position: "absolute", left: pct(warn), transform: "translateX(-50%)" }}>
          +{warn} warn
        </span>
        <span style={{ position: "absolute", left: pct(shock), transform: "translateX(-50%)" }}>
          +{shock} shock
        </span>
      </div>
    </div>
  );
}

// ─── Trigger strip ────────────────────────────────────────────────────────────

const HORIZON_LABEL: Record<number, string> = {
  1: "Next trading day",
  5: "In 1 week",
  10: "In 2 weeks",
  21: "In 1 month",
};

function TriggerCell({ t, latestYield }: { t: RateShockTrigger; latestYield: number | null }) {
  const gapBp = latestYield != null ? Math.round((t.triggerYield - latestYield) * 100) : null;
  return (
    <div style={{ ...CARD, borderRadius: 8, padding: "12px 14px" }}>
      <div style={EYEBROW}>{(HORIZON_LABEL[t.tradingDaysAhead] ?? `+${t.tradingDaysAhead}d`).toUpperCase()}</div>
      <div
        style={{
          color: "rgba(235,240,250,0.95)",
          fontFamily: "'Inter', sans-serif",
          fontSize: 26,
          fontWeight: 700,
          letterSpacing: "-0.02em",
          marginTop: 4,
        }}
      >
        {fmtYield(t.triggerYield)}
      </div>
      <div
        style={{
          color: "rgba(180,185,200,0.7)",
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 11,
          marginTop: 4,
          lineHeight: 1.5,
        }}
      >
        <div>~{fmtDay(t.approxDate, false)} · {gapBp != null ? (gapBp > 0 ? `${gapBp}bp above today` : "already above") : "—"}</div>
        <div style={{ color: "rgba(180,180,200,0.45)" }}>
          base {fmtYield(t.baseYield)} on {fmtDay(t.baseTime, false)}
        </div>
      </div>
    </div>
  );
}

// ─── History chart (3-month change, bp) ───────────────────────────────────────

interface ChangeChartProps {
  history: RateShockPoint[];
  episodes: RateShockEpisode[];
  recessions: NberRecessionInterval[];
  warn: number;
  shock: number;
  width?: number;
  height?: number;
}

function ChangeChart({ history, episodes, recessions, warn, shock, width = 1200, height = 320 }: ChangeChartProps) {
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

  // The early-1980s swings (+314bp up, -400bp+ down) would squash the warning
  // and shock bands into slivers, so the axis is clamped and extremes are
  // drawn pinned to the edge.
  const values = history.map((p) => p.value);
  const yMin = Math.max(-200, Math.floor(Math.min(...values) / 50) * 50);
  const yMax = Math.max(shock + 50, Math.min(250, Math.ceil(Math.max(...values) / 50) * 50));
  const yRange = yMax - yMin || 1;

  const x = (t: number) => padL + ((t - xMin) / xRange) * (width - padL - padR);
  const y = (v: number) => {
    const c = Math.max(yMin, Math.min(yMax, v));
    return padT + ((yMax - c) / yRange) * (height - padT - padB);
  };

  const linePath = history
    .map((p, i) => `${i === 0 ? "M" : "L"} ${x(p.time).toFixed(2)} ${y(p.value).toFixed(2)}`)
    .join(" ");

  const bands = [
    { from: yMin, to: warn, color: "rgba(16,185,129,0.07)" },
    { from: warn, to: shock, color: "rgba(245,158,11,0.10)" },
    { from: shock, to: yMax, color: "rgba(239,68,68,0.10)" },
  ];

  const yTicks: number[] = [];
  for (let v = Math.ceil(yMin / 100) * 100; v <= yMax; v += 100) yTicks.push(v);

  const startYear = new Date(xMin * 1000).getUTCFullYear();
  const endYear = new Date(xMax * 1000).getUTCFullYear();
  const xTicks: { x: number; label: string }[] = [];
  for (let yr = Math.ceil(startYear / 10) * 10; yr <= endYear; yr += 10) {
    const ts = Math.floor(Date.UTC(yr, 0, 1) / 1000);
    if (ts < xMin || ts > xMax) continue;
    xTicks.push({ x: x(ts), label: String(yr) });
  }

  const last = history[history.length - 1];
  const currentColor = STATUS_COLORS[statusForBp(last.value, warn, shock)].dot;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      style={{ display: "block", width: "100%", height }}
    >
      {bands.map((b, i) => (
        <rect
          key={i}
          x={padL}
          y={y(b.to)}
          width={width - padL - padR}
          height={Math.abs(y(b.from) - y(b.to))}
          fill={b.color}
        />
      ))}

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

      {yTicks.map((v) => (
        <g key={v}>
          <line
            x1={padL}
            x2={width - padR}
            y1={y(v)}
            y2={y(v)}
            stroke={v === 0 ? "rgba(255,255,255,0.12)" : "rgba(255,255,255,0.04)"}
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
            {v > 0 ? `+${v}` : v}
          </text>
        </g>
      ))}

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

      <line
        x1={padL}
        x2={width - padR}
        y1={y(warn)}
        y2={y(warn)}
        stroke="rgba(245,158,11,0.4)"
        strokeWidth={1}
        strokeDasharray="3 3"
      />
      <line
        x1={padL}
        x2={width - padR}
        y1={y(shock)}
        y2={y(shock)}
        stroke="rgba(239,68,68,0.5)"
        strokeWidth={1}
        strokeDasharray="3 3"
      />

      <path
        d={linePath}
        fill="none"
        stroke="rgba(230,235,245,0.85)"
        strokeWidth={1.2}
        strokeLinejoin="round"
        strokeLinecap="round"
      />

      {/* Past shock episodes — marked at their peak rise */}
      {episodes
        .filter((e) => !e.active)
        .map((e) => (
          <circle
            key={e.peakTime}
            cx={x(e.peakTime)}
            cy={y(e.peakChangeBp)}
            r={4}
            fill="none"
            stroke={STATUS_COLORS.shock.dot}
            strokeWidth={1.5}
          />
        ))}

      <circle cx={x(last.time)} cy={y(last.value)} r={7} fill={currentColor} opacity={0.22} />
      <circle cx={x(last.time)} cy={y(last.value)} r={3.5} fill={currentColor} />

      {/* "Now" callout — the latest point is always at the right edge, so the
          label sits to the left of the dot. */}
      {(() => {
        const dotX = x(last.time);
        const dotY = y(last.value);
        const labelText = `${fmtBp(last.value)} now`;
        const labelW = labelText.length * 6.6 + 14;
        const lineX2 = dotX - 18;
        const lineY2 = Math.max(padT + 12, dotY - 18);
        const rectX = Math.max(padL, lineX2 - 6 - labelW);
        return (
          <g>
            <line x1={dotX} y1={dotY} x2={lineX2} y2={lineY2} stroke={currentColor} strokeWidth={1} opacity={0.7} />
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
              x={rectX + labelW - 6}
              y={lineY2 + 4}
              textAnchor="end"
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

// ─── 10Y level context chart ──────────────────────────────────────────────────

function YieldChart({
  data,
  recessions,
  width = 1200,
  height = 130,
}: {
  data: RateShockPoint[];
  recessions: NberRecessionInterval[];
  width?: number;
  height?: number;
}) {
  if (data.length < 2) return null;

  const padL = 56;
  const padR = 16;
  const padT = 12;
  const padB = 22;

  const xMin = data[0].time;
  const xMax = data[data.length - 1].time;
  const xRange = xMax - xMin || 1;
  const yMin = 0;
  const yMax = Math.ceil(Math.max(...data.map((p) => p.value)));
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
      {[yMin, Math.round(yMax / 2), yMax].map((v) => (
        <text
          key={v}
          x={padL - 8}
          y={y(v) + 3}
          textAnchor="end"
          fill="rgba(180,180,200,0.5)"
          fontFamily="'JetBrains Mono', monospace"
          fontSize={10}
        >
          {v}%
        </text>
      ))}
      <path
        d={linePath}
        fill="none"
        stroke="rgba(96,165,250,0.85)"
        strokeWidth={1.3}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={x(last.time)} cy={y(last.value)} r={3} fill="rgba(96,165,250,1)" />
    </svg>
  );
}

// ─── Episodes table ───────────────────────────────────────────────────────────

function EpisodeRow({ e }: { e: RateShockEpisode }) {
  const cellStyle: React.CSSProperties = {
    padding: "11px 14px",
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 13,
    color: "rgba(220,225,235,0.9)",
    borderBottom: "1px solid hsl(230 10% 14%)",
    whiteSpace: "nowrap",
  };
  return (
    <tr
      data-testid={`episode-row-${e.peakTime}`}
      style={e.active ? { background: STATUS_COLORS.shock.soft } : undefined}
    >
      <td style={{ ...cellStyle, fontFamily: "'Inter', sans-serif", fontSize: 14, fontWeight: 600 }}>
        {fmtMonth(e.peakTime)}
        {e.active && (
          <span
            style={{
              marginLeft: 8,
              padding: "2px 6px",
              borderRadius: 4,
              border: `1px solid ${STATUS_COLORS.shock.border}`,
              color: STATUS_COLORS.shock.fg,
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: "0.08em",
            }}
          >
            NOW
          </span>
        )}
      </td>
      <td style={{ ...cellStyle, textAlign: "right", color: STATUS_COLORS.shock.fg, fontWeight: 600 }}>
        {fmtBp(e.peakChangeBp)}
      </td>
      <td style={{ ...cellStyle, textAlign: "right" }}>
        {fmtYield(e.fromYield)} → {fmtYield(e.toYield)}
      </td>
      <td
        style={{
          ...cellStyle,
          fontFamily: "'Inter', sans-serif",
          whiteSpace: "normal",
          minWidth: 240,
          color: e.context ? "rgba(220,225,235,0.9)" : "rgba(180,180,200,0.4)",
        }}
      >
        {e.context ?? "Nothing obvious broke"}
      </td>
    </tr>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function RateShockPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data, isLoading, isError } = useGetRateShock();
  const refreshMutation = useRefreshRateShock();

  const handleRefresh = useCallback(() => {
    refreshMutation.mutate(undefined, {
      onSuccess: (fresh) => {
        queryClient.setQueryData(getGetRateShockQueryKey(), fresh);
        queryClient.invalidateQueries({ queryKey: getGetRateShockQueryKey() });
      },
      onError: (err) =>
        toast({
          title: "Refresh failed",
          description: err instanceof Error ? err.message : "Could not reach FRED",
          variant: "destructive",
        }),
    });
  }, [refreshMutation, queryClient, toast]);

  const payload: RateShockPayload | undefined = data as RateShockPayload | undefined;
  const noData = !isLoading && !payload;
  const c = STATUS_COLORS[payload?.status ?? "insufficient"] ?? STATUS_COLORS.insufficient;
  const pastEpisodes = payload?.episodes.filter((e) => !e.active).length ?? 0;

  return (
    <div className="flex flex-col w-full h-full overflow-hidden" style={{ background: "#0A0A0D" }}>
      <TopBar
        lastUpdated={payload?.lastUpdated ?? null}
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
            <span style={{ color: "hsl(220 10% 40%)", fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}>
              Loading from database…
            </span>
          </div>
        )}

        {noData && (
          <div className="flex flex-col items-center justify-center gap-2 py-20 text-center">
            <span style={{ color: "rgba(220,225,235,0.85)", fontFamily: "'Inter', sans-serif", fontSize: 14 }}>
              {isError ? "No rate shock data in the database yet." : "No rate shock data."}
            </span>
            <span style={{ color: "rgba(200,200,220,0.5)", fontFamily: "'JetBrains Mono', monospace", fontSize: 11 }}>
              Click Refresh to load fresh data from FRED.
            </span>
          </div>
        )}

        {payload && (
          <div style={{ display: "flex", flexDirection: "column", gap: 24, maxWidth: 1600, margin: "0 auto" }}>
            {/* ── Headline ───────────────────────────────────── */}
            <div
              style={{
                background: c.bg,
                border: `1px solid ${c.border}`,
                borderRadius: 12,
                padding: "clamp(16px, 4vw, 26px) clamp(16px, 4vw, 30px)",
                display: "flex",
                gap: "clamp(14px, 3vw, 32px)",
                alignItems: "center",
                flexWrap: "wrap",
              }}
              data-testid="rate-shock-headline"
            >
              <div style={{ flex: "0 1 auto", minWidth: 0, maxWidth: "100%" }}>
                <div style={EYEBROW}>10-YEAR YIELD · 3-MONTH CHANGE</div>
                <div
                  style={{
                    color: c.fg,
                    fontFamily: "'Inter', sans-serif",
                    fontSize: "clamp(40px, 11vw, 64px)",
                    fontWeight: 800,
                    letterSpacing: "-0.03em",
                    lineHeight: 1,
                    marginTop: 8,
                  }}
                  data-testid="rate-shock-value"
                >
                  {fmtBp(payload.change63dBp)}
                </div>
                <div
                  style={{
                    color: "rgba(180,180,200,0.55)",
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 11,
                    marginTop: 8,
                  }}
                >
                  {fmtYield(payload.baseYield)} → {fmtYield(payload.latestYield)} · {fmtDay(payload.baseTime, false)} →{" "}
                  {fmtDay(payload.latestTime, false)}
                </div>
              </div>
              <div style={{ flex: "1 1 260px", minWidth: 0 }}>
                <div
                  style={{
                    display: "inline-block",
                    background: c.dot,
                    color: "#0A0A0D",
                    fontFamily: "'Inter', sans-serif",
                    fontSize: 12,
                    fontWeight: 800,
                    letterSpacing: "0.06em",
                    padding: "5px 12px",
                    borderRadius: 4,
                    marginBottom: 12,
                  }}
                  data-testid="rate-shock-label"
                >
                  {payload.statusLabel.toUpperCase()}
                </div>
                <div
                  style={{
                    color: "rgba(235,240,250,0.95)",
                    fontFamily: "'Inter', sans-serif",
                    fontSize: 17,
                    fontWeight: 500,
                    lineHeight: 1.45,
                  }}
                  data-testid="rate-shock-translation"
                >
                  {payload.translation}
                </div>
                <div
                  style={{
                    color: "rgba(190,195,210,0.7)",
                    fontFamily: "'Inter', sans-serif",
                    fontSize: 13,
                    lineHeight: 1.5,
                    marginTop: 6,
                  }}
                >
                  {payload.blurb}
                </div>
                {payload.change63dBp != null && (
                  <Gauge
                    value={payload.change63dBp}
                    warn={payload.warnThresholdBp}
                    shock={payload.shockThresholdBp}
                  />
                )}
                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    gap: 18,
                    marginTop: 10,
                    color: "rgba(180,180,200,0.65)",
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 12,
                  }}
                >
                  <span>
                    Data as of <strong style={{ color: "rgba(220,225,235,0.9)" }}>{fmtDay(payload.latestTime)}</strong>
                  </span>
                  <span>1D {fmtBp(payload.change1dBp)}</span>
                  <span>1W {fmtBp(payload.change5dBp)}</span>
                  <span>1M {fmtBp(payload.change21dBp)}</span>
                </div>
              </div>
            </div>

            {/* ── Trigger levels ─────────────────────────────── */}
            {payload.triggers.length > 0 && (
              <div data-testid="trigger-levels">
                <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 10 }}>
                  <div style={CARD_TITLE}>
                    {payload.status === "shock" ? "10-year level that keeps it in shock pace" : "10-year level needed to hit shock pace"}
                  </div>
                  <div style={{ color: "rgba(180,185,200,0.7)", fontFamily: "'Inter', sans-serif", fontSize: 13 }}>
                    The 3-month lookback rolls forward every day, so the target moves with it. Each level is that
                    day's base + 1.00%.
                  </div>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 12 }}>
                  {payload.triggers.map((t) => (
                    <TriggerCell key={t.tradingDaysAhead} t={t} latestYield={payload.latestYield} />
                  ))}
                </div>
              </div>
            )}

            {/* ── Strategy explainer ────────────────────────── */}
            <div
              style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14 }}
              data-testid="strategy-explainer"
            >
              {[
                {
                  label: "WHAT",
                  title: "How fast the 10-year is rising",
                  body: `The change in the 10-year Treasury yield (DGS10) over the last ${payload.windowTradingDays} trading days (~3 months), in basis points. Speed, not level.`,
                },
                {
                  label: "WHY",
                  title: "Fast rate spikes break things",
                  body: "When borrowing costs jump quickly, trades and balance sheets built on stable rates unravel — banks, leveraged funds, housing. Past shocks preceded Penn Central, Continental Illinois, Black Monday, 1994's bond massacre and the 2022 gilt crisis.",
                },
                {
                  label: "HOW",
                  title: `Green < +${payload.warnThresholdBp} · Yellow · Red ≥ +${payload.shockThresholdBp}bp`,
                  body: `Shock pace is +${payload.shockThresholdBp}bp in 3 months. Since 1962 it happened ${pastEpisodes} times (one long rally counts once). It's not a timing tool — the lag to the accident ranged from weeks to years.`,
                },
              ].map((cell) => (
                <div key={cell.label} style={{ ...CARD, borderRadius: 8, padding: "14px 16px" }}>
                  <div style={EYEBROW}>{cell.label}</div>
                  <div style={{ ...CARD_TITLE, marginTop: 4 }}>{cell.title}</div>
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

            {/* ── History chart ─────────────────────────────── */}
            <div style={{ ...CARD, padding: "16px 18px" }} data-testid="rate-shock-chart">
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  justifyContent: "space-between",
                  flexWrap: "wrap",
                  gap: 8,
                  marginBottom: 8,
                }}
              >
                <div style={CARD_TITLE}>3-month change in the 10-year since 1962</div>
                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    gap: 14,
                    color: "rgba(180,180,200,0.55)",
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 11,
                  }}
                >
                  <LegendSwatch color="rgba(180,180,200,0.45)" label="NBER recession" />
                  <LegendSwatch color={STATUS_COLORS.warning.dot} label={`+${payload.warnThresholdBp} to +${payload.shockThresholdBp}bp`} />
                  <LegendSwatch color={STATUS_COLORS.shock.dot} label={`≥ +${payload.shockThresholdBp}bp`} />
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                    <span
                      style={{
                        display: "inline-block",
                        width: 9,
                        height: 9,
                        borderRadius: "50%",
                        border: `1.5px solid ${STATUS_COLORS.shock.dot}`,
                      }}
                    />
                    past shock
                  </span>
                </div>
              </div>
              <ChangeChart
                history={payload.history}
                episodes={payload.episodes}
                recessions={payload.nberRecessions}
                warn={payload.warnThresholdBp}
                shock={payload.shockThresholdBp}
              />
              <div
                style={{
                  marginTop: 8,
                  color: "rgba(180,180,200,0.55)",
                  fontFamily: "'Inter', sans-serif",
                  fontSize: 12,
                  lineHeight: 1.5,
                }}
              >
                Each red circle is a past rate shock. Notice how many sit just before a gray recession bar or a
                market accident. Axis is clipped at the extremes — the 1979–82 Volcker swings run off the chart.
              </div>
            </div>

            {/* ── 10Y level context ─────────────────────────── */}
            <div style={{ ...CARD, padding: "16px 18px" }} data-testid="yield-chart">
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  justifyContent: "space-between",
                  flexWrap: "wrap",
                  gap: 8,
                  marginBottom: 8,
                }}
              >
                <div style={{ ...CARD_TITLE, fontSize: 14 }}>Context: 10-Year Treasury yield (DGS10), level</div>
                <div style={{ color: "rgba(180,180,200,0.5)", fontFamily: "'JetBrains Mono', monospace", fontSize: 11 }}>
                  now {fmtYield(payload.latestYield)}
                </div>
              </div>
              <YieldChart data={payload.yieldHistory} recessions={payload.nberRecessions} />
            </div>

            {/* ── Episodes table ────────────────────────────── */}
            {payload.episodes.length > 0 && (
              <div style={{ ...CARD, overflow: "hidden" }} data-testid="episodes-table">
                <div style={{ padding: "14px 16px", borderBottom: "1px solid hsl(230 10% 14%)" }}>
                  <div style={CARD_TITLE}>Every rate shock since 1962</div>
                  <div
                    style={{
                      color: "rgba(180,180,200,0.5)",
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 11,
                      marginTop: 4,
                    }}
                  >
                    Peak = month of the largest 3-month rise · rallies less than 6 months apart count once
                  </div>
                </div>
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead>
                      <tr>
                        {["Peak", "3M rise", "10-year", "Around it"].map((h, i) => (
                          <th
                            key={h}
                            style={{
                              padding: "10px 14px",
                              textAlign: i === 1 || i === 2 ? "right" : "left",
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
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {[...payload.episodes].reverse().map((e) => (
                        <EpisodeRow key={e.peakTime} e={e} />
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

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
                <div style={{ color: "rgba(245,160,40,0.85)", fontWeight: 700, letterSpacing: "0.08em", marginBottom: 4 }}>
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
      <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, background: color }} />
      {label}
    </span>
  );
}
