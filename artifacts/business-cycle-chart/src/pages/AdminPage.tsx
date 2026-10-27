import { useCallback, useEffect, useState } from "react";
import { Link } from "wouter";
import { api, useAuth, type AuthUser } from "@/lib/auth";
import { ErrorText, fieldStyle, onSubmit } from "@/components/AuthShell";

interface Config { requireSubscription: boolean; allowSignup: boolean; billingEnabled: boolean }
const muted = { color: "hsl(220 10% 55%)" } as const;
const btn = "px-2.5 py-1 rounded text-xs font-medium border";
const btnStyle = { background: "hsl(230 12% 14%)", color: "hsl(220 14% 65%)", borderColor: "hsl(230 10% 18%)" } as const;

export default function AdminPage() {
  const { user: me } = useAuth();
  const [users, setUsers] = useState<AuthUser[]>([]);
  const [config, setConfig] = useState<Config | null>(null);
  const [err, setErr] = useState("");
  const [email, setEmail] = useState(""); const [password, setPassword] = useState("");

  const load = useCallback(async () => {
    try {
      const [u, c] = await Promise.all([api<{ users: AuthUser[] }>("/api/admin/users"), api<Config>("/api/admin/config")]);
      setUsers(u.users); setConfig(c);
    } catch (e) { setErr((e as Error).message); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const run = async (fn: () => Promise<unknown>) => { setErr(""); try { await fn(); await load(); } catch (e) { setErr((e as Error).message); } };
  const toggle = (key: keyof Config) => run(() => api("/api/admin/config", { method: "PUT", json: { [key]: !config![key] } }));
  const create = () => run(async () => { await api("/api/admin/users", { method: "POST", json: { email, password } }); setEmail(""); setPassword(""); });
  const patch = (id: number, body: object) => run(() => api(`/api/admin/users/${id}`, { method: "PATCH", json: body }));
  const resetPw = (u: AuthUser) => { const p = window.prompt(`New password for ${u.email} (8+ chars):`); if (p) void patch(u.id, { password: p }); };
  const del = (u: AuthUser) => { if (window.confirm(`Delete ${u.email}? This removes their settings too.`)) void run(() => api(`/api/admin/users/${u.id}`, { method: "DELETE" })); };

  if (!me || me.role !== "admin") return null;
  return (
    <div className="min-h-screen p-4 sm:p-8" style={{ background: "hsl(230 14% 8%)", color: "hsl(220 14% 85%)", fontFamily: "'Inter', sans-serif" }}>
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-xl font-semibold tracking-tight" style={{ color: "hsl(220 14% 95%)" }}>Admin</h1>
          <Link href="/" style={{ color: "hsl(224 100% 72%)" }} className="text-sm">Back to charts</Link>
        </div>
        <ErrorText>{err}</ErrorText>

        {config && (
          <section className="rounded border p-4 mb-6 grid gap-3" style={{ borderColor: "hsl(230 10% 18%)" }}>
            <div className="text-xs tracking-wide" style={{ ...muted, fontFamily: "'JetBrains Mono', monospace" }}>SITE SWITCHES</div>
            <Row label="Require paid subscription to view charts" hint={config.billingEnabled ? "Admins always get in." : "Stripe isn't configured yet; turning this on would lock everyone but admins out."}>
              <Toggle on={config.requireSubscription} onClick={() => toggle("requireSubscription")} />
            </Row>
            <Row label="Allow new signups" hint="Off = only you can create accounts, below.">
              <Toggle on={config.allowSignup} onClick={() => toggle("allowSignup")} />
            </Row>
          </section>
        )}

        <section className="rounded border p-4 mb-6" style={{ borderColor: "hsl(230 10% 18%)" }}>
          <div className="text-xs tracking-wide mb-3" style={{ ...muted, fontFamily: "'JetBrains Mono', monospace" }}>CREATE ACCOUNT</div>
          <form onSubmit={onSubmit(create)} className="flex flex-col sm:flex-row gap-2">
            <input style={fieldStyle} type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            <input style={fieldStyle} type="text" placeholder="Password (8+)" minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} required />
            <button className="px-4 py-2 rounded text-sm font-semibold shrink-0" style={{ background: "hsl(224 100% 58%)", color: "white" }}>Create</button>
          </form>
        </section>

        <section className="rounded border overflow-x-auto" style={{ borderColor: "hsl(230 10% 18%)" }}>
          <table className="w-full text-sm">
            <thead><tr style={{ ...muted, fontFamily: "'JetBrains Mono', monospace", fontSize: 11 }}>
              <th className="text-left p-3">EMAIL</th><th className="text-left p-3">ROLE</th><th className="text-left p-3">SUB</th><th className="text-left p-3">LAST LOGIN</th><th className="p-3"></th>
            </tr></thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="border-t" style={{ borderColor: "hsl(230 10% 14%)", opacity: u.active ? 1 : 0.45 }}>
                  <td className="p-3">{u.email}{!u.active && <span className="ml-2 text-xs" style={muted}>(disabled)</span>}</td>
                  <td className="p-3">{u.role}</td>
                  <td className="p-3">{u.subscriptionStatus ?? "—"}</td>
                  <td className="p-3" style={muted}>{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleDateString() : "never"}</td>
                  <td className="p-3 whitespace-nowrap text-right">
                    {u.id !== me.id && <>
                      <button className={btn} style={btnStyle} onClick={() => void patch(u.id, { active: !u.active })}>{u.active ? "Disable" : "Enable"}</button>{" "}
                      <button className={btn} style={btnStyle} onClick={() => void patch(u.id, { role: u.role === "admin" ? "user" : "admin" })}>{u.role === "admin" ? "Make user" : "Make admin"}</button>{" "}
                    </>}
                    <button className={btn} style={btnStyle} onClick={() => resetPw(u)}>Reset pw</button>{" "}
                    {u.id !== me.id && <button className={btn} style={{ ...btnStyle, color: "hsl(0 70% 65%)" }} onClick={() => del(u)}>Delete</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div><div className="text-sm">{label}</div>{hint && <div className="text-xs mt-0.5" style={muted}>{hint}</div>}</div>
      {children}
    </div>
  );
}
function Toggle({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={on} className="w-11 h-6 rounded-full relative shrink-0 transition-colors"
      style={{ background: on ? "hsl(224 100% 58%)" : "hsl(230 10% 22%)" }}>
      <span className="absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all" style={{ left: on ? 22 : 2 }} />
    </button>
  );
}
