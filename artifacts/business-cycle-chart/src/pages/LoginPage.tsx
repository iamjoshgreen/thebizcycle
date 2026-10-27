import { useState } from "react";
import { Link } from "wouter";
import { api, useAuth } from "@/lib/auth";
import { AuthShell, ErrorText, PrimaryButton, fieldStyle, onSubmit } from "@/components/AuthShell";

export default function LoginPage() {
  const { refresh } = useAuth();
  const [email, setEmail] = useState(""); const [password, setPassword] = useState("");
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true); setError("");
    try { await api("/api/auth/login", { method: "POST", json: { email, password } }); await refresh(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <AuthShell title="Sign in" subtitle="Business cycle indicators, updated from FRED.">
      <form onSubmit={onSubmit(submit)} className="grid gap-3">
        <input style={fieldStyle} type="email" placeholder="Email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <input style={fieldStyle} type="password" placeholder="Password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        <ErrorText>{error}</ErrorText>
        <PrimaryButton disabled={busy}>{busy ? "Signing in…" : "Sign in"}</PrimaryButton>
      </form>
      <p className="text-sm mt-4" style={{ color: "hsl(220 10% 55%)" }}>
        No account? <Link href="/signup" style={{ color: "hsl(224 100% 72%)" }}>Create one</Link>
      </p>
    </AuthShell>
  );
}
