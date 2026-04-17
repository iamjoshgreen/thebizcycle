import { RefreshCw } from "lucide-react";

interface TopBarProps {
  lastUpdated: number | null;
  isRefreshing: boolean;
  onRefresh: () => void;
}

function formatTimestamp(unix: number): string {
  const d = new Date(unix * 1000);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function TopBar({ lastUpdated, isRefreshing, onRefresh }: TopBarProps) {
  return (
    <header
      className="flex items-center justify-between px-5 h-11 shrink-0 border-b"
      style={{
        background: "hsl(230 14% 8%)",
        borderColor: "hsl(230 10% 14%)",
      }}
      data-testid="topbar"
    >
      {/* Left — title */}
      <div className="flex items-center gap-2.5">
        <div
          className="w-2 h-2 rounded-full"
          style={{ background: "hsl(224 100% 58%)" }}
        />
        <span
          className="text-sm font-semibold tracking-tight"
          style={{
            color: "hsl(220 14% 90%)",
            letterSpacing: "-0.01em",
            fontFamily: "'Inter', sans-serif",
          }}
          data-testid="app-title"
        >
          Business Cycle Chart
        </span>
      </div>

      {/* Center — last updated */}
      <div className="absolute left-1/2 -translate-x-1/2">
        {lastUpdated ? (
          <span
            className="text-xs"
            style={{
              color: "hsl(220 10% 45%)",
              fontFamily: "'JetBrains Mono', monospace",
              letterSpacing: "0.01em",
            }}
            data-testid="last-updated"
          >
            Updated {formatTimestamp(lastUpdated)}
          </span>
        ) : (
          <span
            className="text-xs"
            style={{ color: "hsl(220 10% 30%)", fontFamily: "'JetBrains Mono', monospace" }}
          >
            No data cached
          </span>
        )}
      </div>

      {/* Right — refresh */}
      <button
        onClick={onRefresh}
        disabled={isRefreshing}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed"
        style={{
          background: isRefreshing ? "hsl(224 100% 58% / 0.15)" : "hsl(230 12% 14%)",
          color: isRefreshing ? "hsl(224 100% 72%)" : "hsl(220 14% 65%)",
          border: "1px solid hsl(230 10% 18%)",
          fontFamily: "'Inter', sans-serif",
        }}
        onMouseEnter={(e) => {
          if (!isRefreshing) {
            (e.target as HTMLElement).closest("button")!.style.background = "hsl(224 100% 58% / 0.12)";
            (e.target as HTMLElement).closest("button")!.style.color = "hsl(224 100% 72%)";
            (e.target as HTMLElement).closest("button")!.style.borderColor = "hsl(224 100% 58% / 0.3)";
          }
        }}
        onMouseLeave={(e) => {
          if (!isRefreshing) {
            (e.target as HTMLElement).closest("button")!.style.background = "hsl(230 12% 14%)";
            (e.target as HTMLElement).closest("button")!.style.color = "hsl(220 14% 65%)";
            (e.target as HTMLElement).closest("button")!.style.borderColor = "hsl(230 10% 18%)";
          }
        }}
        data-testid="button-refresh"
      >
        <RefreshCw
          size={11}
          className={isRefreshing ? "animate-spin" : ""}
        />
        Refresh
      </button>
    </header>
  );
}
