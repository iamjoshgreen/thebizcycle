import type { ReactNode, FormEvent } from "react";

/** Shared dark, centered card for login/signup/account screens. */
export function AuthShell({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center p-4" style={{ background: "hsl(230 14% 8%)", fontFamily: "'Inter', sans-serif" }}>
      <div className="w-full max-w-sm rounded-lg border p-6" style={{ background: "hsl(230 12% 11%)", borderColor: "hsl(230 10% 18%)" }}>
        <div className="flex items-center gap-2 mb-1">
          <div className="w-2 h-2 rounded-full" style={{ background: "hsl(224 100% 58%)" }} />
          <span className="text-xs tracking-wide" style={{ color: "hsl(220 10% 45%)", fontFamily: "'JetBrains Mono', monospace" }}>AHEAD OF THE TURN</span>
        </div>
        <h1 className="text-xl font-semibold tracking-tight" style={{ color: "hsl(220 14% 95%)" }}>{title}</h1>
        {subtitle && <p className="text-sm mt-1 mb-4" style={{ color: "hsl(220 10% 55%)" }}>{subtitle}</p>}
        {children}
      </div>
    </div>
  );
}

export const fieldStyle = {
  width: "100%", padding: "10px 12px", borderRadius: 6, fontSize: 14,
  background: "hsl(230 14% 8%)", color: "hsl(220 14% 95%)", border: "1px solid hsl(230 10% 20%)", outline: "none",
} as const;

export function PrimaryButton({ children, disabled, onClick, type = "submit" }: { children: ReactNode; disabled?: boolean; onClick?: () => void; type?: "submit" | "button" }) {
  return (
    <button type={type} disabled={disabled} onClick={onClick}
      className="w-full py-2.5 rounded text-sm font-semibold transition-opacity disabled:opacity-50"
      style={{ background: "hsl(224 100% 58%)", color: "white" }}>
      {children}
    </button>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  return children ? <div className="text-sm rounded px-3 py-2" style={{ color: "hsl(0 70% 70%)", background: "hsl(0 60% 50% / 0.12)" }}>{children}</div> : null;
}

export function onSubmit(fn: () => void) {
  return (e: FormEvent) => { e.preventDefault(); fn(); };
}
