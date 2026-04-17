import { useCallback } from "react";
import { useGetChart, useRefreshChart } from "@workspace/api-client-react";
import TopBar from "@/components/TopBar";
import Chart from "@/components/Chart";
import { useToast } from "@/hooks/use-toast";

export default function ChartPage() {
  const { toast } = useToast();
  const { data: chartData, isLoading } = useGetChart();
  const refreshMutation = useRefreshChart();

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
            >
              Fetching market data…
            </span>
          </div>
        )}

        {/* Legend overlay */}
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
              <span style={{ color: "rgba(200, 200, 220, 0.7)", fontFamily: "'Inter', sans-serif", fontSize: "10px" }}>
                Composite
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-4 h-px" style={{ background: "#FF6D00" }} />
              <span style={{ color: "rgba(200, 200, 220, 0.7)", fontFamily: "'Inter', sans-serif", fontSize: "10px" }}>
                SPX
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <div
                className="w-3 rounded-sm"
                style={{ height: "10px", background: "rgba(180, 190, 210, 0.45)", border: "1px solid rgba(180, 190, 210, 0.35)" }}
              />
              <span style={{ color: "rgba(200, 200, 220, 0.7)", fontFamily: "'Inter', sans-serif", fontSize: "10px" }}>
                Recession
              </span>
            </div>
          </div>
        )}

        <Chart
          composite={composite}
          spx={spxData}
          recessions={recessions}
        />
      </div>
    </div>
  );
}
