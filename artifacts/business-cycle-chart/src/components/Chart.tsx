import { useEffect, useRef, useImperativeHandle, forwardRef } from "react";
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
  spx: DataPoint[];
  oil: DataPoint[];
  unrate: DataPoint[];
  fedfunds: DataPoint[];
  dgs10: DataPoint[];
  t10y2y: DataPoint[];
  btc: DataPoint[];
  cpi: DataPoint[];
}

export const OVERLAY_CONFIG: {
  id: keyof Overlays;
  label: string;
  color: string;
  description: string;
  scaleId?: string;
  scaleVisible?: boolean;
  scaleMode?: number;
}[] = [
  { id: "spx",      label: "SPX",           color: "#FF6D00", description: "S&P 500 index",               scaleId: "right", scaleVisible: true, scaleMode: 1 },
  { id: "oil",      label: "Oil (WTI)",      color: "#F59E0B", description: "Crude oil price, USD/barrel" },
  { id: "unrate",   label: "Unemployment",   color: "#06B6D4", description: "US unemployment rate %" },
  { id: "fedfunds", label: "Fed Funds",       color: "#A855F7", description: "Federal funds rate %" },
  { id: "dgs10",    label: "10Y Treasury",    color: "#10B981", description: "10-year treasury yield %" },
  { id: "t10y2y",   label: "Yield Curve",     color: "#EF4444", description: "10Y–2Y spread (negative = inverted)" },
  { id: "btc",      label: "BTC",             color: "#FBBF24", description: "Bitcoin price, USD", scaleMode: 1 },
  { id: "cpi",      label: "CPI YoY %",       color: "#EC4899", description: "US Inflation Rate (CPI year-over-year % change)" },
];

export interface ChartHandle {
  fitContent: () => void;
}

interface ChartProps {
  composite: DataPoint[];
  recessions: RecessionInterval[];
  overlays: Overlays;
  activeOverlays: Set<keyof Overlays>;
  measureActive: boolean;
  onMeasure: (result: MeasureResult | null) => void;
}

export interface MeasureResult {
  startTs: number;
  endTs: number;
  days: number;
  years: number;
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

const Chart = forwardRef<ChartHandle, ChartProps>(function Chart(
  { composite, recessions, overlays, activeOverlays, measureActive, onMeasure },
  ref
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const compositeSeries = useRef<ISeriesApi<"Line"> | null>(null);
  const primitiveRef = useRef<RecessionBarsPrimitive | null>(null);
  const overlaySeries = useRef<Map<string, ISeriesApi<"Line">>>(new Map());
  const measureStartRef = useRef<number | null>(null);
  const measureActiveRef = useRef(measureActive);
  const compositeRangeRef = useRef<{ from: number; to: number } | null>(null);

  useEffect(() => { measureActiveRef.current = measureActive; }, [measureActive]);

  useImperativeHandle(ref, () => ({
    fitContent() {
      const ts = chartRef.current?.timeScale();
      if (!ts) return;
      if (compositeRangeRef.current) {
        ts.setVisibleRange({
          from: compositeRangeRef.current.from as UTCTimestamp,
          to: compositeRangeRef.current.to as UTCTimestamp,
        });
      } else {
        ts.fitContent();
      }
    },
  }));

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
        fixRightEdge: false,
        rightOffset: 2,
        minBarSpacing: 0.05,
      },
      leftPriceScale: {
        visible: true,
        borderColor: "rgba(255, 255, 255, 0.05)",
        scaleMargins: { top: 0.06, bottom: 0.06 },
        textColor: "rgba(200, 200, 220, 0.35)",
        mode: 0,
      },
      rightPriceScale: {
        visible: false,
        borderColor: "rgba(255, 255, 255, 0.05)",
        scaleMargins: { top: 0.06, bottom: 0.06 },
        textColor: "rgba(200, 200, 220, 0.35)",
        mode: 1,
      },
      width: containerRef.current.clientWidth,
      height: containerRef.current.clientHeight,
      handleScale: true,
      handleScroll: true,
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
      primitiveRef.current = null;
      overlaySeries.current.clear();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Handle measure clicks on the chart container
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const handleClick = (e: MouseEvent) => {
      if (!measureActiveRef.current) return;
      const chart = chartRef.current;
      if (!chart) return;

      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const time = chart.timeScale().coordinateToTime(x);
      if (time == null) return;
      const ts = time as unknown as number; // UTCTimestamp in seconds

      if (measureStartRef.current == null) {
        // First click — set start
        measureStartRef.current = ts;
        onMeasure(null); // clear any old result while waiting for 2nd click
      } else {
        // Second click — compute result
        const startTs = measureStartRef.current;
        const endTs = ts;
        const diff = Math.abs(endTs - startTs);
        const days = Math.round(diff / 86400);
        const years = diff / (86400 * 365.25);
        onMeasure({ startTs: Math.min(startTs, endTs), endTs: Math.max(startTs, endTs), days, years });
        measureStartRef.current = null; // reset for next pair
      }
    };

    el.addEventListener("click", handleClick);
    return () => el.removeEventListener("click", handleClick);
  }, [onMeasure]);

  // Clear measure state when tool is turned off
  useEffect(() => {
    if (!measureActive) {
      measureStartRef.current = null;
    }
  }, [measureActive]);

  // Update composite data + recession bars
  useEffect(() => {
    if (!compositeSeries.current || !chartRef.current) return;
    if (composite.length === 0) return;

    const mapped = composite.map((d) => ({ time: d.time as UTCTimestamp, value: d.value }));
    compositeSeries.current.setData(mapped);

    // Store the full composite date range so Fit All can always reset to it
    compositeRangeRef.current = {
      from: composite[0].time,
      to: composite[composite.length - 1].time,
    };

    if (primitiveRef.current) {
      try { compositeSeries.current.detachPrimitive(primitiveRef.current as never); } catch { /* ok */ }
    }
    const prim = new RecessionBarsPrimitive(recessions, chartRef.current);
    primitiveRef.current = prim;
    compositeSeries.current.attachPrimitive(prim as never);

    // Always fit to the composite's full range, not whatever overlays constrain it to
    if (composite.length > 0) {
      try {
        chartRef.current.timeScale().setVisibleRange({
          from: composite[0].time as UTCTimestamp,
          to: composite[composite.length - 1].time as UTCTimestamp,
        });
      } catch {
        chartRef.current.timeScale().fitContent();
      }
    }
  }, [composite, recessions]);

  // Add/remove overlay series
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    for (const cfg of OVERLAY_CONFIG) {
      const isActive = activeOverlays.has(cfg.id);
      const existing = overlaySeries.current.get(cfg.id);
      const scaleId = cfg.scaleId ?? `ov-${cfg.id}`;

      if (isActive && !existing) {
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
        chart.priceScale(scaleId).applyOptions({
          visible: cfg.scaleVisible ?? false,
          ...(cfg.scaleMode !== undefined ? { mode: cfg.scaleMode } : {}),
        });
        const data = overlays[cfg.id];
        if (data?.length) {
          series.setData(data.map((d) => ({ time: d.time as UTCTimestamp, value: d.value })));
        }
        overlaySeries.current.set(cfg.id, series);
      } else if (!isActive && existing) {
        try { chart.removeSeries(existing); } catch { /* ok */ }
        if (cfg.scaleVisible) chart.priceScale(scaleId).applyOptions({ visible: false });
        overlaySeries.current.delete(cfg.id);
      } else if (isActive && existing) {
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
      style={{
        background: "#0A0A0D",
        cursor: measureActive ? "crosshair" : "default",
      }}
      data-testid="chart-container"
    />
  );
});

export default Chart;
