import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

export interface AuthUser {
  id: number; email: string; role: "user" | "admin"; active: boolean;
  subscriptionStatus: string | null; currentPeriodEnd: string | null; createdAt: string; lastLoginAt: string | null;
}
interface MeResponse { user: AuthUser | null; requireSubscription: boolean; subscribed?: boolean; billingEnabled: boolean }

interface AuthState extends MeResponse { loading: boolean; refresh: () => Promise<void>; logout: () => Promise<void> }

const AuthContext = createContext<AuthState | null>(null);

/** JSON fetch with same-origin cookies; throws Error(message) on non-2xx. */
export async function api<T = unknown>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(path, {
    ...rest,
    credentials: "same-origin",
    headers: { ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...(rest.headers ?? {}) },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!res.ok) throw new Error((data.error as string) ?? `Request failed (${res.status})`);
  return data as T;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<MeResponse>({ user: null, requireSubscription: false, billingEnabled: false });
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    try { setState(await api<MeResponse>("/api/auth/me")); }
    catch { setState({ user: null, requireSubscription: false, billingEnabled: false }); }
    finally { setLoading(false); }
  }, []);
  const logout = useCallback(async () => { await api("/api/auth/logout", { method: "POST" }); await refresh(); }, [refresh]);
  useEffect(() => { void refresh(); }, [refresh]);
  return <AuthContext.Provider value={{ ...state, loading, refresh, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth outside AuthProvider");
  return ctx;
}
