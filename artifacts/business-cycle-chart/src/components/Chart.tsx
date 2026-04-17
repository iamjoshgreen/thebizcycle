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
import {
  DrawingManager,
  TrendLine,
  ParallelChannel,
  type SerializedDrawing,
  type IDrawing,
} from "lightweight-charts-drawing";
import type { DrawingTool } from "./DrawingToolbar";

interface DataPoint {
  time: number;
  value: number;
}

interface RecessionInterval {
  start: number;
  end: number;
}

interface ChartProps {
  composite: DataPoint[];
  spx: DataPoint[];
  recessions: RecessionInterval[];
  activeTool: DrawingTool;
  onDrawingsChange: (drawings: SerializedDrawing[]) => void;
}

export interface ChartHandle {
  loadDrawings: (drawings: SerializedDrawing[]) => void;
  deleteSelected: () => void;
  clearAll: () => void;
}

// ─── Recession Bars Primitive ─────────────────────────────────────────────────

class RecessionBarsRenderer implements IPrimitivePaneRenderer {
  constructor(
    private _recessions: RecessionInterval[],
    private _chart: IChartApi
  ) {}

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
  constructor(
    private _recessions: RecessionInterval[],
    private _chart: IChartApi
  ) {}

  zOrder(): "bottom" { return "bottom"; }

  renderer(): IPrimitivePaneRenderer {
    return new RecessionBarsRenderer(this._recessions, this._chart);
  }
}

class RecessionBarsPrimitive {
  constructor(
    private _recessions: RecessionInterval[],
    private _chart: IChartApi
  ) {}

  paneViews() {
    return [new RecessionBarsPaneView(this._recessions, this._chart)];
  }

  priceAxisViews() { return []; }
  timeAxisViews() { return []; }
  priceAxisPaneViews() { return []; }
  timeAxisPaneViews() { return []; }
}

// ─── Chart Component ──────────────────────────────────────────────────────────

const Chart = forwardRef<ChartHandle, ChartProps>(function Chart(
  { composite, spx, recessions, activeTool, onDrawingsChange },
  ref
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const compositeSeries = useRef<ISeriesApi<"Line"> | null>(null);
  const spxSeries = useRef<ISeriesApi<"Line"> | null>(null);
  const drawingManagerRef = useRef<DrawingManager | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const primitiveRef = useRef<RecessionBarsPrimitive | null>(null);

  // Keep latest callback in a ref to avoid stale closures
  const onDrawingsChangeRef = useRef(onDrawingsChange);
  useEffect(() => { onDrawingsChangeRef.current = onDrawingsChange; }, [onDrawingsChange]);

  const scheduleDrawingSave = useRef((manager: DrawingManager) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      onDrawingsChangeRef.current(manager.exportDrawings());
    }, 500);
  }).current;

  useImperativeHandle(ref, () => ({
    loadDrawings(drawings: SerializedDrawing[]) {
      const manager = drawingManagerRef.current;
      if (!manager) return;
      manager.importDrawings(drawings, (type: string, data: SerializedDrawing): IDrawing | null => {
        try {
          if (type === "trend-line") {
            const d = new TrendLine(data.id);
            d.fromJSON(data);
            return d;
          }
          if (type === "parallel-channel") {
            const d = new ParallelChannel(data.id);
            d.fromJSON(data);
            return d;
          }
        } catch {
          return null;
        }
        return null;
      });
    },
    deleteSelected() {
      const manager = drawingManagerRef.current;
      if (!manager) return;
      const selected = manager.getSelectedDrawing();
      if (selected) {
        manager.removeDrawing(selected.id);
        scheduleDrawingSave(manager);
      }
    },
    clearAll() {
      const manager = drawingManagerRef.current;
      if (!manager) return;
      manager.clearAll();
      scheduleDrawingSave(manager);
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
        vertLine: {
          color: "rgba(200, 200, 220, 0.22)",
          width: 1,
          style: 2,
          labelBackgroundColor: "#14141c",
        },
        horzLine: {
          color: "rgba(200, 200, 220, 0.22)",
          width: 1,
          style: 2,
          labelBackgroundColor: "#14141c",
        },
      },
      timeScale: {
        borderColor: "rgba(255, 255, 255, 0.07)",
        timeVisible: false,
        secondsVisible: false,
        ticksVisible: false,
        fixLeftEdge: true,
        fixRightEdge: false,
        barSpacing: 3,
        minBarSpacing: 0.5,
        rightOffset: 8,
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
        mode: 2,
      },
      width: containerRef.current.clientWidth,
      height: containerRef.current.clientHeight,
      handleScale: true,
      handleScroll: true,
    });

    chartRef.current = chart;

    // Composite — left axis, blue
    const compSeries = chart.addSeries(LineSeries, {
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
    compositeSeries.current = compSeries;

    // SPX — right axis, orange
    const spxSer = chart.addSeries(LineSeries, {
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
    spxSeries.current = spxSer;

    // Drawing manager — attach to composite series
    const manager = new DrawingManager();
    manager.attach(chart, compSeries, containerRef.current);
    drawingManagerRef.current = manager;

    const unsubCreate = manager.on("drawing:created", () => scheduleDrawingSave(manager));
    const unsubUpdate = manager.on("drawing:updated", () => scheduleDrawingSave(manager));
    const unsubDelete = manager.on("drawing:deleted", () => scheduleDrawingSave(manager));

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Delete" || e.key === "Backspace") {
        const sel = manager.getSelectedDrawing();
        if (sel) {
          manager.removeDrawing(sel.id);
          scheduleDrawingSave(manager);
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);

    const ro = new ResizeObserver(() => {
      if (containerRef.current) {
        chart.resize(containerRef.current.clientWidth, containerRef.current.clientHeight);
      }
    });
    ro.observe(containerRef.current);

    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      unsubCreate();
      unsubUpdate();
      unsubDelete();
      window.removeEventListener("keydown", handleKeyDown);
      ro.disconnect();
      manager.detach();
      chart.remove();
      chartRef.current = null;
      compositeSeries.current = null;
      spxSeries.current = null;
      drawingManagerRef.current = null;
      primitiveRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Update data
  useEffect(() => {
    if (!compositeSeries.current || !spxSeries.current || !chartRef.current) return;
    if (composite.length === 0) return;

    const compData = composite.map((d) => ({ time: d.time as UTCTimestamp, value: d.value }));
    const spxData = spx.map((d) => ({ time: d.time as UTCTimestamp, value: d.value }));

    compositeSeries.current.setData(compData);
    spxSeries.current.setData(spxData);

    // Detach old recession primitive
    if (primitiveRef.current) {
      try {
        compositeSeries.current.detachPrimitive(primitiveRef.current as never);
      } catch { /* ok */ }
    }

    const prim = new RecessionBarsPrimitive(recessions, chartRef.current);
    primitiveRef.current = prim;
    compositeSeries.current.attachPrimitive(prim as never);

    chartRef.current.timeScale().fitContent();
  }, [composite, spx, recessions]);

  // Update active tool
  useEffect(() => {
    const manager = drawingManagerRef.current;
    if (!manager) return;

    const toolMap: Record<string, string | null> = {
      trendline: "trend-line",
      channel: "parallel-channel",
      select: "select",
    };
    manager.setActiveTool(activeTool ? (toolMap[activeTool] ?? null) : null);
  }, [activeTool]);

  return (
    <div
      ref={containerRef}
      className="w-full h-full"
      style={{
        background: "#0A0A0D",
        cursor: activeTool && activeTool !== "select" ? "crosshair" : "default",
      }}
      data-testid="chart-container"
    />
  );
});

export default Chart;
