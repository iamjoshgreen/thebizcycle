import { useCallback, useRef, useState } from "react";
import { useGetChart, useRefreshChart } from "@workspace/api-client-react";
import TopBar from "@/components/TopBar";
import Chart, { OVERLAY_CONFIG, type ChartHandle, type MeasureResult, type Overlays } from "@/components/Chart";
import { useToast } from "@/hooks/use-toast";

const EMPTY: Overlays = { spx: [], oil: [], unrate: [], fedfunds: [], dgs10: [], t10y2y: [] };

function formatTs(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toLocaleDateString("en-US", { month: "short", year: "numeric" });
}

function formatYears(y: number): string {
  if (y < 1) return `${Math.round(y * 12)} mo`;
  return `${y.toFixed(1)} yr`;
}

export default function ChartPage() {
  const { toast } = useToast();
  const { data: chartData, isLoading } = useGetChart();
  const refreshMutation = useRefreshChart();
  const chartRef = useRef<ChartHandle>(null);

  const [activeOverlays, setActiveOverlays] = useState<Set<keyof Overlays>>(new Set(["spx"]));
  const [measureActive, setMeasureActive] = useState(false);
  const [measureResult, setMeasureResult] = useState<MeasureResult | null>(null);
  // Track whether we're waiting for the second click
  const [measureStep, setMeasureStep] = useState<0 | 1>(0);

  const handleRefresh = useCallback(() => {
    refreshMutation.mutate(undefined, {
      onError: () => {
        toast({ title: "Refresh failed", description: "Showing cached data", variant: "destructive" });
      },
    });
  }, [refreshMutation, toast]);

  const toggleOverlay = useCallback((id: keyof Overlays) => {
    setActiveOverlays((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleMeasure = useCallback(() => {
    setMeasureActive((v) => {
      if (v) {
        setMeasureResult(null);
        setMeasureStep(0);
      }
      return !v;
    });
  }, []);

  const handleMeasure = useCallback((result: MeasureResult | null) => {
    setMeasureResult(result);
    if (result == null) {
      setMeasureStep(1); // waiting for 2nd click
    } else {
      setMeasureStep(0); // done — ready for new pair
    }
  }, []);

  const payload = refreshMutation.data ?? chartData;
  const composite = payload?.composite ?? [];
  const recessions = payload?.recessions ?? [];
  const lastUpdated = payload?.lastUpdated ?? null;

  const overlays: Overlays = {
    spx: payload?.spx ?? [],
    ...((payload?.overlays as Overlays | undefined) ?? EMPTY),
  };

  return (
    <div className="flex flex-col w-full h-full overflow-hidden" style={{ background: "#0A0A0D" }}>
      <TopBar
        lastUpdated={lastUpdated ?? null}
        isRefreshing={refreshMutation.isPending}
        onRefresh={handleRefresh}
      />

      {/* Tool / Overlay bar */}
      <div
        className="flex items-center gap-2 px-4 py-2 flex-shrink-0 flex-wrap"
        style={{ borderBottom: "1px solid hsl(230 10% 12%)" }}
      >
        {/* Overlays */}
        <span style={{ color: "rgba(200,200,220,0.35)", fontSize: "10px", fontFamily: "'JetBrains Mono', monospace", marginRight: "4px", letterSpacing: "0.05em" }}>
          OVERLAY
        </span>
        {OVERLAY_CONFIG.map((cfg) => {
          const active = activeOverlays.has(cfg.id);
          return (
            <button
              key={cfg.id}
              onClick={() => toggleOverlay(cfg.id)}
              title={cfg.description}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "5px",
                padding: "3px 10px",
                borderRadius: "4px",
                fontSize: "11px",
                fontFamily: "'Inter', sans-serif",
                cursor: "pointer",
                transition: "all 0.15s",
                background: active ? `${cfg.color}1a` : "transparent",
                border: active ? `1px solid ${cfg.color}55` : "1px solid hsl(230 10% 16%)",
                color: active ? cfg.color : "rgba(200,200,220,0.4)",
              }}
            >
              <span
                style={{
                  width: "7px",
                  height: "7px",
                  borderRadius: "50%",
                  background: active ? cfg.color : "rgba(200,200,220,0.2)",
                  flexShrink: 0,
                }}
              />
              {cfg.label}
            </button>
          );
        })}

        {/* Divider */}
        <div style={{ width: "1px", height: "18px", background: "hsl(230 10% 16%)", marginLeft: "4px", marginRight: "4px" }} />

        {/* TOOLS label */}
        <span style={{ color: "rgba(200,200,220,0.35)", fontSize: "10px", fontFamily: "'JetBrains Mono', monospace", marginRight: "4px", letterSpacing: "0.05em" }}>
          TOOLS
        </span>

        {/* Fit All */}
        <button
          onClick={() => chartRef.current?.fitContent()}
          title="Reset zoom to show full history"
          style={{
            display: "flex",
            alignItems: "center",
            gap: "5px",
            padding: "3px 10px",
            borderRadius: "4px",
            fontSize: "11px",
            fontFamily: "'Inter', sans-serif",
            cursor: "pointer",
            transition: "all 0.15s",
            background: "transparent",
            border: "1px solid hsl(230 10% 16%)",
            color: "rgba(200,200,220,0.4)",
          }}
        >
          Fit All
        </button>

        {/* Measure tool */}
        <button
          onClick={toggleMeasure}
          title="Click two points on the chart to measure the time between them"
          style={{
            display: "flex",
            alignItems: "center",
            gap: "5px",
            padding: "3px 10px",
            borderRadius: "4px",
            fontSize: "11px",
            fontFamily: "'Inter', sans-serif",
            cursor: "pointer",
            transition: "all 0.15s",
            background: measureActive ? "rgba(100,200,255,0.1)" : "transparent",
            border: measureActive ? "1px solid rgba(100,200,255,0.35)" : "1px solid hsl(230 10% 16%)",
            color: measureActive ? "rgba(100,200,255,0.9)" : "rgba(200,200,220,0.4)",
          }}
        >
          <svg width="11" height="11" viewBox="0 0 11 11" fill="none" style={{ flexShrink: 0 }}>
            <line x1="1" y1="5.5" x2="10" y2="5.5" stroke="currentColor" strokeWidth="1.2"/>
            <line x1="1" y1="3" x2="1" y2="8" stroke="currentColor" strokeWidth="1.2"/>
            <line x1="10" y1="3" x2="10" y2="8" stroke="currentColor" strokeWidth="1.2"/>
          </svg>
          Measure
        </button>
      </div>

      <div className="relative flex-1 overflow-hidden">
        {isLoading && !chartData && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3">
            <div
              className="w-5 h-5 rounded-full border-2 border-transparent animate-spin"
              style={{ borderTopColor: "hsl(224 100% 58%)", borderRightColor: "hsl(224 100% 58% / 0.3)" }}
            />
            <span style={{ color: "hsl(220 10% 40%)", fontFamily: "'JetBrains Mono', monospace", fontSize: "12px" }}>
              Fetching market data…
            </span>
          </div>
        )}

        {/* Legend */}
        {composite.length > 0 && (
          <div
            className="absolute top-3 left-4 z-10 flex items-center gap-4 px-3 py-1.5 rounded"
            style={{
              background: "hsl(230 14% 9% / 0.7)",
              backdropFilter: "blur(8px)",
              border: "1px solid hsl(230 10% 16%)",
              pointerEvents: "none",
            }}
          >
            <div className="flex items-center gap-1.5">
              <div className="w-4 h-px" style={{ background: "#2962FF" }} />
              <span style={{ color: "rgba(200,200,220,0.7)", fontFamily: "'Inter', sans-serif", fontSize: "10px" }}>Composite</span>
            </div>
            {OVERLAY_CONFIG.filter((c) => activeOverlays.has(c.id)).map((c) => (
              <div key={c.id} className="flex items-center gap-1.5">
                <div className="w-4 h-px" style={{ background: c.color }} />
                <span style={{ color: "rgba(200,200,220,0.7)", fontFamily: "'Inter', sans-serif", fontSize: "10px" }}>{c.label}</span>
              </div>
            ))}
            <div className="flex items-center gap-1.5">
              <div className="w-3 rounded-sm" style={{ height: "10px", background: "rgba(180,190,210,0.45)", border: "1px solid rgba(180,190,210,0.35)" }} />
              <span style={{ color: "rgba(200,200,220,0.7)", fontFamily: "'Inter', sans-serif", fontSize: "10px" }}>Recession</span>
            </div>
          </div>
        )}

        {/* Measure instructions / result */}
        {measureActive && (
          <div
            className="absolute top-3 right-4 z-20 flex flex-col gap-1 px-3 py-2 rounded"
            style={{
              background: "hsl(230 14% 9% / 0.88)",
              backdropFilter: "blur(8px)",
              border: "1px solid rgba(100,200,255,0.25)",
              minWidth: "200px",
            }}
          >
            {!measureResult && measureStep === 0 && (
              <span style={{ color: "rgba(100,200,255,0.8)", fontFamily: "'JetBrains Mono', monospace", fontSize: "10px" }}>
                Click a start point on the chart
              </span>
            )}
            {!measureResult && measureStep === 1 && (
              <span style={{ color: "rgba(100,200,255,0.8)", fontFamily: "'JetBrains Mono', monospace", fontSize: "10px" }}>
                Click an end point on the chart
              </span>
            )}
            {measureResult && (
              <>
                <div style={{ color: "rgba(200,200,220,0.45)", fontFamily: "'JetBrains Mono', monospace", fontSize: "9px", letterSpacing: "0.05em" }}>
                  RANGE
                </div>
                <div style={{ color: "rgba(100,200,255,0.9)", fontFamily: "'JetBrains Mono', monospace", fontSize: "11px" }}>
                  {formatTs(measureResult.startTs)} → {formatTs(measureResult.endTs)}
                </div>
                <div style={{ color: "rgba(200,220,255,0.9)", fontFamily: "'Inter', sans-serif", fontSize: "13px", fontWeight: 600, marginTop: "2px" }}>
                  {measureResult.days.toLocaleString()} days
                  <span style={{ color: "rgba(200,220,255,0.45)", fontSize: "11px", fontWeight: 400, marginLeft: "8px" }}>
                    ({formatYears(measureResult.years)})
                  </span>
                </div>
                <div style={{ color: "rgba(200,200,220,0.3)", fontFamily: "'JetBrains Mono', monospace", fontSize: "9px", marginTop: "2px" }}>
                  Click two new points to measure again
                </div>
              </>
            )}
          </div>
        )}

        <Chart
          ref={chartRef}
          composite={composite}
          recessions={recessions}
          overlays={overlays}
          activeOverlays={activeOverlays}
          measureActive={measureActive}
          onMeasure={handleMeasure}
        />
      </div>
    </div>
  );
}
