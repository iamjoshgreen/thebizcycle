import { useEffect, useRef } from "react";
import {
  createChart,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type IPrimitivePaneRenderer,
  type IPrimitivePaneView,
  type UTCTimestamp,
  ColorType,
} from "lightweight-charts";

interface DataPoint {
  time: number;
  value: number;
}

interface RecessionInterval {
  start: number;
  end: number;
}

export interface Overlays {
  oil: DataPoint[];
  unrate: DataPoint[];
  fedfunds: DataPoint[];
  dgs10: DataPoint[];
  t10y2y: DataPoint[];
}

export const OVERLAY_CONFIG: {
  id: keyof Overlays;
  label: string;
  color: string;
  description: string;
}[] = [
  { id: "oil",      label: "Oil (WTI)",       color: "#F59E0B", description: "Crude oil price, USD/barrel" },
  { id: "unrate",   label: "Unemployment",    color: "#06B6D4", description: "US unemployment rate %" },
  { id: "fedfunds", label: "Fed Funds",        color: "#A855F7", description: "Federal funds rate %" },
  { id: "dgs10",    label: "10Y Treasury",     color: "#10B981", description: "10-year treasury yield %" },
  { id: "t10y2y",   label: "Yield Curve",      color: "#EF4444", description: "10Y–2Y spread (negative = inverted)" },
];

interface ChartProps {
  composite: DataPoint[];
  spx: DataPoint[];
  recessions: RecessionInterval[];
  overlays: Overlays;
  activeOverlays: Set<keyof Overlays>;
}

// ─── Recession Bars Primitive ─────────────────────────────────────────────────

class RecessionBarsRenderer implements IPrimitivePaneRenderer {
  constructor(private _recessions: RecessionInterval[], private _chart: IChartApi) {}

  draw(target: Parameters<IPrimitivePaneRenderer["draw"]>[0]): void {
    if (this._recessions.length === 0) return;
    const ts = this._chart.timeScale();
    target.useBitmapCoordinateSpace(({ context: ctx, bitmapSize, horizontalPixelRatio }) => {
      ctx.save();
      ctx.fillStyle = "rgba(180, 190, 210, 0.18)";
      for (const { start, end } of this._recessions) {
        const x1 = ts.timeToCoordinate(start as UTCTimestamp);
        const x2 = ts.timeToCoordinate(end as UTCTimestamp);
        if (x1 === null || x2 === null) continue;
        const left = Math.min(x1, x2) * horizontalPixelRatio;
        const width = Math.max(1, Math.abs(x2 - x1) * horizontalPixelRatio);
        ctx.fillRect(left, 0, width, bitmapSize.height);
      }
      ctx.restore();
    });
  }
}

class RecessionBarsPaneView implements IPrimitivePaneView {
  constructor(private _recessions: RecessionInterval[], private _chart: IChartApi) {}
  zOrder(): "bottom" { return "bottom"; }
  renderer(): IPrimitivePaneRenderer { return new RecessionBarsRenderer(this._recessions, this._chart); }
}

class RecessionBarsPrimitive {
  constructor(private _recessions: RecessionInterval[], private _chart: IChartApi) {}
  paneViews() { return [new RecessionBarsPaneView(this._recessions, this._chart)]; }
  priceAxisViews() { return []; }
  timeAxisViews() { return []; }
  priceAxisPaneViews() { return []; }
  timeAxisPaneViews() { return []; }
}

// ─── Chart Component ──────────────────────────────────────────────────────────

