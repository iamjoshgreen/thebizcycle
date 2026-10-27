import { Router } from "express";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  hashPassword, verifyPassword, validPassword, normalizeEmail,
  createSession, destroySession, destroyAllSessions, toPublic, rateLimit,
  requireAuth, requireSubscriptionEnabled, hasActiveSubscription, getConfig,
} from "../lib/auth";

const router = Router();
const limiter = rateLimit(10, 60_000);

router.get("/auth/me", async (req, res) => {
  const requireSub = await requireSubscriptionEnabled();
  if (!req.user) { res.json({ user: null, requireSubscription: requireSub, billingEnabled: !!process.env.STRIPE_SECRET_KEY }); return; }
  res.json({
    user: toPublic(req.user),
    requireSubscription: requireSub,
    subscribed: hasActiveSubscription(req.user),
    billingEnabled: !!process.env.STRIPE_SECRET_KEY,
  });
});

router.post("/auth/signup", limiter, async (req, res) => {
  try {
    if ((await getConfig("allow_signup", "true")) !== "true") {
      res.status(403).json({ error: "Signups are closed right now" }); return;
    }
    const email = normalizeEmail(req.body?.email);
    const password = req.body?.password;
    if (!email) { res.status(400).json({ error: "Enter a valid email" }); return; }
    if (!validPassword(password)) { res.status(400).json({ error: "Password must be at least 8 characters" }); return; }
    const existing = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.email, email)).limit(1);
    if (existing.length) { res.status(409).json({ error: "An account with that email already exists" }); return; }
    const [user] = await db.insert(usersTable)
      .values({ email, passwordHash: await hashPassword(password), lastLoginAt: new Date() })
      .returning();
    await createSession(res, user!.id);
    res.status(201).json({ user: toPublic(user!) });
  } catch (err) { req.log.error({ err }, "signup failed"); res.status(500).json({ error: "Signup failed" }); }
});

router.post("/auth/login", limiter, async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = req.body?.password;
    if (!email || typeof password !== "string") { res.status(400).json({ error: "Email and password required" }); return; }
    const rows = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
    const user = rows[0];
    const ok = user ? await verifyPassword(password, user.passwordHash) : false;
    if (!user || !ok) { res.status(401).json({ error: "Wrong email or password" }); return; }
    if (!user.active) { res.status(403).json({ error: "This account is disabled" }); return; }
    await db.update(usersTable).set({ lastLoginAt: new Date() }).where(eq(usersTable.id, user.id));
    await createSession(res, user.id);
    res.json({ user: toPublic(user) });
  } catch (err) { req.log.error({ err }, "login failed"); res.status(500).json({ error: "Login failed" }); }
});

router.post("/auth/logout", async (req, res) => {
  await destroySession(req, res);
  res.json({ ok: true });
});

router.post("/auth/change-password", requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body ?? {};
    if (!validPassword(newPassword)) { res.status(400).json({ error: "New password must be at least 8 characters" }); return; }
    if (!(await verifyPassword(String(currentPassword ?? ""), req.user!.passwordHash))) {
      res.status(401).json({ error: "Current password is wrong" }); return;
    }
    await db.update(usersTable).set({ passwordHash: await hashPassword(newPassword) }).where(eq(usersTable.id, req.user!.id));
    await destroyAllSessions(req.user!.id);
    await createSession(res, req.user!.id);
    res.json({ ok: true });
  } catch (err) { req.log.error({ err }, "change password failed"); res.status(500).json({ error: "Could not change password" }); }
});

export default router;
