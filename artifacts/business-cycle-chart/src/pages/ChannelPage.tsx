import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useGetChart, useRefreshChart } from "@workspace/api-client-react";
import {
  ColorType,
  createChart,
  LineSeries,
  type IChartApi,
  type IPriceLine,
  type IPrimitivePaneRenderer,
  type IPrimitivePaneView,
  type ISeriesApi,
  type MouseEventParams,
  type UTCTimestamp,
} from "lightweight-charts";
import TopBar from "@/components/TopBar";
import { useToast } from "@/hooks/use-toast";

const SPX_START_ISO = "2018-01-01";       // SPX history shown
const CHANNEL_START_ISO = "2020-02-01";   // channel only valid from here
const CHANNEL_FUTURE_DAYS = 180;          // extend channel ~6 months past today
// Defaults are derived from the TradingView parallel-channel anchors:
// upper rail through (2020-02-10, 3416.45) and (2026-05-18, 7232.15),
// channel width 1366.57. A & B are those two points shifted down by the
// width to define the lower rail; C sits on the upper rail at the same
// time as A so the parallel offset matches TV exactly.
const DEFAULT_A_DATE = "2020-02-10";
const DEFAULT_A_PRICE = 2049.88;
const DEFAULT_B_DATE = "2026-05-18";
const DEFAULT_B_PRICE = 5865.58;
const DEFAULT_C_DATE = "2020-02-10";
const DEFAULT_C_PRICE = 3416.45;

function isoToUnix(iso: string): number {
  return Math.floor(new Date(iso + "T00:00:00Z").getTime() / 1000);
}

