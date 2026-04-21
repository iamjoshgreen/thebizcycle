import { useCallback } from "react";
import { useGetHousing, useRefreshHousing } from "@workspace/api-client-react";
import type { DominoStatus, MonthlyPoint } from "@workspace/api-client-react";
import TopBar from "@/components/TopBar";
import { useToast } from "@/hooks/use-toast";

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

function Sparkline({ data, peakDate, state, width = 260, height = 56 }: SparklineProps) {
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
    <svg width={width} height={height} style={{ display: "block" }}>
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

// ─── Domino Card ──────────────────────────────────────────────────────────────

function DominoCard({ d, index }: { d: DominoStatus; index: number }) {
  const c = STATE_COLORS[d.state] ?? STATE_COLORS.expanding;
  const stateLabel = d.state === "fallen" ? "FALLEN" : d.state === "rolling_over" ? "ROLLING OVER" : "EXPANDING";

  return (
    <div
      style={{
        flex: "1 1 0",
        minWidth: 0,
        background: c.bg,
        border: `1px solid ${c.border}`,
        borderRadius: 6,
        padding: "10px 12px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
      data-testid={`domino-${d.id}`}
    >
      {/* Header row */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <div
            style={{
              width: 18,
              height: 18,
              borderRadius: 4,
              background: "rgba(0,0,0,0.35)",
              border: `1px solid ${c.border}`,
              color: c.fg,
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 10,
              fontWeight: 600,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            {index + 1}
          </div>
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                color: "rgba(220,225,235,0.92)",
                fontFamily: "'Inter', sans-serif",
                fontSize: 12,
                fontWeight: 600,
                letterSpacing: "-0.01em",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {d.label}
            </div>
            <div
              style={{
                color: "rgba(180,180,200,0.45)",
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 9,
                letterSpacing: "0.05em",
              }}
            >
              {d.series}
            </div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 5, flexShrink: 0 }}>
          <div style={{ width: 7, height: 7, borderRadius: "50%", background: c.dot }} />
          <span
            style={{
              color: c.fg,
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 9,
              letterSpacing: "0.06em",
              fontWeight: 600,
            }}
          >
            {stateLabel}
          </span>
        </div>
      </div>

      {/* Stats grid */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          rowGap: 3,
          columnGap: 8,
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 10,
        }}
      >
        <div style={{ color: "rgba(180,180,200,0.4)" }}>% off peak</div>
        <div style={{ color: c.fg, textAlign: "right" }}>{fmtPct(d.pctOffPeak)}</div>
        <div style={{ color: "rgba(180,180,200,0.4)" }}>months since peak</div>
        <div style={{ color: "rgba(220,225,235,0.85)", textAlign: "right" }}>
          {d.monthsSincePeak ?? "—"}
        </div>
        <div style={{ color: "rgba(180,180,200,0.4)" }}>3-mo Δ</div>
        <div style={{ color: "rgba(220,225,235,0.85)", textAlign: "right" }}>{fmtPct(d.roc3m)}</div>
        <div style={{ color: "rgba(180,180,200,0.4)" }}>6-mo Δ</div>
        <div style={{ color: "rgba(220,225,235,0.85)", textAlign: "right" }}>{fmtPct(d.roc6m)}</div>
      </div>

      {/* Sparkline */}
      <div style={{ marginTop: 2 }}>
        <Sparkline data={d.data} peakDate={d.peakDate} state={d.state} width={260} height={48} />
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            color: "rgba(180,180,200,0.35)",
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 9,
            marginTop: 2,
          }}
        >
          <span>peak {fmtMonth(d.peakDate)} · {fmtNum(d.peakValue)}</span>
          <span>now {fmtMonth(d.currentDate)} · {fmtNum(d.current)}</span>
        </div>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function HousingPage() {
  const { toast } = useToast();
  const { data, isLoading } = useGetHousing();
  const refreshMutation = useRefreshHousing();

  const handleRefresh = useCallback(() => {
    refreshMutation.mutate(undefined, {
      onError: () =>
        toast({ title: "Refresh failed", description: "Showing cached data", variant: "destructive" }),
    });
  }, [refreshMutation, toast]);

  const payload = refreshMutation.data ?? data;
  const lastUpdated = payload?.lastUpdated ?? null;

  return (
    <div className="flex flex-col w-full h-full overflow-hidden" style={{ background: "#0A0A0D" }}>
      <TopBar
        lastUpdated={lastUpdated ?? null}
        isRefreshing={refreshMutation.isPending}
        onRefresh={handleRefresh}
      />

      <div className="flex-1 overflow-auto px-6 py-5">
        {isLoading && !payload && (
          <div className="flex flex-col items-center justify-center gap-3 py-20">
            <div
              className="w-5 h-5 rounded-full border-2 border-transparent animate-spin"
              style={{ borderTopColor: "hsl(224 100% 58%)", borderRightColor: "hsl(224 100% 58% / 0.3)" }}
            />
            <span style={{ color: "hsl(220 10% 40%)", fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}>
              Fetching FRED housing data…
            </span>
          </div>
        )}

        {payload && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 1500, margin: "0 auto" }}>
            {/* Title */}
            <div>
              <div
                style={{
                  color: "rgba(200,200,220,0.4)",
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: 10,
                  letterSpacing: "0.08em",
                }}
              >
                RESIDENTIAL CONSTRUCTION CYCLE · 5-DOMINO SEQUENCE
              </div>
              <div
                style={{
                  color: "rgba(220,225,235,0.95)",
                  fontFamily: "'Inter', sans-serif",
                  fontSize: 18,
                  fontWeight: 600,
                  letterSpacing: "-0.01em",
                  marginTop: 2,
                }}
              >
                Housing Cycle Tracker
              </div>
              <div
                style={{
                  color: "rgba(180,180,200,0.5)",
                  fontFamily: "'Inter', sans-serif",
                  fontSize: 12,
                  marginTop: 2,
                  lineHeight: 1.4,
                }}
              >
                Watches the construction cycle in canonical order — sales → permits → under construction →
                construction employment → home prices. Home prices fall last; the earlier dominoes are the
                predictive ones.
              </div>
            </div>

            {/* Gate row: Fed tightening + Stage + Sequence integrity */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr 1fr", gap: 12 }}>
              {/* Fed gate */}
              <div
                style={{
                  background: payload.fed.tightening
                    ? "hsl(0 40% 12% / 0.55)"
                    : "hsl(220 30% 12% / 0.5)",
                  border: payload.fed.tightening
                    ? "1px solid rgba(239,80,80,0.45)"
                    : "1px solid hsl(230 10% 18%)",
                  borderRadius: 6,
                  padding: "10px 14px",
                }}
                data-testid="fed-gate"
              >
                <div
                  style={{
                    color: "rgba(180,180,200,0.45)",
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 9,
                    letterSpacing: "0.08em",
                  }}
                >
                  GATE · FED POLICY
                </div>
                <div
                  style={{
                    color: payload.fed.tightening
                      ? "rgba(255,170,170,0.95)"
                      : "rgba(180,210,200,0.85)",
                    fontFamily: "'Inter', sans-serif",
                    fontSize: 14,
                    fontWeight: 600,
                    marginTop: 2,
                  }}
                >
                  {payload.fed.tightening ? "Tightening — sequence is armed" : "Not tightening — sequence is dormant"}
                </div>
                <div
                  style={{
                    color: "rgba(180,180,200,0.5)",
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 10,
                    marginTop: 2,
                  }}
                >
                  Fed funds {fmtNum(payload.fed.current, 2)}% · 12 mo ago {fmtNum(payload.fed.yearAgo, 2)}%
                </div>
              </div>

              {/* Stage */}
              <div
                style={{
                  background: "hsl(230 14% 9% / 0.7)",
                  border: "1px solid hsl(230 10% 18%)",
                  borderRadius: 6,
                  padding: "10px 14px",
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
                      color: "rgba(180,180,200,0.45)",
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 9,
                      letterSpacing: "0.08em",
                    }}
                  >
                    STAGE SCORE
                  </div>
                  <div
                    style={{
                      color: "rgba(220,225,235,0.85)",
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 14,
                      fontWeight: 700,
                    }}
                  >
                    {payload.stage} / 5
                  </div>
                </div>
                <div
                  style={{
                    color: "rgba(220,225,235,0.95)",
                    fontFamily: "'Inter', sans-serif",
                    fontSize: 14,
                    fontWeight: 600,
                    marginTop: 2,
                  }}
                >
                  {payload.stageLabel}
                </div>
                {payload.expectedTimingNote && (
                  <div
                    style={{
                      color: "rgba(255,210,140,0.85)",
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 10,
                      marginTop: 4,
                    }}
                  >
                    ⚠ {payload.expectedTimingNote}
                  </div>
                )}
                {/* Stage progress bar */}
                <div
                  style={{
                    display: "flex",
                    gap: 3,
                    marginTop: 6,
                  }}
                >
                  {[0, 1, 2, 3, 4].map((i) => (
                    <div
                      key={i}
                      style={{
                        flex: 1,
                        height: 5,
                        borderRadius: 1,
                        background: i < payload.stage ? "#EF4444" : "rgba(255,255,255,0.06)",
                      }}
                    />
                  ))}
                </div>
              </div>

              {/* Sequence integrity */}
              <div
                style={{
                  background: payload.sequenceValid
                    ? "hsl(160 30% 12% / 0.45)"
                    : "hsl(35 60% 12% / 0.55)",
                  border: payload.sequenceValid
                    ? "1px solid rgba(80,180,140,0.35)"
                    : "1px solid rgba(245,160,40,0.5)",
                  borderRadius: 6,
                  padding: "10px 14px",
                }}
                data-testid="sequence-integrity"
              >
                <div
                  style={{
                    color: "rgba(180,180,200,0.45)",
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 9,
                    letterSpacing: "0.08em",
                  }}
                >
                  SEQUENCE INTEGRITY
                </div>
                <div
                  style={{
                    color: payload.sequenceValid
                      ? "rgba(180,210,200,0.95)"
                      : "rgba(255,210,140,0.95)",
                    fontFamily: "'Inter', sans-serif",
                    fontSize: 14,
                    fontWeight: 600,
                    marginTop: 2,
                  }}
                >
                  {payload.sequenceValid ? "In order" : "False start"}
                </div>
                <div
                  style={{
                    color: "rgba(180,180,200,0.55)",
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 10,
                    marginTop: 2,
                  }}
                >
                  {payload.sequenceNote}
                </div>
              </div>
            </div>

            {/* Domino row */}
            <div style={{ display: "flex", gap: 10, alignItems: "stretch" }}>
              {payload.dominoes.map((d, i) => (
                <DominoCard key={d.id} d={d} index={i} />
              ))}
            </div>

            {/* Footer note */}
            <div
              style={{
                color: "rgba(180,180,200,0.35)",
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 10,
                lineHeight: 1.5,
              }}
            >
              Source: FRED (HSN1F · PERMIT · UNDCONTSA · CES2023600001 · CSUSHPINSA · FEDFUNDS). A domino is
              "fallen" when it peaked ≥ 3 months ago, is ≥ 5% below that peak, and the 3-month rate of change is
              negative. Stages count consecutively from the first series — order matters.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
