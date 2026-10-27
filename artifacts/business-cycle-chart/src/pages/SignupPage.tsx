import { useState } from "react";
import { Link } from "wouter";
import { api, useAuth } from "@/lib/auth";
import { AuthShell, ErrorText, PrimaryButton, fieldStyle, onSubmit } from "@/components/AuthShell";

export default function SignupPage() {
  const { refresh } = useAuth();
  const [email, setEmail] = useState(""); const [password, setPassword] = useState(""); const [confirm, setConfirm] = useState("");
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (password !== confirm) { setError("Passwords don't match"); return; }
    setBusy(true); setError("");
    try { await api("/api/auth/signup", { method: "POST", json: { email, password } }); await refresh(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <AuthShell title="Create account" subtitle="You'll stay signed in on this device for a year.">
      <form onSubmit={onSubmit(submit)} className="grid gap-3">
        <input style={fieldStyle} type="email" placeholder="Email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <input style={fieldStyle} type="password" placeholder="Password (8+ characters)" autoComplete="new-password" minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} required />
        <input style={fieldStyle} type="password" placeholder="Confirm password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
        <ErrorText>{error}</ErrorText>
        <PrimaryButton disabled={busy}>{busy ? "Creating…" : "Create account"}</PrimaryButton>
      </form>
      <p className="text-sm mt-4" style={{ color: "hsl(220 10% 55%)" }}>
        Already have one? <Link href="/login" style={{ color: "hsl(224 100% 72%)" }}>Sign in</Link>
      </p>
    </AuthShell>
  );
}
