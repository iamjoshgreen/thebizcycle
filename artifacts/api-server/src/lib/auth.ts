import { randomBytes, scrypt as _scrypt, timingSafeEqual, createHash } from "node:crypto";
import { promisify } from "node:util";
import type { Request, Response, NextFunction } from "express";
import { db, usersTable, sessionsTable, appConfigTable, type User, type PublicUser } from "@workspace/db";
import { eq, lt } from "drizzle-orm";

const scrypt = promisify(_scrypt) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;
const SCRYPT = { N: 16384, r: 8, p: 1 };

export const SESSION_COOKIE = "aott_session";
export const SESSION_DAYS = 365;
const SESSION_MS = SESSION_DAYS * 24 * 3600 * 1000;

// ---------- passwords ----------
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64, SCRYPT);
  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, saltB64, keyB64] = stored.split("$");
  if (algo !== "scrypt" || !saltB64 || !keyB64) return false;
  const key = await scrypt(password, Buffer.from(saltB64, "base64"), 64, SCRYPT);
  const expected = Buffer.from(keyB64, "base64");
  return key.length === expected.length && timingSafeEqual(key, expected);
}
export function validPassword(pw: unknown): pw is string {
  return typeof pw === "string" && pw.length >= 8 && pw.length <= 200;
}
export function normalizeEmail(e: unknown): string | null {
  if (typeof e !== "string") return null;
  const s = e.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 254 ? s : null;
}

// ---------- sessions ----------
const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");

export async function createSession(res: Response, userId: number): Promise<void> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_MS);
  await db.insert(sessionsTable).values({ tokenHash: hashToken(token), userId, expiresAt });
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MS,
  });
}
export async function destroySession(req: Request, res: Response): Promise<void> {
  const token = req.cookies?.[SESSION_COOKIE] as string | undefined;
  if (token) await db.delete(sessionsTable).where(eq(sessionsTable.tokenHash, hashToken(token)));
  res.clearCookie(SESSION_COOKIE, { path: "/" });
}
export async function destroyAllSessions(userId: number): Promise<void> {
  await db.delete(sessionsTable).where(eq(sessionsTable.userId, userId));
}
export async function sweepExpiredSessions(): Promise<void> {
  await db.delete(sessionsTable).where(lt(sessionsTable.expiresAt, new Date()));
}

export function toPublic(u: User): PublicUser {
  return {
    id: u.id, email: u.email, role: u.role, active: u.active,
    subscriptionStatus: u.subscriptionStatus, currentPeriodEnd: u.currentPeriodEnd,
    createdAt: u.createdAt, lastLoginAt: u.lastLoginAt,
  };
}

// ---------- config ----------
export async function getConfig(key: string, fallback: string): Promise<string> {
  const rows = await db.select().from(appConfigTable).where(eq(appConfigTable.key, key)).limit(1);
  return rows[0]?.value ?? fallback;
}
export async function setConfig(key: string, value: string): Promise<void> {
  await db.insert(appConfigTable).values({ key, value })
    .onConflictDoUpdate({ target: appConfigTable.key, set: { value, updatedAt: new Date() } });
}
export const requireSubscriptionEnabled = () => getConfig("require_subscription", "false").then((v) => v === "true");

export function hasActiveSubscription(u: Pick<User, "subscriptionStatus" | "currentPeriodEnd">): boolean {
  if (u.subscriptionStatus === "active" || u.subscriptionStatus === "trialing") return true;
  // Cancelled but paid through the period end still counts.
  if (u.subscriptionStatus === "canceled" && u.currentPeriodEnd && u.currentPeriodEnd.getTime() > Date.now()) return true;
  return false;
}

// ---------- middleware ----------
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express { interface Request { user?: User } }
}

/** Loads req.user from the session cookie (no rejection). */
export async function loadUser(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const token = req.cookies?.[SESSION_COOKIE] as string | undefined;
    if (!token) return next();
    const rows = await db
      .select({ user: usersTable, expiresAt: sessionsTable.expiresAt })
      .from(sessionsTable)
      .innerJoin(usersTable, eq(sessionsTable.userId, usersTable.id))
      .where(eq(sessionsTable.tokenHash, hashToken(token)))
      .limit(1);
    const row = rows[0];
    if (row && row.expiresAt.getTime() > Date.now() && row.user.active) req.user = row.user;
    next();
  } catch (err) { next(err); }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) { res.status(401).json({ error: "Login required" }); return; }
  next();
}
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) { res.status(401).json({ error: "Login required" }); return; }
  if (req.user.role !== "admin") { res.status(403).json({ error: "Admin only" }); return; }
  next();
}
/** Paywall: only enforced when the site switch is on. Admins always pass. */
export async function requireSubscription(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) { res.status(401).json({ error: "Login required" }); return; }
    if (req.user.role === "admin") return next();
    if (!(await requireSubscriptionEnabled())) return next();
    if (hasActiveSubscription(req.user)) return next();
    res.status(402).json({ error: "Subscription required" });
  } catch (err) { next(err); }
}

// ---------- tiny in-memory rate limiter (per IP) ----------
const hits = new Map<string, number[]>();
export function rateLimit(max: number, windowMs: number) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const ip = req.ip ?? "?";
    const now = Date.now();
    const arr = (hits.get(ip) ?? []).filter((t) => now - t < windowMs);
    if (arr.length >= max) { res.status(429).json({ error: "Too many attempts, try again later" }); return; }
    arr.push(now); hits.set(ip, arr);
    if (hits.size > 10000) hits.clear();
    next();
  };
}
