import { Fragment, useCallback } from "react";
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

      <div className="flex-1 overflow-auto px-3 py-3 sm:px-6 sm:py-5">
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
              <div style={{ flex: 1, minWidth: 0 }}>
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
                expected falling order is visually obvious. */}
            <div style={{ display: "flex", gap: 6, alignItems: "stretch" }}>
              {payload.dominoes.map((d, i) => (
                <Fragment key={d.id}>
                  {i > 0 && <DominoArrow />}
                  <DominoCard d={d} index={i} />
                </Fragment>
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
