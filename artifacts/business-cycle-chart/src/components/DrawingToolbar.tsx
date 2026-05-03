import { MousePointer2, TrendingUp, Layers, Trash2, X } from "lucide-react";
import { useState } from "react";

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
  description: string;
  active?: boolean;
  danger?: boolean;
  onClick: () => void;
  testId: string;
}

function ToolButton({ icon, label, description, active, danger, onClick, testId }: ToolButtonProps) {
  const [hovered, setHovered] = useState(false);

  return (
    <div className="relative flex items-center">
      <button
        onClick={onClick}
        data-testid={testId}
        className="relative flex items-center justify-center w-8 h-8 rounded transition-all duration-150"
        style={{
          background: active
            ? "hsl(224 100% 58% / 0.2)"
            : hovered && !danger
            ? "hsl(230 12% 18%)"
            : hovered && danger
            ? "hsl(0 72% 51% / 0.12)"
            : "transparent",
          color: active
            ? "hsl(224 100% 70%)"
            : hovered && danger
            ? "hsl(0 72% 65%)"
            : hovered
            ? "hsl(220 14% 80%)"
            : danger
            ? "hsl(0 72% 60%)"
            : "hsl(220 10% 55%)",
          border: active ? "1px solid hsl(224 100% 58% / 0.4)" : "1px solid transparent",
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        {icon}
      </button>

      {hovered && (
        <div
          className="absolute left-10 z-50 pointer-events-none"
          style={{
            background: "hsl(228 16% 12%)",
            border: "1px solid hsl(230 10% 22%)",
            borderRadius: "6px",
            padding: "6px 10px",
            boxShadow: "0 4px 16px rgba(0,0,0,0.6)",
            whiteSpace: "nowrap",
            minWidth: "140px",
          }}
        >
          <div style={{ color: "hsl(220 14% 88%)", fontSize: "11px", fontWeight: 600, marginBottom: "2px" }}>
            {label}
          </div>
          <div style={{ color: "hsl(220 10% 55%)", fontSize: "10px", lineHeight: "1.4" }}>
            {description}
          </div>
        </div>
      )}
    </div>
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
      className="absolute left-1.5 sm:left-3 top-1/2 -translate-y-1/2 z-20 flex flex-col items-center gap-1 p-1 sm:p-1.5 rounded-lg"
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
        description="Click a drawing to select, drag to move"
        active={activeTool === "select"}
        onClick={() => onToolChange(activeTool === "select" ? null : "select")}
        testId="tool-select"
      />

      <ToolButton
        icon={<TrendingUp size={14} />}
        label="Trend Line"
        description="Click two points on the chart to draw a trend line"
        active={activeTool === "trendline"}
        onClick={() => onToolChange(activeTool === "trendline" ? null : "trendline")}
        testId="tool-trendline"
      />

      <ToolButton
        icon={<Layers size={14} />}
        label="Parallel Channel"
        description="Click three points to draw a parallel price channel"
        active={activeTool === "channel"}
        onClick={() => onToolChange(activeTool === "channel" ? null : "channel")}
        testId="tool-channel"
      />

      <div
        className="w-5 my-0.5"
        style={{ height: "1px", background: "hsl(230 10% 18%)" }}
      />

      <ToolButton
        icon={<Trash2 size={13} />}
        label="Delete Selected"
        description="Remove the currently selected drawing"
        danger
        onClick={onDeleteSelected}
        testId="tool-delete"
      />

      <ToolButton
        icon={<X size={14} />}
        label="Clear All"
        description="Remove all drawings from the chart"
        danger
        onClick={onClearAll}
        testId="tool-clear-all"
      />
    </div>
  );
}
