import { useCallback, useMemo, useState } from "react";
import {
  useGetGli,
  useRefreshGli,
  getGetGliQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import type {
  GliPayload,
  GliComponent,
  GliPoint,
  NberRecessionInterval,
} from "@workspace/api-client-react";
import TopBar from "@/components/TopBar";
import { useToast } from "@/hooks/use-toast";

// ─── Status colors ────────────────────────────────────────────────────────────

const STATUS_COLORS: Record<
  string,
  { fg: string; bg: string; border: string; dot: string; soft: string }
> = {
  expanding: {
    fg: "rgba(180,220,200,0.95)",
    bg: "hsl(160 30% 12% / 0.5)",
    border: "rgba(80,180,140,0.45)",
    dot: "#10B981",
    soft: "rgba(16,185,129,0.14)",
  },
  stalling: {
    fg: "rgba(255,210,140,0.95)",
    bg: "hsl(35 60% 12% / 0.55)",
    border: "rgba(245,160,40,0.45)",
    dot: "#F59E0B",
    soft: "rgba(245,158,11,0.14)",
  },
  contracting: {
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

function fmtNum(n: number | null | undefined, digits = 2): string {
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

function fmtWeekly(unix: number): string {
  return new Date(unix * 1000).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// ─── Component row ────────────────────────────────────────────────────────────

function ComponentRow({ c }: { c: GliComponent }) {
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
    <tr data-testid={`gli-component-${c.id}`}>
      <td
        style={{
          ...cellStyle,
          fontFamily: "'Inter', sans-serif",
          fontSize: 14,
          fontWeight: 600,
          color: "rgba(230,235,245,0.98)",
          letterSpacing: "-0.01em",
          whiteSpace: "normal",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
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
          {!c.available && (
            <span
              style={{
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                color: "rgba(255,210,140,0.9)",
                background: "hsl(35 50% 12% / 0.55)",
                border: "1px solid rgba(245,158,11,0.4)",
                padding: "2px 6px",
                borderRadius: 4,
                fontFamily: "'JetBrains Mono', monospace",
              }}
            >
              excluded
            </span>
          )}
        </div>
        {c.note && (
          <div
            style={{
              marginTop: 4,
              fontSize: 11,
              fontWeight: 400,
              color: "rgba(180,180,200,0.6)",
              fontFamily: "'Inter', sans-serif",
              maxWidth: 560,
              lineHeight: 1.4,
            }}
          >
            {c.note}
          </div>
        )}
      </td>
      <td style={numCell}>
        {c.latestUsdTrillions != null ? `$${fmtNum(c.latestUsdTrillions, 2)}T` : "—"}
      </td>
      <td style={{ ...numCell, color: colorFor(c.mom4wPct), fontWeight: 600 }}>
        {fmtPct(c.mom4wPct)}
      </td>
      <td style={{ ...numCell, color: colorFor(c.weeklyContributionUsdB), fontWeight: 600 }}>
        {c.weeklyContributionUsdB != null
          ? `${c.weeklyContributionUsdB > 0 ? "+" : ""}$${fmtNum(c.weeklyContributionUsdB, 1)}B`
          : "—"}
      </td>
    </tr>
  );
}

// ─── Main chart: GLI (lagged) overlaid on BTC + SPX ───────────────────────────

interface MainChartProps {
  gli: GliPoint[];
  btc: GliPoint[];
  spx: GliPoint[];
  recessions: NberRecessionInterval[];
  lagDays: number;
  width?: number;
  height?: number;
}

function MainChart({ gli, btc, spx, recessions, lagDays, width = 1180, height = 380 }: MainChartProps) {
  if (gli.length < 2) {
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
        no GLI history
      </div>
    );
  }

  const padL = 64;
  const padR = 64;
  const padT = 20;
  const padB = 28;
  const innerW = width - padL - padR;
  const innerH = height - padT - padB;

  const lagSec = lagDays * 24 * 3600;
  const gliShifted = gli.map((p) => ({ time: p.time + lagSec, value: p.value }));

  // X domain: union of price series (BTC starts later, so use min(BTC start, gliShifted start))
  const allTimes = [
    gliShifted[0].time,
    gliShifted[gliShifted.length - 1].time,
    ...(btc.length > 0 ? [btc[0].time, btc[btc.length - 1].time] : []),
    ...(spx.length > 0 ? [spx[0].time, spx[spx.length - 1].time] : []),
  ];
  const t0 = Math.min(...allTimes);
  const t1 = Math.max(...allTimes);
  const span = Math.max(1, t1 - t0);
  const x = (t: number) => padL + ((t - t0) / span) * innerW;

  // Left axis: GLI ($T). Right axis: BTC + SPX normalized to [0,1] each then plotted in log shape.
  const gliVals = gliShifted.map((p) => p.value);
  const gliMin = Math.min(...gliVals);
  const gliMax = Math.max(...gliVals);
  const gliPad = (gliMax - gliMin) * 0.08;
  const gMin = gliMin - gliPad;
  const gMax = gliMax + gliPad;
  const yGli = (v: number) =>
    padT + (1 - (v - gMin) / Math.max(0.0001, gMax - gMin)) * innerH;

  // BTC: log scale. SPX: log scale. Normalize each to [padT, padT+innerH].
  function logNorm(series: GliPoint[]): (v: number) => number {
    if (series.length === 0) return () => padT;
    const vals = series.map((p) => Math.log(Math.max(0.0001, p.value)));
    const mn = Math.min(...vals);
    const mx = Math.max(...vals);
    return (raw: number) => {
      const lv = Math.log(Math.max(0.0001, raw));
      return padT + (1 - (lv - mn) / Math.max(0.0001, mx - mn)) * innerH;
    };
  }
  const yBtc = logNorm(btc);
  const ySpx = logNorm(spx);

  function pathFor(series: GliPoint[], yFn: (v: number) => number): string {
    return series
      .filter((p) => p.time >= t0 && p.time <= t1)
      .map((p, i) => `${i === 0 ? "M" : "L"}${x(p.time).toFixed(1)},${yFn(p.value).toFixed(1)}`)
      .join(" ");
  }

  const gliPath = pathFor(gliShifted, yGli);
  const btcPath = pathFor(btc, yBtc);
  const spxPath = pathFor(spx, ySpx);

  // Y-axis ticks for GLI
  const yTicks: number[] = [];
  const step = (gMax - gMin) / 5;
  for (let i = 0; i <= 5; i++) yTicks.push(gMin + step * i);

  // Year ticks
  const startYear = new Date(t0 * 1000).getUTCFullYear();
  const endYear = new Date(t1 * 1000).getUTCFullYear();
  const yearStep = endYear - startYear > 18 ? 4 : endYear - startYear > 9 ? 2 : 1;
  const yearTicks: number[] = [];
  for (let y = Math.ceil(startYear / yearStep) * yearStep; y <= endYear; y += yearStep) {
    yearTicks.push(y);
  }
  const tickX = (year: number) =>
    x(Math.floor(new Date(`${year}-01-01T00:00:00Z`).getTime() / 1000));

  return (
    <svg
      width="100%"
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      style={{ display: "block" }}
      data-testid="gli-chart"
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

      {/* Y grid (GLI scale) */}
      {yTicks.map((v, i) => (
        <g key={i}>
          <line
            x1={padL}
            x2={width - padR}
            y1={yGli(v)}
            y2={yGli(v)}
            stroke="rgba(180,180,200,0.08)"
            strokeWidth={0.75}
            strokeDasharray="2 4"
          />
          <text
            x={padL - 8}
            y={yGli(v) + 3}
            textAnchor="end"
            fontSize={10}
            fontFamily="'JetBrains Mono', monospace"
            fill="rgba(140,180,200,0.65)"
          >
            ${v.toFixed(1)}T
          </text>
        </g>
      ))}

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

      {/* SPX path */}
      {spx.length > 1 && (
        <path d={spxPath} fill="none" stroke="rgba(180,180,200,0.45)" strokeWidth={1.2} />
      )}

      {/* BTC path */}
      {btc.length > 1 && (
        <path d={btcPath} fill="none" stroke="rgba(247,147,26,0.85)" strokeWidth={1.4} />
      )}

      {/* GLI path (lagged) */}
      <path d={gliPath} fill="none" stroke="hsl(195 90% 65%)" strokeWidth={2} />

      {/* Right axis label */}
      <text
        x={width - padR + 8}
        y={padT + 12}
        fontSize={10}
        fontFamily="'JetBrains Mono', monospace"
        fill="rgba(247,147,26,0.85)"
      >
        BTC / SPX (log)
      </text>
    </svg>
  );
}

// ─── Sparkline (single series) ────────────────────────────────────────────────

function Sparkline({
  series,
  color,
  width = 200,
  height = 56,
}: {
  series: GliPoint[];
  color: string;
  width?: number;
  height?: number;
}) {
  if (series.length < 2) {
    return (
      <div
        style={{
          height,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "rgba(180,180,200,0.4)",
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 10,
        }}
      >
        —
      </div>
    );
  }
  const padX = 4;
  const padY = 8;
  const innerW = width - padX * 2;
  const innerH = height - padY * 2;
  const vals = series.map((p) => p.value);
  const mn = Math.min(...vals, 0);
  const mx = Math.max(...vals, 0);
  const rng = Math.max(0.0001, mx - mn);
  const x = (i: number) => padX + (i / (series.length - 1)) * innerW;
  const y = (v: number) => padY + (1 - (v - mn) / rng) * innerH;
  const path = series
    .map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`)
    .join(" ");
  const yZero = y(0);
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      {mn < 0 && mx > 0 && (
        <line
          x1={padX}
          x2={width - padX}
          y1={yZero}
          y2={yZero}
          stroke="rgba(180,180,200,0.25)"
          strokeWidth={0.75}
          strokeDasharray="2 3"
        />
      )}
      <path d={path} fill="none" stroke={color} strokeWidth={1.5} />
    </svg>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function GliPage() {
  const queryClient = useQueryClient();
  const { data, isLoading, error: _error, isError } = useGetGli();
  const refresh = useRefreshGli();
  const { toast } = useToast();
  const payload = data as GliPayload | undefined;
  const noData = !isLoading && !payload;

  const [lagDays, setLagDays] = useState<number>(payload?.defaultLagDays ?? 75);

  const onRefresh = useCallback(async () => {
    try {
      const fresh = await refresh.mutateAsync();
      queryClient.setQueryData(getGetGliQueryKey(), fresh);
      queryClient.invalidateQueries({ queryKey: getGetGliQueryKey() });
      toast({ title: "Global Liquidity Index refreshed" });
    } catch (err) {
      toast({
        title: "Refresh failed",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    }
  }, [refresh, queryClient, toast]);

  const headlineColors = useMemo(() => {
    const status = payload?.status ?? "insufficient";
    return STATUS_COLORS[status] ?? STATUS_COLORS.insufficient;
  }, [payload?.status]);

  const lagPresets = payload?.lagPresets?.length ? payload.lagPresets : [56, 60, 75];

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "hsl(230 14% 6%)",
        color: "rgba(220,225,235,0.9)",
        display: "flex",
        flexDirection: "column",
      }}
      data-testid="gli-page"
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
          Loading from database…
        </div>
      )}

      {noData && (
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            textAlign: "center",
            padding: "0 16px",
          }}
        >
          <span style={{ color: "rgba(220,225,235,0.85)", fontFamily: "'Inter', sans-serif", fontSize: 14 }}>
            {isError ? "No GLI data in the database yet." : "No GLI data."}
          </span>
          <span style={{ color: "rgba(200,200,220,0.5)", fontFamily: "'JetBrains Mono', monospace", fontSize: 11 }}>
            Click Refresh to load fresh data from FRED + Yahoo.
          </span>
        </div>
      )}

      {payload && (
        <div
          style={{
            padding: "clamp(12px, 3vw, 20px) clamp(12px, 3vw, 24px) clamp(20px, 4vw, 32px)",
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
                  Global Liquidity Index ·{" "}
                  {payload.latestTime ? fmtWeekly(payload.latestTime) : "—"}
                </div>
                <div
                  style={{
                    fontSize: "clamp(20px, 5vw, 28px)",
                    fontWeight: 700,
                    color: "rgba(230,235,245,0.98)",
                    letterSpacing: "-0.02em",
                    fontFamily: "'Inter', sans-serif",
                  }}
                  data-testid="gli-title"
                >
                  Fed (net of TGA + RRP) + ECB + BoJ, in USD
                </div>
                <div
                  style={{
                    fontSize: 13,
                    color: "rgba(180,180,200,0.65)",
                    maxWidth: 760,
                    lineHeight: 1.45,
                  }}
                >
                  Net central-bank money in the system. Risk assets — especially BTC —
                  tend to follow with a ~2-month lag. Direction and acceleration matter
                  more than the absolute level.
                </div>
              </div>
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "flex-end",
                  gap: 8,
                  minWidth: 0,
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
                  data-testid="gli-status"
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
                    fontSize: "clamp(32px, 8vw, 48px)",
                    fontWeight: 700,
                    fontFamily: "'JetBrains Mono', monospace",
                    color: headlineColors.fg,
                    letterSpacing: "-0.02em",
                    lineHeight: 1,
                  }}
                  data-testid="gli-headline"
                >
                  {payload.latestGliUsdT != null
                    ? `$${fmtNum(payload.latestGliUsdT, 2)}T`
                    : "—"}
                </div>
                <div
                  style={{
                    fontSize: 11,
                    color: "rgba(180,180,200,0.55)",
                    fontFamily: "'JetBrains Mono', monospace",
                  }}
                >
                  MoM {fmtPct(payload.mom4wPct)} · YoY {fmtPct(payload.yoyPct)} ·
                  13w ann {fmtPct(payload.roc13wAnnPct)}
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
              data-testid="gli-blurb"
            >
              {payload.statusBlurb}
            </div>
          </section>

          {/* Main chart */}
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
                flexWrap: "wrap",
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
                GLI (shifted +{lagDays}d) vs BTC + S&P 500
              </div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
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
                      width: 14,
                      height: 2,
                      background: "hsl(195 90% 65%)",
                      marginRight: 6,
                      verticalAlign: "middle",
                    }}
                  />
                  GLI (left)
                </span>
                <span>
                  <span
                    style={{
                      display: "inline-block",
                      width: 14,
                      height: 2,
                      background: "rgba(247,147,26,0.85)",
                      marginRight: 6,
                      verticalAlign: "middle",
                    }}
                  />
                  BTC (right, log)
                </span>
                <span>
                  <span
                    style={{
                      display: "inline-block",
                      width: 14,
                      height: 2,
                      background: "rgba(180,180,200,0.45)",
                      marginRight: 6,
                      verticalAlign: "middle",
                    }}
                  />
                  S&P 500 (right, log)
                </span>
              </div>
            </div>

            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                flexWrap: "wrap",
              }}
            >
              <span
                style={{
                  fontSize: 10,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  color: "rgba(180,180,200,0.55)",
                  fontFamily: "'JetBrains Mono', monospace",
                }}
              >
                Lag
              </span>
              {lagPresets.map((p) => {
                const active = p === lagDays;
                return (
                  <button
                    key={p}
                    onClick={() => setLagDays(p)}
                    data-testid={`gli-lag-${p}`}
                    style={{
                      padding: "4px 10px",
                      borderRadius: 6,
                      background: active
                        ? "hsl(195 60% 18% / 0.6)"
                        : "hsl(230 12% 12%)",
                      color: active ? "hsl(195 90% 75%)" : "rgba(220,225,235,0.7)",
                      border: `1px solid ${
                        active ? "hsl(195 60% 35%)" : "hsl(230 10% 18%)"
                      }`,
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 11,
                      cursor: "pointer",
                    }}
                  >
                    {p}d
                  </button>
                );
              })}
              <input
                type="range"
                min={0}
                max={180}
                step={1}
                value={lagDays}
                onChange={(e) => setLagDays(Number(e.target.value))}
                style={{ flex: 1, minWidth: 160, maxWidth: 360, accentColor: "hsl(195 90% 65%)" }}
                data-testid="gli-lag-slider"
              />
              <span
                style={{
                  fontSize: 11,
                  color: "rgba(180,180,200,0.55)",
                  fontFamily: "'JetBrains Mono', monospace",
                }}
              >
                {lagDays} days
              </span>
            </div>

            <MainChart
              gli={payload.history}
              btc={payload.btcHistory}
              spx={payload.spxHistory}
              recessions={payload.nberRecessions}
              lagDays={lagDays}
            />
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
                flexWrap: "wrap",
                gap: "4px 12px",
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
                Components · latest week
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: "rgba(180,180,200,0.55)",
                  fontFamily: "'JetBrains Mono', monospace",
                }}
              >
                Converted to USD at the latest weekly FX print
              </div>
            </div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    {["Component", "Latest", "4w change", "Weekly Δ"].map((h, i) => (
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

          {/* Rate-of-change panel */}
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
                flexWrap: "wrap",
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
                Rate of change · what BTC actually tracks
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: "rgba(180,180,200,0.55)",
                  fontFamily: "'JetBrains Mono', monospace",
                }}
              >
                Annualized %
              </div>
            </div>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              <div
                style={{
                  flex: "1 1 280px",
                  padding: 16,
                  borderRadius: 10,
                  background: "hsl(230 12% 11% / 0.6)",
                  border: "1px solid hsl(230 10% 16%)",
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
                  13-week annualized
                </div>
                <div
                  style={{
                    fontSize: 26,
                    fontWeight: 700,
                    fontFamily: "'JetBrains Mono', monospace",
                    color:
                      payload.roc13wAnnPct != null && payload.roc13wAnnPct < 0
                        ? "rgba(255,170,170,0.95)"
                        : "rgba(180,220,200,0.95)",
                    marginTop: 4,
                  }}
                >
                  {fmtPct(payload.roc13wAnnPct, 1)}
                </div>
                <Sparkline series={payload.rocAnn13wHistory} color="hsl(195 90% 65%)" />
              </div>
              <div
                style={{
                  flex: "1 1 280px",
                  padding: 16,
                  borderRadius: 10,
                  background: "hsl(230 12% 11% / 0.6)",
                  border: "1px solid hsl(230 10% 16%)",
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
                  26-week annualized
                </div>
                <div
                  style={{
                    fontSize: 26,
                    fontWeight: 700,
                    fontFamily: "'JetBrains Mono', monospace",
                    color:
                      payload.roc26wAnnPct != null && payload.roc26wAnnPct < 0
                        ? "rgba(255,170,170,0.95)"
                        : "rgba(180,220,200,0.95)",
                    marginTop: 4,
                  }}
                >
                  {fmtPct(payload.roc26wAnnPct, 1)}
                </div>
                <Sparkline series={payload.rocAnn26wHistory} color="hsl(280 60% 70%)" />
              </div>
            </div>
            <div
              style={{
                fontSize: 12,
                color: "rgba(180,180,200,0.65)",
                lineHeight: 1.5,
              }}
            >
              BTC tracks the <em>acceleration</em> of liquidity, not the level. A
              positive 13w that's turning higher is the bullish signature; turning
              lower while still positive is the early warning.
            </div>
          </section>

          {/* DXY context strip */}
          <section
            style={{
              padding: 18,
              borderRadius: 12,
              background: "hsl(230 14% 9%)",
              border: "1px solid hsl(230 10% 14%)",
              display: "flex",
              alignItems: "center",
              gap: 18,
              flexWrap: "wrap",
            }}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 160 }}>
              <span
                style={{
                  fontSize: 10,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  color: "rgba(180,180,200,0.55)",
                  fontFamily: "'JetBrains Mono', monospace",
                }}
              >
                DXY (broad)
              </span>
              <span
                style={{
                  fontSize: 22,
                  fontWeight: 700,
                  fontFamily: "'JetBrains Mono', monospace",
                  color: "rgba(230,235,245,0.98)",
                }}
                data-testid="gli-dxy-latest"
              >
                {payload.dxyLatest != null ? fmtNum(payload.dxyLatest, 2) : "—"}
              </span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 140 }}>
              <span
                style={{
                  fontSize: 10,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  color: "rgba(180,180,200,0.55)",
                  fontFamily: "'JetBrains Mono', monospace",
                }}
              >
                13w change
              </span>
              <span
                style={{
                  fontSize: 22,
                  fontWeight: 700,
                  fontFamily: "'JetBrains Mono', monospace",
                  color:
                    payload.dxyChange13wPct != null && payload.dxyChange13wPct < 0
                      ? "rgba(180,220,200,0.95)"
                      : "rgba(255,210,140,0.95)",
                }}
              >
                {fmtPct(payload.dxyChange13wPct, 1)}
              </span>
            </div>
            <div
              style={{
                flex: 1,
                minWidth: 240,
                fontSize: 13,
                color: "rgba(220,225,235,0.85)",
                lineHeight: 1.5,
              }}
              data-testid="gli-dxy-blurb"
            >
              {payload.dxyBlurb}
            </div>
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
                lineHeight: 1.6,
              }}
              data-testid="gli-notes"
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
            Data: FRED (WALCL, WTREGEN, RRPONTSYD, ECBASSETSW, JPNASSETS, DEXUSEU,
            DEXJPUS, DTWEXBGS) + Yahoo (BTC-USD, ^GSPC) ·{" "}
            {payload.lastUpdated ? `updated ${fmtTimestamp(payload.lastUpdated)}` : ""}
          </div>
        </div>
      )}
    </div>
  );
}
