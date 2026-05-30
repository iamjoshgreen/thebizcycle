import type { ReactElement } from "react";
import { AlertTriangle, Check, Loader2, RefreshCw } from "lucide-react";
import { Link, useLocation } from "wouter";
import type { SaveStatus } from "@/hooks/use-persisted-settings";

interface TopBarProps {
  lastUpdated: number | null;
  isRefreshing: boolean;
  onRefresh: () => void;
  saveStatus?: SaveStatus;
}

interface IndicatorContent {
  icon: ReactElement;
  label: string;
  color: string;
}

function contentFor(status: Exclude<SaveStatus, "idle">): IndicatorContent {
  if (status === "saving") {
    return {
      icon: <Loader2 size={11} className="animate-spin" aria-hidden="true" />,
      label: "Saving…",
      color: "hsl(220 10% 55%)",
    };
  }
  if (status === "error") {
    return {
      icon: <AlertTriangle size={11} aria-hidden="true" />,
      label: "Save failed",
      color: "hsl(0 70% 60%)",
    };
  }
  return {
    icon: <Check size={11} aria-hidden="true" />,
    label: "Saved",
    color: "hsl(142 60% 55%)",
  };
}

/**
 * Renders the save indicator with a fixed-width slot at sm+ to avoid layout
 * shift on the adjacent "Updated …" text + Refresh button. When status is
 * "idle", we keep the *last* non-idle content mounted but invisible so the
 * fade-out is smooth and the slot width stays reserved.
 */
export function SaveIndicator({ status }: { status: SaveStatus }) {
  if (status === "idle") return null;
  const content = contentFor(status);
  return (
    <span
      className="inline-flex items-center gap-1 text-xs"
      style={{
        color: content.color,
        fontFamily: "'Inter', sans-serif",
        letterSpacing: "-0.005em",
        pointerEvents: "none",
      }}
      data-testid="save-indicator"
      data-status={status}
      aria-live="polite"
    >
      {content.icon}
      <span className="hidden sm:inline">{content.label}</span>
    </span>
  );
}

const TABS: { path: string; label: string; short: string }[] = [
  { path: "/", label: "Business Cycle Chart", short: "Cycle" },
  { path: "/fractal", label: "Fractal Overlay", short: "Fractal" },
  { path: "/channel", label: "Channel", short: "Channel" },
  { path: "/housing", label: "Housing", short: "Housing" },
  { path: "/recession", label: "Recession", short: "Recess." },
  { path: "/cyclical", label: "Cyclical GDP", short: "GDP" },
  { path: "/gli", label: "Global Liquidity", short: "GLI" },
  { path: "/btc-quantile", label: "BTC Quantile", short: "BTC Q" },
];

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

function Tabs() {
  const [location] = useLocation();
  return (
    <div
      className="flex items-center gap-1 overflow-x-auto flex-1 min-w-0 -mx-1 px-1 scrollbar-none"
      style={{ scrollbarWidth: "none" }}
    >
      <div
        className="w-2 h-2 rounded-full mr-1.5 sm:mr-2.5 shrink-0"
        style={{ background: "hsl(224 100% 58%)" }}
      />
      {TABS.map((tab) => {
        const active = location === tab.path;
        return (
          <Link
            key={tab.path}
            href={tab.path}
            className="px-2 sm:px-2.5 py-1 rounded text-sm font-semibold tracking-tight transition-colors shrink-0"
            style={{
              color: active ? "hsl(220 14% 95%)" : "hsl(220 10% 45%)",
              background: active ? "hsl(230 12% 14%)" : "transparent",
              fontFamily: "'Inter', sans-serif",
              letterSpacing: "-0.01em",
            }}
            data-testid={`tab-${tab.path === "/" ? "home" : tab.path.slice(1)}`}
          >
            <span className="hidden sm:inline">{tab.label}</span>
            <span className="sm:hidden">{tab.short}</span>
          </Link>
        );
      })}
    </div>
  );
}

export default function TopBar({ lastUpdated, isRefreshing, onRefresh, saveStatus = "idle" }: TopBarProps) {
  return (
    <header
      className="flex items-center justify-between gap-2 h-11 shrink-0 border-b"
      style={{
        background: "hsl(230 14% 8%)",
        borderColor: "hsl(230 10% 14%)",
        paddingLeft: "max(0.5rem, env(safe-area-inset-left))",
        paddingRight: "max(0.5rem, env(safe-area-inset-right))",
      }}
      data-testid="topbar"
    >
      {/* Left — title + tabs (scrolls on mobile) */}
      <Tabs />

      {/* Right — save indicator + last updated + refresh, grouped so they
          never collide with the tabs as they grow on wider routes. */}
      <div className="flex items-center gap-2 sm:gap-3 shrink-0">
        <SaveIndicator status={saveStatus} />
        {lastUpdated ? (
          <span
            className="text-xs hidden md:inline"
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
            className="text-xs hidden md:inline"
            style={{ color: "hsl(220 10% 30%)", fontFamily: "'JetBrains Mono', monospace" }}
          >
            No data yet
          </span>
        )}
        <button
        onClick={onRefresh}
        disabled={isRefreshing}
        aria-label="Refresh"
        className="flex items-center gap-1.5 px-2 sm:px-3 py-1.5 rounded text-xs font-medium transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
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
        <span className="hidden sm:inline">Refresh</span>
      </button>
      </div>
    </header>
  );
}
