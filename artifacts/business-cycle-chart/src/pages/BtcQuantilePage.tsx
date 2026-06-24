import { useState, useRef, useEffect } from "react";
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
  createChart,
  LineSeries,
  ColorType,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
  type IPrimitivePaneRenderer,
  type IPrimitivePaneView,
  type MouseEventParams,
} from "lightweight-charts";
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

// ─── Constants ────────────────────────────────────────────────────────────────
//
// Seven-quantile fan, colored dark green → dark red to match the paper's Figure 1.
const QLINES: Array<{ key: keyof BtcQuantilePoint; color: string; label: string }> = [
  { key: "q01", color: "#1a6b2f", label: "1%" },
  { key: "q10", color: "#4a9d4f", label: "10%" },
  { key: "q25", color: "#8cc34f", label: "25%" },
  { key: "q50", color: "#c8b94a", label: "50%" },
  { key: "q75", color: "#e09a3e", label: "75%" },
  { key: "q95", color: "#d35f3a", label: "95%" },
  { key: "q99", color: "#a52828", label: "99%" },
];

const GOLD = "#d4af37";

// ─── Chart (lightweight-charts) ─────────────────────────────────────────────────
//
// Rebuilt on lightweight-charts — the TradingView engine the Fractal Overlay and
// Business Cycle Chart pages use — so the BTC Quantile chart gets the same fluid,
// native scroll-to-zoom / drag-to-pan and an auto-fitting log price scale (which
// replaces the old hand-rolled recharts wheel/drag zoom that had no panning).
//
// The seven-quantile fan, the four dashed dislocation lines, and the BTC price
// line are line series on a single log price scale against a linear time axis.
// The non-line visuals — the golden dislocation band, the projection-zone
// shading, and the today/cycle-peak markers — are drawn as canvas pane
// primitives (same approach as the recession bars on the Business Cycle chart),
// so they track the data at every zoom level.

interface ChartProps {
  series: BtcQuantilePoint[];
  cyclePeaks: BtcCyclePeak[];
}

const MON = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function goldRgba(opacity: number): string {
  return `rgba(212, 175, 55, ${opacity})`;
}

// Right price-axis tick formatter (log price → compact $ label).
function priceAxisFmt(p: number): string {
  if (p >= 1_000_000) return `$${(p / 1_000_000).toFixed(1)}M`;
  if (p >= 1_000) return `$${Math.round(p / 1_000)}K`;
  if (p >= 1) return `$${Math.round(p)}`;
  return `$${p.toFixed(2)}`;
}

const DISL_KEYS = ["disl1", "disl2", "disl3", "disl4"] as const;

const WEEK_SEC = 7 * 86400;

// lightweight-charts spaces points by index, not by real calendar time. The
// source series is mixed-cadence (monthly 2010–2014, then weekly), so index
// spacing crams the early years into a thin left strip (a sharp "elbow") and
// distorts the concave fan. Resampling onto a uniform weekly grid restores the
// linear-calendar-time look of the original chart: the analytic quantile and
// dislocation curves are smooth, so linear interpolation between source points
// is faithful, and the price polyline is sampled along itself (no fabricated
// price beyond the last real print).
function resampleWeekly(series: BtcQuantilePoint[]): BtcQuantilePoint[] {
  const start = series[0].time;
  const end = series[series.length - 1].time;
  const grid: number[] = [];
  for (let t = start; t < end; t += WEEK_SEC) grid.push(t);
  grid.push(end);

  const lerp = (t: number, t0: number, v0: number, t1: number, v1: number) =>
    t1 === t0 ? v0 : v0 + (v1 - v0) * ((t - t0) / (t1 - t0));

  const numKeys = [
    "q01", "q10", "q25", "q50", "q75", "q95", "q99",
    "disl1", "disl2", "disl3", "disl4",
  ] as const;

  const pricePts = series.filter(
    (p) => p.price != null,
  ) as Array<BtcQuantilePoint & { price: number }>;
  const firstPriceT = pricePts.length ? pricePts[0].time : Infinity;
  const lastPriceT = pricePts.length ? pricePts[pricePts.length - 1].time : -Infinity;

  let j = 0;
  let pj = 0;
  const out: BtcQuantilePoint[] = [];
  for (const t of grid) {
    while (j < series.length - 2 && series[j + 1].time <= t) j++;
    const a = series[j];
    const b = series[Math.min(j + 1, series.length - 1)];
    const obj: Record<string, number | null> = { time: t };
    for (const k of numKeys) obj[k] = lerp(t, a.time, a[k], b.time, b[k]);

    if (t < firstPriceT || t > lastPriceT) {
      obj.price = null;
    } else {
      while (pj < pricePts.length - 2 && pricePts[pj + 1].time <= t) pj++;
      const pa = pricePts[pj];
      const pb = pricePts[Math.min(pj + 1, pricePts.length - 1)];
      obj.price = lerp(t, pa.time, pa.price, pb.time, pb.price);
    }
    out.push(obj as unknown as BtcQuantilePoint);
  }
  return out;
}

