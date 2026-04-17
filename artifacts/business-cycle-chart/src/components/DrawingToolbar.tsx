import { MousePointer2, TrendingUp, Layers, Trash2, X } from "lucide-react";

export type DrawingTool = "select" | "trendline" | "channel" | null;

interface DrawingToolbarProps {
  activeTool: DrawingTool;
  onToolChange: (tool: DrawingTool) => void;
  onDeleteSelected: () => void;
  onClearAll: () => void;
}

interface ToolButtonProps {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  danger?: boolean;
  onClick: () => void;
  testId: string;
}

function ToolButton({ icon, label, active, danger, onClick, testId }: ToolButtonProps) {
  return (
    <button
      onClick={onClick}
      title={label}
      data-testid={testId}
      className="relative flex items-center justify-center w-8 h-8 rounded transition-all duration-150 group"
      style={{
        background: active
          ? "hsl(224 100% 58% / 0.2)"
          : danger
          ? "transparent"
          : "transparent",
        color: active
          ? "hsl(224 100% 70%)"
          : danger
          ? "hsl(0 72% 60%)"
          : "hsl(220 10% 55%)",
        border: active ? "1px solid hsl(224 100% 58% / 0.4)" : "1px solid transparent",
      }}
      onMouseEnter={(e) => {
        const btn = e.currentTarget;
        if (!active) {
          btn.style.background = danger
            ? "hsl(0 72% 51% / 0.12)"
            : "hsl(230 12% 18%)";
          btn.style.color = danger ? "hsl(0 72% 65%)" : "hsl(220 14% 80%)";
        }
      }}
      onMouseLeave={(e) => {
        const btn = e.currentTarget;
        if (!active) {
          btn.style.background = "transparent";
          btn.style.color = danger ? "hsl(0 72% 60%)" : "hsl(220 10% 55%)";
        }
      }}
    >
      {icon}
    </button>
  );
}

export default function DrawingToolbar({
  activeTool,
  onToolChange,
  onDeleteSelected,
  onClearAll,
}: DrawingToolbarProps) {
  return (
    <div
      className="absolute left-3 top-1/2 -translate-y-1/2 z-20 flex flex-col items-center gap-1 p-1.5 rounded-lg"
      style={{
        background: "hsl(230 14% 9% / 0.92)",
        border: "1px solid hsl(230 10% 16%)",
        backdropFilter: "blur(12px)",
        boxShadow: "0 4px 24px rgba(0,0,0,0.5)",
      }}
      data-testid="drawing-toolbar"
    >
      <ToolButton
        icon={<MousePointer2 size={14} />}
        label="Select"
        active={activeTool === "select"}
        onClick={() => onToolChange(activeTool === "select" ? null : "select")}
        testId="tool-select"
      />

      <ToolButton
        icon={<TrendingUp size={14} />}
        label="Trend Line"
        active={activeTool === "trendline"}
        onClick={() => onToolChange(activeTool === "trendline" ? null : "trendline")}
        testId="tool-trendline"
      />

      <ToolButton
        icon={<Layers size={14} />}
        label="Parallel Channel"
        active={activeTool === "channel"}
        onClick={() => onToolChange(activeTool === "channel" ? null : "channel")}
        testId="tool-channel"
      />

      {/* Divider */}
      <div
        className="w-5 my-0.5"
        style={{ height: "1px", background: "hsl(230 10% 18%)" }}
      />

      <ToolButton
        icon={<Trash2 size={13} />}
        label="Delete Selected"
        danger
        onClick={onDeleteSelected}
        testId="tool-delete"
      />

      <ToolButton
        icon={<X size={14} />}
        label="Clear All"
        danger
        onClick={onClearAll}
        testId="tool-clear-all"
      />
    </div>
  );
}
