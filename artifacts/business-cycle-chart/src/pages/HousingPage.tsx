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
      {/* Step number + name (full width, can wrap) */}
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, minWidth: 0 }}>
        <span
          style={{
            color: "rgba(180,180,200,0.45)",
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 14,
            fontWeight: 600,
            flexShrink: 0,
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
          }}
        >
          {shortLabel}
        </span>
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
          ? "at a new 24-month high · still rising"
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

        {payload && (() => {
          const fallenCount = payload.dominoes.filter((d) => d.fallen).length;
          const rollingCount = payload.dominoes.filter((d) => d.state === "rolling_over").length;

          // Single-word verdict
          let verdict: string;
          let verdictColor: string;
          let verdictBg: string;
          let verdictBorder: string;
          let plainEnglish: string;

          // Identify which dominoes are out of order for the FALSE START copy
          const fallenIds = payload.dominoes.filter((d) => d.fallen).map((d) => SHORT_LABELS[d.id] ?? d.label);
          const firstNotFallen = payload.dominoes.find((d) => !d.fallen);
          const firstNotFallenName = firstNotFallen ? (SHORT_LABELS[firstNotFallen.id] ?? firstNotFallen.label) : "";

          if (!payload.sequenceValid) {
            verdict = "FALSE START";
            verdictColor = "#F59E0B";
            verdictBg = "hsl(35 60% 11% / 0.7)";
            verdictBorder = "rgba(245,160,40,0.6)";
            plainEnglish =
              `${fallenIds.join(" and ")} ${fallenIds.length === 1 ? "has" : "have"} fallen, but ${firstNotFallenName} hasn't yet. ` +
              `That's the wrong order — when builders pull back before buyers do, it's usually a supply-side shock ` +
              `(rates spike, materials, labor) rather than demand actually weakening. ` +
              `A real housing-led downturn starts with buyers walking away first.`;
          } else if (payload.stage >= 4) {
            verdict = "LATE STAGE";
            verdictColor = "#EF4444";
            verdictBg = "hsl(0 50% 12% / 0.7)";
            verdictBorder = "rgba(239,80,80,0.6)";
            plainEnglish =
              `${payload.stage} of 5 dominoes have fallen in the right order — buyers first, then everything downstream. ` +
              `When the chain gets this deep, recession typically follows within 6–18 months.`;
          } else if (payload.stage >= 2) {
            verdict = "ARMED";
            verdictColor = "#F59E0B";
            verdictBg = "hsl(35 60% 11% / 0.7)";
            verdictBorder = "rgba(245,160,40,0.6)";
            plainEnglish =
              `${payload.stage} of 5 dominoes have fallen in the right order, starting with buyers. ` +
              `When the chain runs in this sequence, it tends to keep going. Watch the next domino.`;
          } else if (payload.fed.tightening) {
            verdict = "WATCHING";
            verdictColor = "#60A5FA";
            verdictBg = "hsl(220 40% 11% / 0.6)";
            verdictBorder = "rgba(96,165,250,0.4)";
            plainEnglish =
              `Fed is tightening (${fmtNum(payload.fed.current, 2)}% now vs ${fmtNum(payload.fed.yearAgo, 2)}% a year ago), ` +
              `which is the trigger that usually starts the housing chain. Nothing has fallen in order yet.`;
          } else {
            verdict = "DORMANT";
            verdictColor = "#10B981";
            verdictBg = "hsl(160 30% 11% / 0.6)";
            verdictBorder = "rgba(80,180,140,0.4)";
            plainEnglish =
              `Fed isn't tightening (${fmtNum(payload.fed.current, 2)}% now vs ${fmtNum(payload.fed.yearAgo, 2)}% a year ago). ` +
              `Without that pressure, the housing chain rarely starts. No recession signal here.`;
          }

          return (
          <div style={{ display: "flex", flexDirection: "column", gap: 28, maxWidth: 1600, margin: "0 auto" }}>
            {/* Verdict banner */}
            <div
              style={{
                background: verdictBg,
                border: `1px solid ${verdictBorder}`,
                borderRadius: 12,
                padding: "26px 30px",
                display: "flex",
                gap: 32,
                alignItems: "center",
              }}
              data-testid="verdict-banner"
            >
              <div style={{ flexShrink: 0 }}>
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
                    fontSize: 56,
                    fontWeight: 800,
                    letterSpacing: "-0.03em",
                    lineHeight: 1,
                    marginTop: 6,
                  }}
                >
                  {verdict}
                </div>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    color: "rgba(225,230,240,0.92)",
                    fontFamily: "'Inter', sans-serif",
                    fontSize: 17,
                    lineHeight: 1.5,
                    fontWeight: 400,
                  }}
                >
                  {plainEnglish}
                </div>
                <div
                  style={{
                    display: "flex",
                    gap: 24,
                    marginTop: 14,
                    color: "rgba(180,180,200,0.65)",
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 13,
                  }}
                >
                  <span>{fallenCount} fallen · {rollingCount} rolling · {5 - fallenCount - rollingCount} steady</span>
                  <span>Fed funds {fmtNum(payload.fed.current, 2)}%</span>
                  <span>{payload.stage}/5 in proper order</span>
                </div>
              </div>
            </div>

            {/* How this works — 3-column strategy explainer */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr 1fr",
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
            <div style={{ display: "grid", gridTemplateColumns: "1.1fr 0.9fr 1.6fr 1.2fr", gap: 14 }}>
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

            {/* Domino row */}
            <div style={{ display: "flex", gap: 14, alignItems: "stretch" }}>
              {payload.dominoes.map((d, i) => (
                <DominoCard key={d.id} d={d} index={i} />
              ))}
            </div>

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