// ── Pane primitive: golden dislocation band (fills disl1 top → disl4 bottom) ──

type BandPoint = { time: number; top: number; bottom: number };

class BandRenderer implements IPrimitivePaneRenderer {
  constructor(
    private _data: BandPoint[],
    private _series: ISeriesApi<"Line">,
    private _chart: IChartApi,
  ) {}
  draw(target: Parameters<IPrimitivePaneRenderer["draw"]>[0]): void {
    if (this._data.length < 2) return;
    const ts = this._chart.timeScale();
    const series = this._series;
    target.useMediaCoordinateSpace(({ context: ctx }) => {
      const pts: { x: number; yTop: number; yBot: number }[] = [];
      for (const d of this._data) {
        const x = ts.timeToCoordinate(d.time as UTCTimestamp);
        const yTop = series.priceToCoordinate(d.top);
        const yBot = series.priceToCoordinate(d.bottom);
        if (x === null || yTop === null || yBot === null) continue;
        pts.push({ x, yTop, yBot });
      }
      if (pts.length < 2) return;
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].yTop);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].yTop);
      for (let i = pts.length - 1; i >= 0; i--) ctx.lineTo(pts[i].x, pts[i].yBot);
      ctx.closePath();
      ctx.fillStyle = goldRgba(0.16);
      ctx.fill();
      ctx.restore();
    });
  }
}

class BandPaneView implements IPrimitivePaneView {
  constructor(
    private _data: BandPoint[],
    private _series: ISeriesApi<"Line">,
    private _chart: IChartApi,
  ) {}
  zOrder(): "bottom" { return "bottom"; }
  renderer(): IPrimitivePaneRenderer { return new BandRenderer(this._data, this._series, this._chart); }
}

class BandPrimitive {
  constructor(
    private _data: BandPoint[],
    private _series: ISeriesApi<"Line">,
    private _chart: IChartApi,
  ) {}
  paneViews() { return [new BandPaneView(this._data, this._series, this._chart)]; }
  priceAxisViews() { return []; }
  timeAxisViews() { return []; }
  priceAxisPaneViews() { return []; }
  timeAxisPaneViews() { return []; }
}

// ── Pane primitive: projection-zone shading (from last history → end) ──

class ShadeRenderer implements IPrimitivePaneRenderer {
  constructor(private _from: number, private _to: number, private _chart: IChartApi) {}
  draw(target: Parameters<IPrimitivePaneRenderer["draw"]>[0]): void {
    const ts = this._chart.timeScale();
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const x1 = ts.timeToCoordinate(this._from as UTCTimestamp);
      const x2 = ts.timeToCoordinate(this._to as UTCTimestamp);
      if (x1 === null || x2 === null) return;
      ctx.save();
      ctx.fillStyle = "rgba(180, 180, 200, 0.025)";
      ctx.fillRect(Math.min(x1, x2), 0, Math.abs(x2 - x1), mediaSize.height);
      ctx.restore();
    });
  }
}

class ShadePaneView implements IPrimitivePaneView {
  constructor(private _from: number, private _to: number, private _chart: IChartApi) {}
  zOrder(): "bottom" { return "bottom"; }
  renderer(): IPrimitivePaneRenderer { return new ShadeRenderer(this._from, this._to, this._chart); }
}

class ShadePrimitive {
  constructor(private _from: number, private _to: number, private _chart: IChartApi) {}
  paneViews() { return [new ShadePaneView(this._from, this._to, this._chart)]; }
  priceAxisViews() { return []; }
  timeAxisViews() { return []; }
  priceAxisPaneViews() { return []; }
  timeAxisPaneViews() { return []; }
}

// ── Pane primitive: vertical markers (today + cycle peaks) with labels ──

