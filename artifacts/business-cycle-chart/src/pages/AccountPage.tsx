import { useState } from "react";
import { Link } from "wouter";
import { api, useAuth } from "@/lib/auth";
import { AuthShell, ErrorText, PrimaryButton, fieldStyle, onSubmit } from "@/components/AuthShell";

const muted = { color: "hsl(220 10% 55%)" } as const;

export default function AccountPage({ paywalled = false }: { paywalled?: boolean }) {
  const { user, subscribed, requireSubscription, billingEnabled, logout, refresh } = useAuth();
  const [cur, setCur] = useState(""); const [next, setNext] = useState("");
  const [msg, setMsg] = useState(""); const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  if (!user) return null;

  const go = async (path: string) => {
    setErr(""); setBusy(true);
    try { const { url } = await api<{ url: string }>(path, { method: "POST" }); window.location.href = url; }
    catch (e) { setErr((e as Error).message); setBusy(false); }
  };
  const changePw = async () => {
    setErr(""); setMsg(""); setBusy(true);
    try { await api("/api/auth/change-password", { method: "POST", json: { currentPassword: cur, newPassword: next } }); setMsg("Password changed."); setCur(""); setNext(""); await refresh(); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const status = user.role === "admin" ? "Admin (always on)" : subscribed ? "Active" : requireSubscription ? "Not subscribed" : "Free access (no subscription needed yet)";

  return (
    <AuthShell title={paywalled ? "Subscribe to continue" : "Account"} subtitle={user.email}>
      {paywalled && (
        <p className="text-sm mb-4" style={muted}>Ahead of the Turn is $2.99/month. Cancel any time.</p>
      )}
      <div className="rounded border p-3 mb-4 text-sm" style={{ borderColor: "hsl(230 10% 18%)" }}>
        <div className="flex justify-between"><span style={muted}>Subscription</span><span style={{ color: "hsl(220 14% 85%)" }}>{status}</span></div>
        {user.currentPeriodEnd && <div className="flex justify-between mt-1"><span style={muted}>{user.subscriptionStatus === "canceled" ? "Access until" : "Renews"}</span><span style={{ color: "hsl(220 14% 85%)" }}>{new Date(user.currentPeriodEnd).toLocaleDateString()}</span></div>}
      </div>
      <ErrorText>{err}</ErrorText>
      <div className="grid gap-2 mt-2">
        {user.role !== "admin" && !subscribed && (
          billingEnabled
            ? <PrimaryButton type="button" disabled={busy} onClick={() => go("/api/billing/checkout")}>Subscribe, $2.99/mo</PrimaryButton>
            : paywalled && <p className="text-sm" style={muted}>Payments aren't open yet. Check back soon.</p>
        )}
        {subscribed && billingEnabled && user.role !== "admin" && (
          <PrimaryButton type="button" disabled={busy} onClick={() => go("/api/billing/portal")}>Manage billing</PrimaryButton>
        )}
      </div>
      {!paywalled && (
        <form onSubmit={onSubmit(changePw)} className="grid gap-2 mt-6">
          <div className="text-xs tracking-wide" style={{ ...muted, fontFamily: "'JetBrains Mono', monospace" }}>CHANGE PASSWORD</div>
          <input style={fieldStyle} type="password" placeholder="Current password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} required />
          <input style={fieldStyle} type="password" placeholder="New password (8+ characters)" autoComplete="new-password" minLength={8} value={next} onChange={(e) => setNext(e.target.value)} required />
          {msg && <div className="text-sm" style={{ color: "hsl(142 60% 55%)" }}>{msg}</div>}
          <PrimaryButton disabled={busy}>Update password</PrimaryButton>
        </form>
      )}
      <div className="flex justify-between mt-6 text-sm">
        {!paywalled ? <Link href="/" style={{ color: "hsl(224 100% 72%)" }}>Back to charts</Link> : <span />}
        <button type="button" onClick={() => void logout()} style={muted}>Sign out</button>
      </div>
    </AuthShell>
  );
}
