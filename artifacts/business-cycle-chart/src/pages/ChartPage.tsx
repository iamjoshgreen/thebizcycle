import { useCallback, useState } from "react";
import { useGetChart, useRefreshChart } from "@workspace/api-client-react";
import TopBar from "@/components/TopBar";
import Chart, { OVERLAY_CONFIG, type Overlays } from "@/components/Chart";
import { useToast } from "@/hooks/use-toast";

const EMPTY_OVERLAYS: Overlays = { oil: [], unrate: [], fedfunds: [], dgs10: [], t10y2y: [] };

export default function ChartPage() {
  const { toast } = useToast();
  const { data: chartData, isLoading } = useGetChart();
  const refreshMutation = useRefreshChart();
  const [activeOverlays, setActiveOverlays] = useState<Set<keyof Overlays>>(new Set());

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

  const payload = refreshMutation.data ?? chartData;
  const composite = payload?.composite ?? [];
  const spxData = payload?.spx ?? [];
  const recessions = payload?.recessions ?? [];
  const overlays = (payload?.overlays as Overlays | undefined) ?? EMPTY_OVERLAYS;
  const lastUpdated = payload?.lastUpdated ?? null;

  return (
    <div className="flex flex-col w-full h-full overflow-hidden" style={{ background: "#0A0A0D" }}>
      <TopBar
        lastUpdated={lastUpdated ?? null}
        isRefreshing={refreshMutation.isPending}
        onRefresh={handleRefresh}
      />

      {/* Overlay toggle bar */}
      <div
        className="flex items-center gap-2 px-4 py-2 flex-shrink-0"
        style={{ borderBottom: "1px solid hsl(230 10% 12%)" }}
      >
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
            <div className="flex items-center gap-1.5">
              <div className="w-4 h-px" style={{ background: "#FF6D00" }} />
              <span style={{ color: "rgba(200,200,220,0.7)", fontFamily: "'Inter', sans-serif", fontSize: "10px" }}>SPX</span>
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

        <Chart
          composite={composite}
          spx={spxData}
          recessions={recessions}
          overlays={overlays}
          activeOverlays={activeOverlays}
        />
      </div>
    </div>
  );
}