type VLine = {
  time: number;
  color: string;
  label: string;
  labelColor: string;
  align: "left" | "right";
};

class MarkersRenderer implements IPrimitivePaneRenderer {
  constructor(private _lines: VLine[], private _chart: IChartApi) {}
  draw(target: Parameters<IPrimitivePaneRenderer["draw"]>[0]): void {
    if (this._lines.length === 0) return;
    const ts = this._chart.timeScale();
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      ctx.save();
      ctx.font = "9px 'JetBrains Mono', monospace";
      ctx.textBaseline = "top";
      for (const v of this._lines) {
        const x = ts.timeToCoordinate(v.time as UTCTimestamp);
        if (x === null) continue;
        ctx.beginPath();
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = v.color;
        ctx.lineWidth = 1;
        ctx.moveTo(x, 0);
        ctx.lineTo(x, mediaSize.height);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = v.labelColor;
        if (v.align === "right") {
          ctx.textAlign = "right";
          ctx.fillText(v.label, x - 4, 4);
        } else {
          ctx.textAlign = "left";
          ctx.fillText(v.label, x + 4, 4);
        }
      }
      ctx.restore();
    });
  }
}

class MarkersPaneView implements IPrimitivePaneView {
  constructor(private _lines: VLine[], private _chart: IChartApi) {}
  zOrder(): "top" { return "top"; }
  renderer(): IPrimitivePaneRenderer { return new MarkersRenderer(this._lines, this._chart); }
}

class MarkersPrimitive {
  constructor(private _lines: VLine[], private _chart: IChartApi) {}
  paneViews() { return [new MarkersPaneView(this._lines, this._chart)]; }
  priceAxisViews() { return []; }
  timeAxisViews() { return []; }
  priceAxisPaneViews() { return []; }
  timeAxisPaneViews() { return []; }
}

