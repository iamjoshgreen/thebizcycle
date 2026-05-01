import { useRef, type ReactElement } from "react";
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
  const lastContentRef = useRef<IndicatorContent | null>(null);
  if (status !== "idle") {
    lastContentRef.current = contentFor(status);
  }
  const content = lastContentRef.current;
  const visible = status !== "idle";
  return (
    <span
      className="inline-flex items-center gap-1 text-xs justify-end"
      style={{
        color: content?.color ?? "transparent",
        fontFamily: "'Inter', sans-serif",
        letterSpacing: "-0.005em",
        transition: "opacity 220ms ease, color 220ms ease",
        opacity: visible ? 1 : 0,
      }}
      data-testid="save-indicator"
      data-status={status}
      aria-live="polite"
      aria-hidden={!visible}
    >
      {content ? (
        <>
          {content.icon}
          {/* Hide the text label on tiny viewports — the icon alone still
              gives mobile users feedback without crowding the TopBar. */}
          <span className="hidden sm:inline" style={{ minWidth: "4.25rem" }}>
            {content.label}
          </span>
        </>
      ) : null}
    </span>
  );
}

const TABS: { path: string; label: string }[] = [
  { path: "/", label: "Business Cycle Chart" },
  { path: "/fractal", label: "Fractal Overlay" },
  { path: "/channel", label: "Channel" },
  { path: "/housing", label: "Housing" },
  { path: "/recession", label: "Recession" },
  { path: "/cyclical", label: "Cyclical GDP" },
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
    <div className="flex items-center gap-1">
      <div
        className="w-2 h-2 rounded-full mr-2.5"
        style={{ background: "hsl(224 100% 58%)" }}
      />
      {TABS.map((tab) => {
        const active = location === tab.path;
        return (
          <Link
            key={tab.path}
            href={tab.path}
            className="px-2.5 py-1 rounded text-sm font-semibold tracking-tight transition-colors"
            style={{
              color: active ? "hsl(220 14% 95%)" : "hsl(220 10% 45%)",
              background: active ? "hsl(230 12% 14%)" : "transparent",
              fontFamily: "'Inter', sans-serif",
              letterSpacing: "-0.01em",
            }}
            data-testid={`tab-${tab.path === "/" ? "home" : tab.path.slice(1)}`}
          >
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}

export default function TopBar({ lastUpdated, isRefreshing, onRefresh, saveStatus = "idle" }: TopBarProps) {
  return (
    <header
      className="flex items-center justify-between px-5 h-11 shrink-0 border-b"
      style={{
        background: "hsl(230 14% 8%)",
        borderColor: "hsl(230 10% 14%)",
      }}
      data-testid="topbar"
    >
      {/* Left — title + tabs */}
      <Tabs />

      {/* Right — save indicator + last updated + refresh, grouped so they
          never collide with the tabs as they grow on wider routes. */}
      <div className="flex items-center gap-3">
        <SaveIndicator status={saveStatus} />
        {lastUpdated ? (
          <span
            className="text-xs hidden sm:inline"
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
            className="text-xs hidden sm:inline"
            style={{ color: "hsl(220 10% 30%)", fontFamily: "'JetBrains Mono', monospace" }}
          >
            No data cached
          </span>
        )}
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
      </div>
    </header>
  );
}
