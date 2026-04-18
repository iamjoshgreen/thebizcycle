import { useCallback, useEffect, useRef, useState } from "react";
import { useGetChart, useRefreshChart } from "@workspace/api-client-react";
import {
  ColorType,
  createChart,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
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
              if (!isNaN(v) && v > 0) {
                setYScale(v);
                setYScaleSource("manual");
              }
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
      </div>
    </div>
  );
}
