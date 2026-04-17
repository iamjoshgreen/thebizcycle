import { useState, useRef, useCallback, useEffect } from "react";
import { useGetChart, useRefreshChart, useGetDrawings, useSaveDrawings } from "@workspace/api-client-react";
import type { SerializedDrawing } from "lightweight-charts-drawing";
import TopBar from "@/components/TopBar";
import DrawingToolbar, { type DrawingTool } from "@/components/DrawingToolbar";
import Chart, { type ChartHandle } from "@/components/Chart";
import { useToast } from "@/hooks/use-toast";

export default function ChartPage() {
  const { toast } = useToast();
  const chartRef = useRef<ChartHandle>(null);
  const [activeTool, setActiveTool] = useState<DrawingTool>(null);
  const [drawingsLoaded, setDrawingsLoaded] = useState(false);

  const { data: chartData, isLoading } = useGetChart();
  const { data: drawingsData } = useGetDrawings();
  const refreshMutation = useRefreshChart();
  const saveDrawingsMutation = useSaveDrawings();

  // Load saved drawings once chart and drawings are both ready
  useEffect(() => {
    if (!drawingsLoaded && drawingsData?.data && chartRef.current) {
      try {
        const drawings = drawingsData.data as SerializedDrawing[];
        if (Array.isArray(drawings) && drawings.length > 0) {
          chartRef.current.loadDrawings(drawings);
        }
      } catch {
        // malformed drawings data — skip
      }
      setDrawingsLoaded(true);
    }
  }, [drawingsData, drawingsLoaded, chartData]);

  const handleRefresh = useCallback(() => {
    refreshMutation.mutate(undefined, {
      onError: () => {
        toast({
          title: "Refresh failed",
          description: "Showing cached data",
          variant: "destructive",
        });
      },
    });
  }, [refreshMutation, toast]);

  const handleDrawingsChange = useCallback(
    (drawings: SerializedDrawing[]) => {
      saveDrawingsMutation.mutate({ data: drawings });
    },
    [saveDrawingsMutation]
  );

  const handleDeleteSelected = useCallback(() => {
    chartRef.current?.deleteSelected();
  }, []);

  const handleClearAll = useCallback(() => {
    chartRef.current?.clearAll();
    saveDrawingsMutation.mutate({ data: { data: [] } });
  }, [saveDrawingsMutation]);

  const composite = (refreshMutation.data ?? chartData)?.composite ?? [];
  const spxData = (refreshMutation.data ?? chartData)?.spx ?? [];
  const recessions = (refreshMutation.data ?? chartData)?.recessions ?? [];
  const lastUpdated = (refreshMutation.data ?? chartData)?.lastUpdated ?? null;

  return (
    <div className="flex flex-col w-full h-full overflow-hidden" style={{ background: "#0A0A0D" }}>
      <TopBar
        lastUpdated={lastUpdated ?? null}
        isRefreshing={refreshMutation.isPending}
        onRefresh={handleRefresh}
      />

      {/* Chart area */}
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
              className="text-xs"
              style={{ color: "hsl(220 10% 40%)", fontFamily: "'JetBrains Mono', monospace" }}
              data-testid="loading-text"
            >
              Fetching market data…
            </span>
          </div>
        )}

        {/* Legend overlay */}
        {composite.length > 0 && (
          <div
            className="absolute top-3 left-14 z-10 flex items-center gap-4 px-3 py-1.5 rounded"
            style={{
              background: "hsl(230 14% 9% / 0.7)",
              backdropFilter: "blur(8px)",
              border: "1px solid hsl(230 10% 16%)",
              pointerEvents: "none",
            }}
            data-testid="chart-legend"
          >
            <div className="flex items-center gap-1.5">
              <div className="w-4 h-px" style={{ background: "#2962FF" }} />
              <span
                className="text-xs"
                style={{ color: "rgba(200, 200, 220, 0.7)", fontFamily: "'Inter', sans-serif", fontSize: "10px" }}
              >
                Composite
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-4 h-px" style={{ background: "#FF6D00" }} />
              <span
                className="text-xs"
                style={{ color: "rgba(200, 200, 220, 0.7)", fontFamily: "'Inter', sans-serif", fontSize: "10px" }}
              >
                SPX
              </span>
            </div>
          </div>
        )}

        {/* Drawing toolbar */}
        <DrawingToolbar
          activeTool={activeTool}
          onToolChange={setActiveTool}
          onDeleteSelected={handleDeleteSelected}
          onClearAll={handleClearAll}
        />

        <Chart
          ref={chartRef}
          composite={composite}
          spx={spxData}
          recessions={recessions}
          activeTool={activeTool}
          onDrawingsChange={handleDrawingsChange}
        />
      </div>
    </div>
  );
}
