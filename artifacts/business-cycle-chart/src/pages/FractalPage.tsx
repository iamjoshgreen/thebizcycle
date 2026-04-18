import { useCallback, useEffect, useRef, useState } from "react";
import { useGetChart, useRefreshChart } from "@workspace/api-client-react";
import {
  ColorType,
  createChart,
  LineSeries,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type MouseEventParams,
  type UTCTimestamp,
} from "lightweight-charts";
import TopBar from "@/components/TopBar";
import { useToast } from "@/hooks/use-toast";

const FRACTAL_START_ISO = "1994-11-18";
const FRACTAL_END_ISO = "2002-10-04";
const DEFAULT_RECENT_START_ISO = "2012-03-06";
const DEFAULT_ANCHOR_ISO = "2021-05-25";

function isoToUnix(iso: string): number {
  return Math.floor(new Date(iso + "T00:00:00Z").getTime() / 1000);
}

function unixToIso(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

function formatDateLabel(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default function FractalPage() {
  const { toast } = useToast();
  const { data: chartData, isLoading } = useGetChart();
  const refreshMutation = useRefreshChart();
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const recentSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const fractalSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);

  const [anchorDate, setAnchorDate] = useState(DEFAULT_ANCHOR_ISO);
  const [recentStartDate, setRecentStartDate] = useState(DEFAULT_RECENT_START_ISO);
  const [yScale, setYScale] = useState(0.64);

  // --- Measure tool state ---
  type MeasurePoint = { time: number; price: number };
  const [measureMode, setMeasureMode] = useState(false);
  const [pointA, setPointA] = useState<MeasurePoint | null>(null);
  const [pointB, setPointB] = useState<MeasurePoint | null>(null);
  const [cursor, setCursor] = useState<MeasurePoint | null>(null);
  const anchorLineARef = useRef<IPriceLine | null>(null);
  const anchorLineBRef = useRef<IPriceLine | null>(null);

  const payload = refreshMutation.data ?? chartData;
  const spxM2 = payload?.spxM2 ?? [];
  const lastUpdated = payload?.lastUpdated ?? null;

  const handleRefresh = useCallback(() => {
    refreshMutation.mutate(undefined, {
      onError: () =>
        toast({
          title: "Refresh failed",
          description: "Showing cached data",
          variant: "destructive",
        }),
    });
  }, [refreshMutation, toast]);

  // Initialize chart once
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const chart = createChart(container, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "#0A0A0D" },
        textColor: "rgba(200,200,220,0.65)",
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: "hsl(230 10% 11%)" },
        horzLines: { color: "hsl(230 10% 11%)" },
      },
      timeScale: {
        borderColor: "hsl(230 10% 16%)",
        rightOffset: 12,
        barSpacing: 3,
        minBarSpacing: 0.4,
      },
      rightPriceScale: {
        borderColor: "hsl(230 10% 16%)",
        mode: 1, // log
        scaleMargins: { top: 0.08, bottom: 0.08 },
      },
      crosshair: { mode: 1 },
    });
    chartRef.current = chart;

    const recent = chart.addSeries(LineSeries, {
      color: "#FF6D00",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
      title: "SPX/M2 today",
    });
    recentSeriesRef.current = recent;

    const fractal = chart.addSeries(LineSeries, {
      color: "rgba(251, 191, 36, 0.75)",
      lineWidth: 2,
      lineStyle: 2, // dashed for distinction
      priceLineVisible: false,
      lastValueVisible: false,
      title: "Dot-com fractal",
    });
    fractalSeriesRef.current = fractal;

    return () => {
      chart.remove();
      chartRef.current = null;
      recentSeriesRef.current = null;
      fractalSeriesRef.current = null;
    };
  }, []);

  // Update data when payload or settings change
  useEffect(() => {
    const chart = chartRef.current;
    const recentSeries = recentSeriesRef.current;
    const fractalSeries = fractalSeriesRef.current;
    if (!chart || !recentSeries || !fractalSeries || spxM2.length === 0) return;

    const recentStartTs = isoToUnix(recentStartDate);
    const anchorTs = isoToUnix(anchorDate);
    const fractalStartTs = isoToUnix(FRACTAL_START_ISO);
    const fractalEndTs = isoToUnix(FRACTAL_END_ISO);

    // Recent SPX/M2 — solid orange line from chosen start to today
    const recentData = spxM2
      .filter((p) => p.time >= recentStartTs)
      .map((p) => ({ time: p.time as UTCTimestamp, value: p.value }));
    recentSeries.setData(recentData);

    // Fractal slice — the dot-com era (SPX/M2 in 1994-2002)
    const fractalData = spxM2.filter(
      (p) => p.time >= fractalStartTs && p.time <= fractalEndTs,
    );
    if (fractalData.length === 0) {
      fractalSeries.setData([]);
      return;
    }

    const f0 = fractalData[0];

    // Find the SPX/M2 point at or just after the anchor date.
    // Snap to the actual data-point time so the fractal lines up exactly with
    // a real Friday on the recent series (avoids sub-day visual drift).
    const anchorPoint = spxM2.find((p) => p.time >= anchorTs);
    if (!anchorPoint || !f0.value || !isFinite(f0.value) || f0.value <= 0) {
      fractalSeries.setData([]);
      return;
    }
    const scaleRatio = (anchorPoint.value / f0.value) * yScale;
    const baseTime = anchorPoint.time; // align to a real Friday timestamp

    // Project fractal: time-shift so f0 → baseTime, value-scale by ratio × yScale
    const projected = fractalData
      .map((p) => ({
        time: (baseTime + (p.time - f0.time)) as UTCTimestamp,
        value: p.value * scaleRatio,
      }))
      .filter((p) => isFinite(p.value));
    fractalSeries.setData(projected);

    // Fit the visible range to span both series
    const lastRecent = recentData[recentData.length - 1]?.time ?? (Date.now() / 1000) as UTCTimestamp;
    const lastFractal = projected[projected.length - 1]?.time ?? lastRecent;
    const rightEdge = (Math.max(lastRecent as number, lastFractal as number) + 30 * 86400) as UTCTimestamp;
    chart.timeScale().setVisibleRange({
      from: recentStartTs as UTCTimestamp,
      to: rightEdge,
    });
  }, [spxM2, recentStartDate, anchorDate, yScale]);

  // Refs mirror A/B so the click handler always reads fresh values
  // without re-subscribing every state change.
  const pointARef = useRef<MeasurePoint | null>(null);
  const pointBRef = useRef<MeasurePoint | null>(null);
  useEffect(() => {
    pointARef.current = pointA;
  }, [pointA]);
  useEffect(() => {
    pointBRef.current = pointB;
  }, [pointB]);

  // --- Measure tool: clicks cycle A → B → reset (new A) ---
  useEffect(() => {
    const chart = chartRef.current;
    const recent = recentSeriesRef.current;
    if (!chart || !recent || !measureMode) return;

    const handler = (param: MouseEventParams) => {
      if (!param.point || param.time == null) return;
      const price = recent.coordinateToPrice(param.point.y);
      if (price == null || !isFinite(price)) return;
      const time = typeof param.time === "number" ? param.time : Number(param.time);
      if (!Number.isFinite(time)) return;
      const pt: MeasurePoint = { time, price };
      const a = pointARef.current;
      const b = pointBRef.current;
      if (!a) {
        setPointA(pt);
      } else if (!b) {
        setPointB(pt);
      } else {
        setPointA(pt);
        setPointB(null);
      }
    };
    chart.subscribeClick(handler);
    return () => chart.unsubscribeClick(handler);
  }, [measureMode]);

  // --- Measure tool: live cursor tracking (only while waiting for B) ---
  useEffect(() => {
    const chart = chartRef.current;
    const recent = recentSeriesRef.current;
    if (!chart || !recent || !measureMode || !pointA || pointB) {
      setCursor(null);
      return;
    }

    const handler = (param: MouseEventParams) => {
      if (!param.point || param.time == null) {
        setCursor(null);
        return;
      }
      const price = recent.coordinateToPrice(param.point.y);
      if (price == null || !isFinite(price)) {
        setCursor(null);
        return;
      }
      const time = typeof param.time === "number" ? param.time : Number(param.time);
      if (!Number.isFinite(time)) {
        setCursor(null);
        return;
      }
      setCursor({ time, price });
    };
    chart.subscribeCrosshairMove(handler);
    return () => {
      chart.unsubscribeCrosshairMove(handler);
      setCursor(null);
    };
  }, [measureMode, pointA, pointB]);

  // --- Measure tool: dashed gold price lines at A and B ---
  useEffect(() => {
    const series = recentSeriesRef.current;
    if (!series || !pointA) return;
    const line = series.createPriceLine({
      price: pointA.price,
      color: "rgba(251,191,36,0.85)",
      lineWidth: 1,
      lineStyle: 2,
      axisLabelVisible: true,
      title: "A",
    });
    anchorLineARef.current = line;
    return () => {
      try {
        series.removePriceLine(line);
      } catch {
        /* series may already be destroyed */
      }
      anchorLineARef.current = null;
    };
  }, [pointA?.price]);

  useEffect(() => {
    const series = recentSeriesRef.current;
    if (!series || !pointB) return;
    const line = series.createPriceLine({
      price: pointB.price,
      color: "rgba(251,191,36,0.85)",
      lineWidth: 1,
      lineStyle: 2,
      axisLabelVisible: true,
      title: "B",
    });
    anchorLineBRef.current = line;
    return () => {
      try {
        series.removePriceLine(line);
      } catch {
        /* series may already be destroyed */
      }
      anchorLineBRef.current = null;
    };
  }, [pointB?.price]);

  // --- Measure tool: Esc clears + exits ---
  useEffect(() => {
    if (!measureMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMeasureMode(false);
        setPointA(null);
        setPointB(null);
        setCursor(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [measureMode]);

  // --- Derived readout (locked A→B, or live A→cursor) ---
  const readout = (() => {
    if (!pointA) return null;
    const endpoint = pointB ?? cursor;
    if (!endpoint) return null;
    const t1 = Math.min(pointA.time, endpoint.time);
    const t2 = Math.max(pointA.time, endpoint.time);
    const p1 = pointA.time <= endpoint.time ? pointA.price : endpoint.price;
    const p2 = pointA.time <= endpoint.time ? endpoint.price : pointA.price;
    const days = Math.round((t2 - t1) / 86400);
    const weeks = (days / 7).toFixed(1);
    const months = (days / 30.44).toFixed(1);
    const years = (days / 365.25).toFixed(2);
    const dPrice = p2 - p1;
    const pct = p1 !== 0 ? (dPrice / p1) * 100 : 0;
    return {
      locked: !!pointB,
      aTime: pointA.time,
      aPrice: pointA.price,
      bTime: endpoint.time,
      bPrice: endpoint.price,
      t1,
      t2,
      days,
      weeks,
      months,
      years,
      dPrice,
      pct,
    };
  })();

  const fractalSpanYears = (
    (isoToUnix(FRACTAL_END_ISO) - isoToUnix(FRACTAL_START_ISO)) /
    (365.25 * 86400)
  ).toFixed(1);

  const inputStyle = {
    background: "hsl(230 12% 12%)",
    color: "rgba(200,200,220,0.85)",
    border: "1px solid hsl(230 10% 18%)",
    borderRadius: "4px",
    padding: "3px 8px",
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: "11px",
    colorScheme: "dark" as const,
  };

  return (
    <div
      className="flex flex-col w-full h-full overflow-hidden"
      style={{ background: "#0A0A0D" }}
    >
      <TopBar
        lastUpdated={lastUpdated ?? null}
        isRefreshing={refreshMutation.isPending}
        onRefresh={handleRefresh}
      />

      {/* Controls row */}
      <div
        className="flex items-center gap-4 px-4 py-2 flex-shrink-0 flex-wrap"
        style={{ borderBottom: "1px solid hsl(230 10% 12%)" }}
      >
        <span
          style={{
            color: "rgba(200,200,220,0.4)",
            fontSize: "10px",
            fontFamily: "'JetBrains Mono', monospace",
            letterSpacing: "0.05em",
          }}
        >
          DOT-COM FRACTAL · {formatDateLabel(isoToUnix(FRACTAL_START_ISO))} → {formatDateLabel(isoToUnix(FRACTAL_END_ISO))} · {fractalSpanYears} years
        </span>

        <div style={{ width: "1px", height: "18px", background: "hsl(230 10% 16%)" }} />

        <label
          className="flex items-center gap-2"
          style={{
            color: "rgba(200,200,220,0.55)",
            fontSize: "11px",
            fontFamily: "'Inter', sans-serif",
          }}
        >
          Anchor fractal at
          <input
            type="date"
            value={anchorDate}
            min="2009-01-01"
            max="2026-12-31"
            onChange={(e) => setAnchorDate(e.target.value)}
            style={inputStyle}
            data-testid="input-anchor-date"
          />
        </label>

        <label
          className="flex items-center gap-2"
          style={{
            color: "rgba(200,200,220,0.55)",
            fontSize: "11px",
            fontFamily: "'Inter', sans-serif",
          }}
        >
          SPX/M2 from
          <input
            type="date"
            value={recentStartDate}
            min="1980-01-01"
            max="2020-12-31"
            onChange={(e) => setRecentStartDate(e.target.value)}
            style={inputStyle}
            data-testid="input-start-date"
          />
        </label>

        <div style={{ width: "1px", height: "18px", background: "hsl(230 10% 16%)" }} />

        <label
          className="flex items-center gap-2"
          style={{
            color: "rgba(200,200,220,0.55)",
            fontSize: "11px",
            fontFamily: "'Inter', sans-serif",
          }}
          title="Multiplier on the fractal's vertical scale. 1.0 = anchor first point exactly. <1 = pull fractal down, >1 = push up."
        >
          Y-scale
          <input
            type="number"
            value={yScale}
            step={0.05}
            min={0.2}
            max={2}
            onChange={(e) => {
              const v = parseFloat(e.target.value);
              if (!isNaN(v) && v > 0) setYScale(v);
            }}
            style={{ ...inputStyle, width: "70px" }}
            data-testid="input-yscale"
          />
        </label>

        <button
          onClick={() => setYScale(1.0)}
          title="Reset Y-scale to 1.0 (anchor-only scaling)"
          style={{
            padding: "3px 8px",
            borderRadius: "4px",
            fontSize: "11px",
            fontFamily: "'Inter', sans-serif",
            cursor: "pointer",
            background: "transparent",
            border: "1px solid hsl(230 10% 18%)",
            color: "rgba(200,200,220,0.5)",
          }}
          data-testid="button-reset-yscale"
        >
          Reset
        </button>

        <div style={{ width: "1px", height: "18px", background: "hsl(230 10% 16%)" }} />

        <button
          onClick={() => {
            setMeasureMode((m) => !m);
            setPointA(null);
            setPointB(null);
            setCursor(null);
          }}
          title={
            measureMode
              ? "Exit measure mode (Esc)"
              : "Click to set A (live readout follows mouse), click again to lock B"
          }
          style={{
            padding: "3px 10px",
            borderRadius: "4px",
            fontSize: "11px",
            fontFamily: "'Inter', sans-serif",
            cursor: "pointer",
            transition: "all 0.15s",
            background: measureMode ? "rgba(251,191,36,0.15)" : "transparent",
            border: measureMode
              ? "1px solid rgba(251,191,36,0.6)"
              : "1px solid hsl(230 10% 18%)",
            color: measureMode ? "rgba(251,191,36,0.95)" : "rgba(200,200,220,0.65)",
          }}
          data-testid="button-measure"
        >
          {measureMode
            ? !pointA
              ? "Measure: pick A"
              : !pointB
                ? "Measure: pick B (live)"
                : "Measure: locked · click to restart"
            : "Measure"}
        </button>
      </div>

      <div className="relative flex-1 overflow-hidden">
        {isLoading && !chartData && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3">
            <div
              className="w-5 h-5 rounded-full border-2 border-transparent animate-spin"
              style={{
                borderTopColor: "hsl(224 100% 58%)",
                borderRightColor: "hsl(224 100% 58% / 0.3)",
              }}
            />
            <span
              style={{
                color: "hsl(220 10% 40%)",
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: "12px",
              }}
            >
              Fetching market data…
            </span>
          </div>
        )}

        {/* Legend */}
        {spxM2.length > 0 && (
          <div
            className="absolute top-3 left-4 z-10 flex flex-col gap-1.5 px-3 py-2 rounded"
            style={{
              background: "hsl(230 14% 9% / 0.78)",
              backdropFilter: "blur(8px)",
              border: "1px solid hsl(230 10% 16%)",
              pointerEvents: "none",
              minWidth: "260px",
            }}
          >
            <div
              style={{
                color: "rgba(200,200,220,0.4)",
                fontSize: "9px",
                fontFamily: "'JetBrains Mono', monospace",
                letterSpacing: "0.08em",
              }}
            >
              SPX ÷ M2 MONEY SUPPLY (WM2NS)
            </div>
            <div className="flex items-center gap-2">
              <div className="w-4 h-px" style={{ background: "#FF6D00" }} />
              <span
                style={{
                  color: "rgba(220,220,235,0.85)",
                  fontFamily: "'Inter', sans-serif",
                  fontSize: "11px",
                }}
              >
                Today's market
              </span>
            </div>
            <div className="flex items-center gap-2">
              <div
                className="w-4"
                style={{
                  height: "2px",
                  background:
                    "repeating-linear-gradient(to right, rgba(251,191,36,0.85) 0 4px, transparent 4px 7px)",
                }}
              />
              <span
                style={{
                  color: "rgba(220,220,235,0.85)",
                  fontFamily: "'Inter', sans-serif",
                  fontSize: "11px",
                }}
              >
                Dot-com fractal (scaled & shifted)
              </span>
            </div>
            <div
              style={{
                color: "rgba(200,200,220,0.4)",
                fontSize: "9px",
                fontFamily: "'JetBrains Mono', monospace",
                marginTop: "2px",
              }}
            >
              Slide the anchor to align dips
            </div>
          </div>
        )}

        <div ref={containerRef} className="absolute inset-0" />

        {/* Measure tool: hint when no A yet */}
        {measureMode && !pointA && (
          <div
            className="absolute bottom-3 right-16 z-10 px-3 py-2 rounded"
            style={{
              background: "hsl(230 14% 9% / 0.85)",
              backdropFilter: "blur(8px)",
              border: "1px solid rgba(251,191,36,0.45)",
              fontFamily: "'JetBrains Mono', monospace",
              color: "rgba(251,191,36,0.85)",
              fontSize: "11px",
            }}
          >
            Click chart to drop anchor · Esc to exit
          </div>
        )}

        {/* Live measure readout */}
        {readout && (
          <div
            className="absolute bottom-3 right-16 z-10 px-3 py-2 rounded"
            style={{
              background: "hsl(230 14% 9% / 0.9)",
              backdropFilter: "blur(8px)",
              border: "1px solid rgba(251,191,36,0.45)",
              minWidth: "260px",
              fontFamily: "'JetBrains Mono', monospace",
            }}
            data-testid="panel-measure-readout"
          >
            <div
              style={{
                color: "rgba(251,191,36,0.85)",
                fontSize: "9px",
                letterSpacing: "0.08em",
                marginBottom: "4px",
              }}
            >
              {readout.locked ? "MEASURE · LOCKED" : "MEASURE · LIVE"}
            </div>
            <div
              style={{
                color: "rgba(200,200,220,0.6)",
                fontSize: "10px",
                marginBottom: "6px",
                lineHeight: "1.4",
              }}
            >
              <div>
                A: {formatDateLabel(readout.aTime)} @{" "}
                {readout.aPrice.toFixed(4)}
              </div>
              <div>
                B: {formatDateLabel(readout.bTime)} @{" "}
                {readout.bPrice.toFixed(4)}
              </div>
            </div>
            <div
              className="flex justify-between gap-3"
              style={{
                color: "rgba(220,220,235,0.9)",
                fontSize: "11px",
                lineHeight: "1.5",
              }}
            >
              <div>
                <div style={{ color: "rgba(200,200,220,0.5)", fontSize: "9px" }}>
                  TIME
                </div>
                <div>{readout.days}d</div>
                <div style={{ color: "rgba(200,200,220,0.6)" }}>
                  {readout.weeks}w · {readout.months}mo · {readout.years}y
                </div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ color: "rgba(200,200,220,0.5)", fontSize: "9px" }}>
                  Δ PRICE
                </div>
                <div>
                  {readout.dPrice >= 0 ? "+" : ""}
                  {readout.dPrice.toFixed(4)}
                </div>
                <div
                  style={{
                    color: readout.pct >= 0 ? "#4ade80" : "#f87171",
                    fontWeight: 500,
                  }}
                >
                  {readout.pct >= 0 ? "+" : ""}
                  {readout.pct.toFixed(2)}%
                </div>
              </div>
            </div>
            <div
              style={{
                color: "rgba(200,200,220,0.4)",
                fontSize: "9px",
                marginTop: "6px",
                paddingTop: "6px",
                borderTop: "1px solid hsl(230 10% 16%)",
              }}
            >
              {readout.locked
                ? "Click to start a new measurement · Esc to clear"
                : "Click to lock B · Esc to cancel"}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