function clampPositive(n: number, fallback: number): number {
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function formatDateLabel(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// ─── Channel Band Primitive (shaded fill between upper + lower lines) ────────

interface ChannelMath {
  aTime: number;
  aPrice: number;
  bTime: number;
  bPrice: number;
  cTime: number;
  cPrice: number;
}

class ChannelBandRenderer implements IPrimitivePaneRenderer {
  constructor(
    private _math: ChannelMath,
    private _chart: IChartApi,
    private _series: ISeriesApi<"Line">,
  ) {}

  draw(target: Parameters<IPrimitivePaneRenderer["draw"]>[0]): void {
    // Wrap entire draw in try/catch: lightweight-charts can schedule a draw
    // after the chart/series has been disposed (e.g. during HMR or fast
    // navigation), throwing "Object is disposed". That's a benign race —
    // we just skip the frame.
    try {
      const { aTime, aPrice, bTime, bPrice, cTime, cPrice } = this._math;
      if (bTime === aTime) return;

      // A→B defines one trend rail. C is the parallel anchor: the second rail
      // is the same slope, shifted vertically so it passes exactly through C.
      const slope = (bPrice - aPrice) / (bTime - aTime);
      const railOneAt = (t: number): number => aPrice + slope * (t - aTime);
      const offset = cPrice - railOneAt(cTime);
      const railTwoAt = (t: number): number => railOneAt(t) + offset;

      const ts = this._chart.timeScale();
      const range = ts.getVisibleRange();
      if (!range) return;

      const tL = Number(range.from);
      const tR = Number(range.to);
      if (!Number.isFinite(tL) || !Number.isFinite(tR)) return;

      // Sort so the band always fills between actual lower and upper rails,
      // regardless of whether C sits above or below the A-B line.
      const r1L = railOneAt(tL);
      const r1R = railOneAt(tR);
      const r2L = railTwoAt(tL);
      const r2R = railTwoAt(tR);
      const lowL = Math.min(r1L, r2L);
      const lowR = Math.min(r1R, r2R);
      const upL = Math.max(r1L, r2L);
      const upR = Math.max(r1R, r2R);

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
    } catch {
      /* chart was disposed mid-frame; safe to skip */
    }
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
  const [cDate, setCDate] = useState(DEFAULT_C_DATE);
  const [cPrice, setCPrice] = useState(String(DEFAULT_C_PRICE));

  // --- Measure tool state ---
  type MeasurePoint = { time: number; price: number };
  const [measureMode, setMeasureMode] = useState(false);
  const [pointA, setPointA] = useState<MeasurePoint | null>(null);
  const [pointB, setPointB] = useState<MeasurePoint | null>(null);
  const [cursor, setCursor] = useState<MeasurePoint | null>(null);
  const anchorLineARef = useRef<IPriceLine | null>(null);
  const anchorLineBRef = useRef<IPriceLine | null>(null);

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

  // Track disposal so any callback that races teardown can bail out.
  const disposedRef = useRef(false);

  // Initialize chart once
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    disposedRef.current = false;

    const chart = createChart(container, {
      width: container.clientWidth || 800,
      height: container.clientHeight || 600,
      autoSize: false,
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
        mode: 1, // log — matches Chart and Fractal pages so SPX shape is consistent everywhere
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

    // Own the resize lifecycle. autoSize:true uses an internal ResizeObserver
    // that can fire callbacks AFTER chart.remove(), throwing "Object is
    // disposed". Owning it ourselves lets us disconnect first and guard with
    // disposedRef.
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
        /* chart was torn down between rAF and our callback */
      }
    });
    ro.observe(container);

    return () => {
      // Order matters:
      //   1. Mark disposed so any in-flight callback bails out.
      //   2. Disconnect the observer so no new resize fires.
      //   3. Detach the band primitive so its draw() can't run on a dead chart.
      //   4. Finally remove the chart.
      disposedRef.current = true;
      try {
        ro.disconnect();
      } catch {
        /* ok */
      }
      if (primitiveRef.current && spxSeriesRef.current) {
        try {
          spxSeriesRef.current.detachPrimitive(primitiveRef.current as never);
        } catch {
          /* ok */
        }
      }
      primitiveRef.current = null;
      try {
        chart.remove();
      } catch {
        /* ok */
      }
      chartRef.current = null;
      spxSeriesRef.current = null;
      lowerSeriesRef.current = null;
      upperSeriesRef.current = null;
      midSeriesRef.current = null;
    };
  }, []);

  // Sanitized numeric anchors
  const math = useMemo<ChannelMath>(() => {
    return {
      aTime: isoToUnix(aDate),
      aPrice: clampPositive(parseFloat(aPrice), DEFAULT_A_PRICE),
      bTime: isoToUnix(bDate),
      bPrice: clampPositive(parseFloat(bPrice), DEFAULT_B_PRICE),
      cTime: isoToUnix(cDate),
      cPrice: clampPositive(parseFloat(cPrice), DEFAULT_C_PRICE),
    };
  }, [aDate, aPrice, bDate, bPrice, cDate, cPrice]);

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

    // SPX: show extended history (e.g. since 2018) — gives context before the
    // channel begins.
    const spxStartTs = isoToUnix(SPX_START_ISO);
    const spxVisible = spx.filter((p) => p.time >= spxStartTs);
    if (spxVisible.length === 0) {
      spxSeries.setData([]);
      clearChannel();
      return;
    }
    spxSeries.setData(
      spxVisible.map((p) => ({ time: p.time as UTCTimestamp, value: p.value })),
    );

    const { aTime, aPrice: aP, bTime, bPrice: bP, cTime, cPrice: cP } = math;
    if (
      !Number.isFinite(aTime) ||
      !Number.isFinite(bTime) ||
      !Number.isFinite(cTime) ||
      bTime === aTime
    ) {
      clearChannel();
      return;
    }
    const slope = (bP - aP) / (bTime - aTime);
    const railOneAt = (t: number) => aP + slope * (t - aTime);
    const offset = cP - railOneAt(cTime);
    const railTwoAt = (t: number) => railOneAt(t) + offset;
    const lowerAt = (t: number) => Math.min(railOneAt(t), railTwoAt(t));
    const upperAt = (t: number) => Math.max(railOneAt(t), railTwoAt(t));
    const midAt = (t: number) => (railOneAt(t) + railTwoAt(t)) / 2;

    // Build the channel timeline: every weekly Friday tick that we already
    // have SPX data for (>= channel start) plus synthetic future Fridays so
    // the channel extends to the right of today's last bar — letting you
    // watch price approach the rails.
    const channelStartTs = isoToUnix(CHANNEL_START_ISO);
    const channelHistTimes = spxVisible
      .filter((p) => p.time >= channelStartTs)
      .map((p) => p.time);
    if (channelHistTimes.length === 0) {
      clearChannel();
      return;
    }
    const lastSpxTs = channelHistTimes[channelHistTimes.length - 1];
    const futureSteps = Math.floor(CHANNEL_FUTURE_DAYS / 7);
    const futureTimes: number[] = [];
    for (let i = 1; i <= futureSteps; i++) {
      futureTimes.push(lastSpxTs + i * 7 * 86400);
    }
    const channelTimes = [...channelHistTimes, ...futureTimes];

    const lowerData = channelTimes.map((t) => ({
      time: t as UTCTimestamp,
      value: lowerAt(t),
    }));
    const upperData = channelTimes.map((t) => ({
      time: t as UTCTimestamp,
      value: upperAt(t),
    }));
    const midData = channelTimes.map((t) => ({
      time: t as UTCTimestamp,
      value: midAt(t),
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

    // Fit visible range: from SPX start through ~CHANNEL_FUTURE_DAYS past today
    chart.timeScale().setVisibleRange({
      from: spxStartTs as UTCTimestamp,
      to: (lastSpxTs + (CHANNEL_FUTURE_DAYS + 14) * 86400) as UTCTimestamp,
    });
  }, [spx, math]);

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
    const spxSeries = spxSeriesRef.current;
    if (!chart || !spxSeries || !measureMode) return;

    const handler = (param: MouseEventParams) => {
      if (!param.point || param.time == null) return;
      const price = spxSeries.coordinateToPrice(param.point.y);
      if (price == null || !isFinite(price)) return;
      const time = typeof param.time === "number" ? param.time : Number(param.time);
      if (!Number.isFinite(time)) return;
      const pt: MeasurePoint = { time, price };
      const a = pointARef.current;
      const b = pointBRef.current;
      if (!a) {
        // First click → set A
        setPointA(pt);
      } else if (!b) {
        // Second click → lock in B
        setPointB(pt);
      } else {
        // Third click → start over with a new A
        setPointA(pt);
        setPointB(null);
      }
    };
    chart.subscribeClick(handler);
    return () => {
      try {
        chart.unsubscribeClick(handler);
      } catch {
        /* chart torn down */
      }
    };
  }, [measureMode]);

  // --- Measure tool: live cursor tracking (only while waiting for B) ---
  useEffect(() => {
    const chart = chartRef.current;
    const spxSeries = spxSeriesRef.current;
    if (!chart || !spxSeries || !measureMode || !pointA || pointB) {
      setCursor(null);
      return;
    }

    const handler = (param: MouseEventParams) => {
      if (!param.point || param.time == null) {
        setCursor(null);
        return;
      }
      const price = spxSeries.coordinateToPrice(param.point.y);
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
      try {
        chart.unsubscribeCrosshairMove(handler);
      } catch {
        /* chart torn down */
      }
      setCursor(null);
    };
  }, [measureMode, pointA, pointB]);

  // --- Measure tool: dashed gold price lines at A and B ---
  useEffect(() => {
    const series = spxSeriesRef.current;
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
    const series = spxSeriesRef.current;
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

  // --- Derived readout ---
  // Locked: A → B (after second click)
  // Live:   A → cursor (while waiting for second click)
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
          <span style={labelStyle}>Anchor C</span>
          <input
            type="date"
            value={cDate}
            onChange={(e) => setCDate(e.target.value)}
            style={inputStyle}
            data-testid="input-c-date"
          />
          <input
            type="number"
            step="any"
            value={cPrice}
            onChange={(e) => setCPrice(e.target.value)}
            style={numberInputStyle}
            data-testid="input-c-price"
          />
        </label>

        <button
          onClick={() => {
            setADate(DEFAULT_A_DATE);
            setAPrice(String(DEFAULT_A_PRICE));
            setBDate(DEFAULT_B_DATE);
            setBPrice(String(DEFAULT_B_PRICE));
            setCDate(DEFAULT_C_DATE);
            setCPrice(String(DEFAULT_C_PRICE));
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
              : "Click to drop an anchor, then move your mouse to see live time + % from that point"
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
                {readout.aPrice.toFixed(2)}
              </div>
              <div>
                B: {formatDateLabel(readout.bTime)} @{" "}
                {readout.bPrice.toFixed(2)}
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
                  {readout.dPrice.toFixed(2)}
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