function BtcQuantileChart({ series, cyclePeaks }: ChartProps) {
  const mono = "'JetBrains Mono', monospace";
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const disposedRef = useRef(false);
  const qSeriesRef = useRef<Map<string, ISeriesApi<"Line">>>(new Map());
  const dislSeriesRef = useRef<Map<string, ISeriesApi<"Line">>>(new Map());
  const priceSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const anchorSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const primsRef = useRef<unknown[]>([]);
  const dataMapRef = useRef<Map<number, BtcQuantilePoint>>(new Map());
  const [tooltip, setTooltip] = useState<{ x: number; y: number; p: BtcQuantilePoint } | null>(null);

  // Initialize chart + series once. Native handleScale/handleScroll give the same
  // fluid zoom & pan as the other lightweight-charts pages; the log price scale
  // auto-fits to the visible data as you zoom/pan.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    disposedRef.current = false;

    const chart = createChart(container, {
      width: container.clientWidth || 800,
      height: container.clientHeight || 600,
      autoSize: false,
      layout: {
        background: { type: ColorType.Solid, color: "hsl(230 12% 9.5%)" },
        textColor: "rgba(200,200,220,0.55)",
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: "rgba(255,255,255,0.035)" },
        horzLines: { color: "rgba(255,255,255,0.035)" },
      },
      crosshair: {
        mode: 1,
        vertLine: { color: "rgba(220,225,235,0.3)", width: 1, style: 2, labelBackgroundColor: "#14141c" },
        horzLine: { color: "rgba(220,225,235,0.3)", width: 1, style: 2, labelBackgroundColor: "#14141c" },
      },
      timeScale: {
        borderColor: "hsl(230 10% 16%)",
        timeVisible: false,
        secondsVisible: false,
        rightOffset: 4,
        fixLeftEdge: true,
        fixRightEdge: true,
      },
      rightPriceScale: {
        borderColor: "hsl(230 10% 16%)",
        mode: 1, // log
        scaleMargins: { top: 0.06, bottom: 0.04 },
      },
      leftPriceScale: { visible: false },
      handleScale: true,
      handleScroll: true,
      localization: { priceFormatter: priceAxisFmt },
    });
    chartRef.current = chart;

    // Dislocation dashed lines (behind everything).
    for (const k of DISL_KEYS) {
      const s = chart.addSeries(LineSeries, {
        color: goldRgba(0.55),
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      dislSeriesRef.current.set(k, s);
    }

    // Seven-quantile fan.
    for (const q of QLINES) {
      const s = chart.addSeries(LineSeries, {
        color: q.color,
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      qSeriesRef.current.set(q.key as string, s);
    }

    // BTC price (front).
    const price = chart.addSeries(LineSeries, {
      color: "rgba(247,147,26,0.95)",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
    });
    priceSeriesRef.current = price;
    anchorSeriesRef.current = qSeriesRef.current.get("q01") ?? price;

    const ro = new ResizeObserver((entries) => {
      if (disposedRef.current) return;
      const entry = entries[0];
      if (!entry) return;
      const w = Math.floor(entry.contentRect.width);
      const h = Math.floor(entry.contentRect.height);
      if (w <= 0 || h <= 0) return;
      try {
        chart.resize(w, h);
      } catch {
        /* torn down */
      }
    });
    ro.observe(container);

    const onMove = (param: MouseEventParams) => {
      if (!param.point || param.time == null) {
        setTooltip(null);
        return;
      }
      const t = typeof param.time === "number" ? param.time : Number(param.time);
      const p = dataMapRef.current.get(t);
      if (!p) {
        setTooltip(null);
        return;
      }
      setTooltip({ x: param.point.x, y: param.point.y, p });
    };
    chart.subscribeCrosshairMove(onMove);

    return () => {
      disposedRef.current = true;
      try { ro.disconnect(); } catch { /* ok */ }
      try { chart.unsubscribeCrosshairMove(onMove); } catch { /* ok */ }
      try { chart.remove(); } catch { /* ok */ }
      chartRef.current = null;
      priceSeriesRef.current = null;
      anchorSeriesRef.current = null;
      qSeriesRef.current.clear();
      dislSeriesRef.current.clear();
      primsRef.current = [];
    };
  }, []);

  // Push data + rebuild primitives whenever the series changes.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || series.length < 2) return;

    // Resample to a uniform weekly grid so lightweight-charts' index-based
    // spacing reproduces the original linear-calendar-time look.
    const resampled = resampleWeekly(series);

    const map = new Map<number, BtcQuantilePoint>();
    for (const p of resampled) map.set(p.time, p);
    dataMapRef.current = map;

    for (const q of QLINES) {
      const s = qSeriesRef.current.get(q.key as string);
      s?.setData(
        resampled.map((p) => ({ time: p.time as UTCTimestamp, value: p[q.key] as number })),
      );
    }
    for (const k of DISL_KEYS) {
      const s = dislSeriesRef.current.get(k);
      s?.setData(resampled.map((p) => ({ time: p.time as UTCTimestamp, value: p[k] })));
    }
    priceSeriesRef.current?.setData(
      resampled
        .filter((p) => p.price != null)
        .map((p) => ({ time: p.time as UTCTimestamp, value: p.price as number })),
    );

    const anchor = anchorSeriesRef.current;
    if (anchor) {
      for (const prim of primsRef.current) {
        try { anchor.detachPrimitive(prim as never); } catch { /* ok */ }
      }
      primsRef.current = [];

      const hist = series.filter((p) => p.price != null);
      const lastHist = hist[hist.length - 1]?.time ?? series[series.length - 1].time;
      const xMax = series[series.length - 1].time;
      const nowSec = Math.floor(Date.now() / 1000);

      const band = new BandPrimitive(
        resampled.map((p) => ({ time: p.time, top: p.disl1, bottom: p.disl4 })),
        anchor,
        chart,
      );
      const shade = new ShadePrimitive(lastHist, xMax, chart);

      const vlines: VLine[] = [];
      if (nowSec >= series[0].time && nowSec <= xMax) {
        vlines.push({
          time: nowSec,
          color: "rgba(220,225,235,0.25)",
          label: "today",
          labelColor: "rgba(220,225,235,0.4)",
          align: "right",
        });
      }
      for (const peak of cyclePeaks) {
        vlines.push({
          time: peak.time,
          color: "rgba(220,225,235,0.18)",
          label: `${peak.label}  ${fmtPrice(peak.price)}`,
          labelColor: "rgba(247,147,26,0.65)",
          align: "left",
        });
      }
      const markers = new MarkersPrimitive(vlines, chart);

      anchor.attachPrimitive(shade as never);
      anchor.attachPrimitive(band as never);
      anchor.attachPrimitive(markers as never);
      primsRef.current = [shade, band, markers];
    }

    try { chart.timeScale().fitContent(); } catch { /* ok */ }
  }, [series, cyclePeaks]);

  const resetZoom = () => {
    try { chartRef.current?.timeScale().fitContent(); } catch { /* ok */ }
  };

  // Tooltip rows (key quantiles), matching the previous content.
  const tipRows: Array<{ k: keyof BtcQuantilePoint; label: string; color: string }> = [
    { k: "q99", label: "Q99", color: "#a52828" },
    { k: "q95", label: "Q95", color: "#d35f3a" },
    { k: "q50", label: "Q50", color: "#c8b94a" },
    { k: "q10", label: "Q10", color: "#4a9d4f" },
    { k: "q01", label: "Q1", color: "#1a6b2f" },
  ];
  const containerW = containerRef.current?.clientWidth ?? 0;
  const tipFlip = tooltip != null && containerW > 0 && tooltip.x > containerW * 0.62;

  return (
    <div>
      {/* Legend */}
      <div style={{ display: "flex", gap: 14, padding: "0 8px 10px 8px", flexWrap: "wrap" }}>
        {QLINES.map((q) => (
          <div key={q.key} style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <svg width="18" height="10">
              <line x1={0} y1={5} x2={18} y2={5} stroke={q.color} strokeWidth={1.8} />
            </svg>
            <span style={{ fontSize: 9, fontFamily: mono, color: "rgba(180,180,200,0.6)" }}>
              {q.label}
            </span>
          </div>
        ))}
        <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <svg width="18" height="10">
            <rect x={0} y={2} width={18} height={6} fill={GOLD} fillOpacity={0.18} />
          </svg>
          <span style={{ fontSize: 9, fontFamily: mono, color: "rgba(180,180,200,0.6)" }}>
            dislocation zone
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <svg width="18" height="10">
            <line x1={0} y1={5} x2={18} y2={5} stroke="rgba(247,147,26,0.9)" strokeWidth={1.8} />
          </svg>
          <span style={{ fontSize: 9, fontFamily: mono, color: "rgba(180,180,200,0.6)" }}>
            BTC price
          </span>
        </div>

        <div
          style={{
            marginLeft: "auto",
            display: "flex",
            alignItems: "center",
            gap: 10,
            paddingRight: 8,
          }}
        >
          <span style={{ fontSize: 9, fontFamily: mono, color: "rgba(180,180,200,0.4)" }}>
            scroll to zoom · drag to pan · double-click to reset
          </span>
          <button
            onClick={resetZoom}
            style={{
              fontFamily: mono,
              fontSize: 9,
              color: "rgba(220,225,235,0.85)",
              background: "rgba(120,160,255,0.12)",
              border: "1px solid rgba(120,160,255,0.35)",
              borderRadius: 4,
              padding: "3px 8px",
              cursor: "pointer",
            }}
          >
            Reset zoom
          </button>
        </div>
      </div>

      <div style={{ position: "relative", height: 900 }}>
        <div
          ref={containerRef}
          style={{ position: "absolute", inset: 0 }}
          onDoubleClick={resetZoom}
        />

        {series.length < 4 && (
          <div
            style={{
              position: "absolute",
              inset: 0,
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
        )}

        {tooltip && (
          <div
            style={{
              position: "absolute",
              left: tipFlip ? undefined : tooltip.x + 16,
              right: tipFlip ? containerW - tooltip.x + 16 : undefined,
              top: Math.max(8, tooltip.y - 10),
              pointerEvents: "none",
              background: "rgba(18,20,28,0.96)",
              border: "1px solid rgba(120,130,160,0.3)",
              borderRadius: 6,
              padding: "8px 10px",
              fontFamily: mono,
              fontSize: 10,
              lineHeight: 1.6,
              color: "rgba(220,225,235,0.85)",
              boxShadow: "0 4px 18px rgba(0,0,0,0.45)",
              zIndex: 5,
            }}
          >
            <div style={{ color: "rgba(180,180,200,0.7)", marginBottom: 4 }}>
              {`${MON[new Date(tooltip.p.time * 1000).getUTCMonth()]} ${new Date(tooltip.p.time * 1000).getUTCDate()}, ${new Date(tooltip.p.time * 1000).getUTCFullYear()}`}
            </div>
            {tooltip.p.price != null && (
              <div style={{ color: "rgba(247,147,26,0.95)", fontWeight: 600, marginBottom: 4 }}>
                BTC&nbsp;&nbsp;{fmtPrice(tooltip.p.price)}
              </div>
            )}
            {tipRows.map((r) => {
              const v = tooltip.p[r.k] as number | null;
              if (v == null) return null;
              return (
                <div
                  key={r.k as string}
                  style={{ display: "flex", justifyContent: "space-between", gap: 14 }}
                >
                  <span style={{ color: r.color }}>{r.label}</span>
                  <span>{fmtPrice(v)}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
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
        <span>Q1% (floor)</span>
        <span>Q99% (top)</span>
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
        {ordinal(clamped)} percentile across the Q1%–Q99% quantile fan
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
            {["Cycle Peak", "Date", "Peak Price", "Q99% Band", "% of Q99%"].map(
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
              p.pctOfQ99 > 0.85
                ? "rgba(52,211,153,0.9)"
                : p.pctOfQ99 > 0.65
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
                <td style={numCell}>{fmtPrice(p.q99)}</td>
                <td style={{ ...numCell, color: pctColor, fontWeight: 700 }}>
                  {(p.pctOfQ99 * 100).toFixed(1)}%
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

  // % gap from current price up to the Q95 band
  const gapToUpper =
    data?.currentPrice != null && data?.currentQ95 != null && data.currentQ95 > 0
      ? ((data.currentQ95 - data.currentPrice) / data.currentPrice) * 100
      : null;

  // gap from current price to Q10 band (positive = Q10 is above price = unusually low)
  const gapToLower =
    data?.currentPrice != null && data?.currentQ10 != null && data.currentQ10 > 0
      ? ((data.currentQ10 - data.currentPrice) / data.currentPrice) * 100
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
            Seven fixed-coefficient quantiles (Table 3) of Bitcoin's price, plotted on a
            log-price / calendar-time chart. The upper quantiles curve inward across cycles —
            the asymmetric tail curvature — while the lower quantiles hold a near-straight
            power law. Deterministic, not fitted.
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
              label="Quantile Position"
              value={pctDisplay}
              sub={
                data.currentPercentile != null && data.currentPercentile < 1
                  ? "below the Q1% floor"
                  : "within the Q1%–Q99% fan"
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
              label="Q95% Band"
              value={fmtPrice(data.currentQ95)}
              sub={gapToUpper != null ? `${fmtPct(gapToUpper)} above current price` : undefined}
              accent="rgba(211,95,58,0.85)"
            />
            <StatCard
              label="Q10% Band"
              value={fmtPrice(data.currentQ10)}
              sub={lowerBandSub}
              accent="rgba(74,157,79,0.85)"
            />
            <StatCard label="Q50% Median" value={fmtPrice(data.currentQ50)} accent="rgba(200,185,74,0.9)" />
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
              Fetches BTC-USD history from Yahoo Finance and applies the fixed model (~5s)
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
                  title: "What the fan shows",
                  text:
                    "Seven quantiles (1, 10, 25, 50, 75, 95, 99%) of Bitcoin's price as fixed-coefficient curves: log₁₀(price) = c + a·x + b·x², where x = ln(days since Jan 1 2009) − 7.9914. Drawn on a log-price y-axis against linear calendar time, the ln(t) term bends the curves into the concave fan. The coefficients come from Table 3 of the paper and are not re-estimated — the same curves render every time. Per date, the seven values are sorted ascending (rearrangement) to guarantee they never cross.",
                },
                {
                  title: "The asymmetry",
                  text:
                    "The upper quantiles carry a strong negative curvature (b ≈ −0.33) so they bend inward over time, while the lower quantiles are almost straight (b ≈ −0.02). That gap is the asymmetric tail curvature: speculative peaks reach a smaller multiple of trend each cycle, but the downside floor holds a near-constant power law. The cycle-peak table shows each top reaching a smaller fraction of Q99%.",
                },
                {
                  title: "Dislocation zone",
                  text:
                    "The four gold dashed lines sit 7.4%, 17.4%, 22.6%, and 34.6% below the Q1% quantile. The shaded golden band between the top and bottom lines marks the historical 'deep dislocation' region — where price has only briefly traded during capitulations. It is descriptive, not a buy signal.",
                },
                {
                  title: "What it is not",
                  text:
                    "The quantiles are not price targets, ceilings, or 'fair value,' and Q1% is not a guaranteed floor. The percentile readout shows where price sits within this fixed distribution today — not the probability of future gains or losses. The 2-year projection simply extends the deterministic curves; it is not a forecast.",
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
