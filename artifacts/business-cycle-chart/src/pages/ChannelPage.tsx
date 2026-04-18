import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useGetChart, useRefreshChart } from "@workspace/api-client-react";
import {
  ColorType,
  createChart,
  LineSeries,
  type IChartApi,
  type IPrimitivePaneRenderer,
  type IPrimitivePaneView,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import TopBar from "@/components/TopBar";
import { useToast } from "@/hooks/use-toast";

const CHANNEL_START_ISO = "2020-02-01";
const DEFAULT_A_DATE = "2020-03-23";
const DEFAULT_A_PRICE = 2237;
const DEFAULT_B_DATE = "2025-04-04";
const DEFAULT_B_PRICE = 5000;
const DEFAULT_HEIGHT = 1500;

function isoToUnix(iso: string): number {
  return Math.floor(new Date(iso + "T00:00:00Z").getTime() / 1000);
}

function clampPositive(n: number, fallback: number): number {
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// ─── Channel Band Primitive (shaded fill between upper + lower lines) ────────

interface ChannelMath {
  aTime: number;
  aPrice: number;
  bTime: number;
  bPrice: number;
  height: number;
}

class ChannelBandRenderer implements IPrimitivePaneRenderer {
  constructor(
    private _math: ChannelMath,
    private _chart: IChartApi,
    private _series: ISeriesApi<"Line">,
  ) {}

  draw(target: Parameters<IPrimitivePaneRenderer["draw"]>[0]): void {
    const { aTime, aPrice, bTime, bPrice, height } = this._math;
    if (bTime === aTime) return;

    const slope = (bPrice - aPrice) / (bTime - aTime);
    const lowerAt = (t: number): number => aPrice + slope * (t - aTime);

    const ts = this._chart.timeScale();
    const range = ts.getVisibleRange();
    if (!range) return;

    const tL = Number(range.from);
    const tR = Number(range.to);
    if (!Number.isFinite(tL) || !Number.isFinite(tR)) return;

    const lowL = lowerAt(tL);
    const lowR = lowerAt(tR);
    const upL = lowL + height;
    const upR = lowR + height;

    const xL = ts.timeToCoordinate(tL as UTCTimestamp);
    const xR = ts.timeToCoordinate(tR as UTCTimestamp);
    const yLowL = this._series.priceToCoordinate(lowL);
    const yLowR = this._series.priceToCoordinate(lowR);
    const yUpL = this._series.priceToCoordinate(upL);
    const yUpR = this._series.priceToCoordinate(upR);

    if (
      xL == null ||
      xR == null ||
      yLowL == null ||
      yLowR == null ||
      yUpL == null ||
      yUpR == null
    )
      return;

    target.useBitmapCoordinateSpace(
      ({ context: ctx, horizontalPixelRatio: hpr, verticalPixelRatio: vpr }) => {
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(xL * hpr, yUpL * vpr);
        ctx.lineTo(xR * hpr, yUpR * vpr);
        ctx.lineTo(xR * hpr, yLowR * vpr);
        ctx.lineTo(xL * hpr, yLowL * vpr);
        ctx.closePath();
        ctx.fillStyle = "rgba(41, 98, 255, 0.18)";
        ctx.fill();
        ctx.restore();
      },
    );
  }
}

class ChannelBandPaneView implements IPrimitivePaneView {
  constructor(
    private _math: ChannelMath,
    private _chart: IChartApi,
    private _series: ISeriesApi<"Line">,
  ) {}
  zOrder(): "bottom" {
    return "bottom";
  }
  renderer(): IPrimitivePaneRenderer {
    return new ChannelBandRenderer(this._math, this._chart, this._series);
  }
}

class ChannelBandPrimitive {
  constructor(
    private _math: ChannelMath,
    private _chart: IChartApi,
    private _series: ISeriesApi<"Line">,
  ) {}
  paneViews() {
    return [new ChannelBandPaneView(this._math, this._chart, this._series)];
  }
  priceAxisViews() {
    return [];
  }
  timeAxisViews() {
    return [];
  }
  priceAxisPaneViews() {
    return [];
  }
  timeAxisPaneViews() {
    return [];
  }
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function ChannelPage() {
  const { toast } = useToast();
  const { data: chartData, isLoading } = useGetChart();
  const refreshMutation = useRefreshChart();

  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const spxSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const lowerSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const upperSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const midSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const primitiveRef = useRef<ChannelBandPrimitive | null>(null);

  const [aDate, setADate] = useState(DEFAULT_A_DATE);
  const [aPrice, setAPrice] = useState(String(DEFAULT_A_PRICE));
  const [bDate, setBDate] = useState(DEFAULT_B_DATE);
  const [bPrice, setBPrice] = useState(String(DEFAULT_B_PRICE));
  const [height, setHeight] = useState(String(DEFAULT_HEIGHT));

  const payload = refreshMutation.data ?? chartData;
  const spx = payload?.spx ?? [];
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
        mode: 0, // linear (matches the reference screenshot)
        scaleMargins: { top: 0.08, bottom: 0.08 },
      },
      crosshair: { mode: 1 },
    });
    chartRef.current = chart;

    const spxSeries = chart.addSeries(LineSeries, {
      color: "#FF6D00",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
      title: "SPX",
    });
    spxSeriesRef.current = spxSeries;

    const lower = chart.addSeries(LineSeries, {
      color: "rgba(41, 98, 255, 0.95)",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      title: "",
      crosshairMarkerVisible: false,
    });
    lowerSeriesRef.current = lower;

    const upper = chart.addSeries(LineSeries, {
      color: "rgba(41, 98, 255, 0.95)",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      title: "",
      crosshairMarkerVisible: false,
    });
    upperSeriesRef.current = upper;

    const mid = chart.addSeries(LineSeries, {
      color: "rgba(41, 98, 255, 0.6)",
      lineWidth: 1,
      lineStyle: 2, // dashed
      priceLineVisible: false,
      lastValueVisible: false,
      title: "",
      crosshairMarkerVisible: false,
    });
    midSeriesRef.current = mid;

    return () => {
      chart.remove();
      chartRef.current = null;
      spxSeriesRef.current = null;
      lowerSeriesRef.current = null;
      upperSeriesRef.current = null;
      midSeriesRef.current = null;
      primitiveRef.current = null;
    };
  }, []);

  // Sanitized numeric anchors
  const math = useMemo<ChannelMath>(() => {
    return {
      aTime: isoToUnix(aDate),
      aPrice: clampPositive(parseFloat(aPrice), DEFAULT_A_PRICE),
      bTime: isoToUnix(bDate),
      bPrice: clampPositive(parseFloat(bPrice), DEFAULT_B_PRICE),
      height: clampPositive(parseFloat(height), DEFAULT_HEIGHT),
    };
  }, [aDate, aPrice, bDate, bPrice, height]);

  // Update data + channel lines + shaded band
  useEffect(() => {
    const chart = chartRef.current;
    const spxSeries = spxSeriesRef.current;
    const lower = lowerSeriesRef.current;
    const upper = upperSeriesRef.current;
    const mid = midSeriesRef.current;
    if (!chart || !spxSeries || !lower || !upper || !mid) return;

    // Helper: wipe channel overlay (lines + band) for invalid states so stale
    // visuals don't persist when inputs are bad or data is missing.
    const clearChannel = () => {
      lower.setData([]);
      upper.setData([]);
      mid.setData([]);
      if (primitiveRef.current) {
        try {
          spxSeries.detachPrimitive(primitiveRef.current as never);
        } catch {
          /* ok */
        }
        primitiveRef.current = null;
      }
    };

    if (spx.length === 0) {
      spxSeries.setData([]);
      clearChannel();
      return;
    }

    const startTs = isoToUnix(CHANNEL_START_ISO);
    const visible = spx.filter((p) => p.time >= startTs);
    if (visible.length === 0) {
      spxSeries.setData([]);
      clearChannel();
      return;
    }

    spxSeries.setData(
      visible.map((p) => ({ time: p.time as UTCTimestamp, value: p.value })),
    );

    const { aTime, aPrice: aP, bTime, bPrice: bP, height: h } = math;
    if (
      !Number.isFinite(aTime) ||
      !Number.isFinite(bTime) ||
      bTime === aTime
    ) {
      clearChannel();
      return;
    }
    const slope = (bP - aP) / (bTime - aTime);
    const lowerAt = (t: number) => aP + slope * (t - aTime);

    const lowerData = visible.map((p) => ({
      time: p.time as UTCTimestamp,
      value: lowerAt(p.time),
    }));
    const upperData = visible.map((p) => ({
      time: p.time as UTCTimestamp,
      value: lowerAt(p.time) + h,
    }));
    const midData = visible.map((p) => ({
      time: p.time as UTCTimestamp,
      value: lowerAt(p.time) + h / 2,
    }));
    lower.setData(lowerData);
    upper.setData(upperData);
    mid.setData(midData);

    // (Re)attach shaded band primitive
    if (primitiveRef.current) {
      try {
        spxSeries.detachPrimitive(primitiveRef.current as never);
      } catch {
        /* ok */
      }
    }
    const prim = new ChannelBandPrimitive(math, chart, spxSeries);
    primitiveRef.current = prim;
    spxSeries.attachPrimitive(prim as never);

    // Fit visible range to channel window
    const lastTs = visible[visible.length - 1].time;
    chart.timeScale().setVisibleRange({
      from: startTs as UTCTimestamp,
      to: (lastTs + 30 * 86400) as UTCTimestamp,
    });
  }, [spx, math]);

  const inputStyle: React.CSSProperties = {
    background: "hsl(230 12% 12%)",
    color: "rgba(200,200,220,0.85)",
    border: "1px solid hsl(230 10% 18%)",
    borderRadius: "4px",
    padding: "3px 6px",
    fontSize: "11px",
    fontFamily: "'JetBrains Mono', monospace",
    width: "120px",
  };
  const numberInputStyle: React.CSSProperties = { ...inputStyle, width: "80px" };
  const labelStyle: React.CSSProperties = {
    color: "rgba(200,200,220,0.55)",
    fontSize: "10px",
    fontFamily: "'JetBrains Mono', monospace",
    letterSpacing: "0.04em",
  };

  return (
    <div className="flex flex-col h-screen" style={{ background: "#0A0A0D" }}>
      <TopBar
        lastUpdated={lastUpdated}
        isRefreshing={refreshMutation.isPending}
        onRefresh={handleRefresh}
      />

      {/* Controls bar */}
      <div
        className="flex items-center gap-4 px-5 py-2 border-b shrink-0"
        style={{
          background: "hsl(230 14% 9%)",
          borderColor: "hsl(230 10% 14%)",
        }}
      >
        <span
          style={{
            color: "rgba(41,98,255,0.85)",
            fontSize: "10px",
            fontFamily: "'JetBrains Mono', monospace",
            letterSpacing: "0.08em",
          }}
        >
          PARALLEL CHANNEL · SPX · Feb 2020 → today
        </span>

        <div style={{ width: "1px", height: "18px", background: "hsl(230 10% 16%)" }} />

        <label className="flex items-center gap-2">
          <span style={labelStyle}>Anchor A</span>
          <input
            type="date"
            value={aDate}
            onChange={(e) => setADate(e.target.value)}
            style={inputStyle}
            data-testid="input-a-date"
          />
          <input
            type="number"
            step="any"
            value={aPrice}
            onChange={(e) => setAPrice(e.target.value)}
            style={numberInputStyle}
            data-testid="input-a-price"
          />
        </label>

        <label className="flex items-center gap-2">
          <span style={labelStyle}>Anchor B</span>
          <input
            type="date"
            value={bDate}
            onChange={(e) => setBDate(e.target.value)}
            style={inputStyle}
            data-testid="input-b-date"
          />
          <input
            type="number"
            step="any"
            value={bPrice}
            onChange={(e) => setBPrice(e.target.value)}
            style={numberInputStyle}
            data-testid="input-b-price"
          />
        </label>

        <label className="flex items-center gap-2">
          <span style={labelStyle}>Height</span>
          <input
            type="number"
            step="any"
            value={height}
            onChange={(e) => setHeight(e.target.value)}
            style={numberInputStyle}
            data-testid="input-height"
          />
        </label>

        <button
          onClick={() => {
            setADate(DEFAULT_A_DATE);
            setAPrice(String(DEFAULT_A_PRICE));
            setBDate(DEFAULT_B_DATE);
            setBPrice(String(DEFAULT_B_PRICE));
            setHeight(String(DEFAULT_HEIGHT));
          }}
          title="Reset channel anchors to defaults"
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
          data-testid="button-reset-channel"
        >
          Reset
        </button>
      </div>

      <div className="relative flex-1 overflow-hidden">
        {isLoading && !chartData && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3">
            <span
              style={{
                color: "rgba(200,200,220,0.5)",
                fontSize: "12px",
                fontFamily: "'JetBrains Mono', monospace",
              }}
            >
              Loading SPX…
            </span>
          </div>
        )}

        {/* Legend */}
        <div
          className="absolute top-3 left-3 z-10 px-3 py-2 rounded"
          style={{
            background: "hsl(230 14% 9% / 0.85)",
            backdropFilter: "blur(8px)",
            border: "1px solid hsl(230 10% 14%)",
            fontFamily: "'JetBrains Mono', monospace",
          }}
        >
          <div
            style={{
              color: "rgba(200,200,220,0.45)",
              fontSize: "9px",
              letterSpacing: "0.08em",
              marginBottom: "4px",
            }}
          >
            S&amp;P 500 · WEEKLY
          </div>
          <div
            className="flex items-center gap-2"
            style={{ color: "rgba(220,220,235,0.85)", fontSize: "11px", marginBottom: "3px" }}
          >
            <span
              style={{
                display: "inline-block",
                width: "12px",
                height: "2px",
                background: "#FF6D00",
              }}
            />
            SPX price
          </div>
          <div
            className="flex items-center gap-2"
            style={{ color: "rgba(220,220,235,0.85)", fontSize: "11px", marginBottom: "3px" }}
          >
            <span
              style={{
                display: "inline-block",
                width: "12px",
                height: "2px",
                background: "rgba(41, 98, 255, 0.95)",
              }}
            />
            Channel bounds (parallel)
          </div>
          <div
            className="flex items-center gap-2"
            style={{ color: "rgba(220,220,235,0.7)", fontSize: "11px" }}
          >
            <span
              style={{
                display: "inline-block",
                width: "12px",
                height: "0",
                borderTop: "1px dashed rgba(41, 98, 255, 0.6)",
              }}
            />
            Midline
          </div>
          <div
            style={{
              color: "rgba(200,200,220,0.4)",
              fontSize: "10px",
              marginTop: "6px",
              maxWidth: "240px",
              lineHeight: "1.4",
            }}
          >
            Tweak anchors above to refine the channel.
          </div>
        </div>

        <div ref={containerRef} className="absolute inset-0" />
      </div>
    </div>
  );
}