export default function Chart({ composite, spx, recessions, overlays, activeOverlays }: ChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const compositeSeries = useRef<ISeriesApi<"Line"> | null>(null);
  const spxSeries = useRef<ISeriesApi<"Line"> | null>(null);
  const primitiveRef = useRef<RecessionBarsPrimitive | null>(null);
  const overlaySeries = useRef<Map<string, ISeriesApi<"Line">>>(new Map());

  // Initialize chart once
  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: "#0A0A0D" },
        textColor: "rgba(200, 200, 220, 0.45)",
        fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: "rgba(255, 255, 255, 0.035)" },
        horzLines: { color: "rgba(255, 255, 255, 0.035)" },
      },
      crosshair: {
        mode: 1,
        vertLine: { color: "rgba(200, 200, 220, 0.22)", width: 1, style: 2, labelBackgroundColor: "#14141c" },
        horzLine: { color: "rgba(200, 200, 220, 0.22)", width: 1, style: 2, labelBackgroundColor: "#14141c" },
      },
      timeScale: {
        borderColor: "rgba(255, 255, 255, 0.07)",
        timeVisible: false,
        secondsVisible: false,
        ticksVisible: false,
        fixLeftEdge: true,
        fixRightEdge: true,
        rightOffset: 0,
      },
      leftPriceScale: {
        visible: true,
        borderColor: "rgba(255, 255, 255, 0.05)",
        scaleMargins: { top: 0.06, bottom: 0.06 },
        textColor: "rgba(200, 200, 220, 0.35)",
        mode: 0,
      },
      rightPriceScale: {
        visible: true,
        borderColor: "rgba(255, 255, 255, 0.05)",
        scaleMargins: { top: 0.06, bottom: 0.06 },
        textColor: "rgba(200, 200, 220, 0.35)",
        mode: 1,
      },
      width: containerRef.current.clientWidth,
      height: containerRef.current.clientHeight,
      handleScale: false,
      handleScroll: false,
    });

    chartRef.current = chart;

    compositeSeries.current = chart.addSeries(LineSeries, {
      priceScaleId: "left",
      color: "#2962FF",
      lineWidth: 1.5,
      crosshairMarkerVisible: true,
      crosshairMarkerRadius: 3,
      crosshairMarkerBackgroundColor: "#2962FF",
      title: "Composite",
      lastValueVisible: true,
      priceLineVisible: false,
    });

    spxSeries.current = chart.addSeries(LineSeries, {
      priceScaleId: "right",
      color: "#FF6D00",
      lineWidth: 1,
      crosshairMarkerVisible: true,
      crosshairMarkerRadius: 3,
      crosshairMarkerBackgroundColor: "#FF6D00",
      title: "SPX",
      lastValueVisible: true,
      priceLineVisible: false,
    });

    const ro = new ResizeObserver(() => {
      if (containerRef.current) {
        chart.resize(containerRef.current.clientWidth, containerRef.current.clientHeight);
      }
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      compositeSeries.current = null;
      spxSeries.current = null;
      primitiveRef.current = null;
      overlaySeries.current.clear();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Update core data + recession bars
  useEffect(() => {
    if (!compositeSeries.current || !spxSeries.current || !chartRef.current) return;
    if (composite.length === 0) return;

    compositeSeries.current.setData(composite.map((d) => ({ time: d.time as UTCTimestamp, value: d.value })));
    spxSeries.current.setData(spx.map((d) => ({ time: d.time as UTCTimestamp, value: d.value })));

    if (primitiveRef.current) {
      try { compositeSeries.current.detachPrimitive(primitiveRef.current as never); } catch { /* ok */ }
    }
    const prim = new RecessionBarsPrimitive(recessions, chartRef.current);
    primitiveRef.current = prim;
    compositeSeries.current.attachPrimitive(prim as never);

    chartRef.current.timeScale().fitContent();
  }, [composite, spx, recessions]);

  // Add/remove overlay series when activeOverlays or overlay data changes
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    for (const cfg of OVERLAY_CONFIG) {
      const isActive = activeOverlays.has(cfg.id);
      const existing = overlaySeries.current.get(cfg.id);

      if (isActive && !existing) {
        // Add new overlay series with its own hidden scale
        const scaleId = `ov-${cfg.id}`;
        const series = chart.addSeries(LineSeries, {
          priceScaleId: scaleId,
          color: cfg.color,
          lineWidth: 1,
          crosshairMarkerVisible: true,
          crosshairMarkerRadius: 3,
          crosshairMarkerBackgroundColor: cfg.color,
          title: cfg.label,
          lastValueVisible: true,
          priceLineVisible: false,
        });
        // Hide the overlay's price scale axis
        chart.priceScale(scaleId).applyOptions({ visible: false });

        const data = overlays[cfg.id];
        if (data?.length) {
          series.setData(data.map((d) => ({ time: d.time as UTCTimestamp, value: d.value })));
        }
        overlaySeries.current.set(cfg.id, series);
      } else if (!isActive && existing) {
        // Remove overlay series
        try { chart.removeSeries(existing); } catch { /* ok */ }
        overlaySeries.current.delete(cfg.id);
      } else if (isActive && existing) {
        // Update data if it changed
        const data = overlays[cfg.id];
        if (data?.length) {
          existing.setData(data.map((d) => ({ time: d.time as UTCTimestamp, value: d.value })));
        }
      }
    }
  }, [activeOverlays, overlays]);

  return (
    <div
      ref={containerRef}
      className="w-full h-full"
      style={{ background: "#0A0A0D" }}
      data-testid="chart-container"
    />
  );
}
