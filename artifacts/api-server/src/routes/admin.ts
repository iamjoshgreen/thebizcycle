import { Router } from "express";
import { db, usersTable } from "@workspace/db";
import { eq, asc } from "drizzle-orm";
import {
  requireAdmin, hashPassword, validPassword, normalizeEmail, toPublic,
  getConfig, setConfig, destroyAllSessions,
} from "../lib/auth";

const router = Router();
router.use("/admin", requireAdmin);

router.get("/admin/config", async (_req, res) => {
  res.json({
    requireSubscription: (await getConfig("require_subscription", "false")) === "true",
    allowSignup: (await getConfig("allow_signup", "true")) === "true",
    billingEnabled: !!process.env.STRIPE_SECRET_KEY && !!process.env.STRIPE_PRICE_ID,
  });
});
router.put("/admin/config", async (req, res) => {
  const b = req.body ?? {};
  if (typeof b.requireSubscription === "boolean") await setConfig("require_subscription", String(b.requireSubscription));
  if (typeof b.allowSignup === "boolean") await setConfig("allow_signup", String(b.allowSignup));
  res.json({
    requireSubscription: (await getConfig("require_subscription", "false")) === "true",
    allowSignup: (await getConfig("allow_signup", "true")) === "true",
  });
});

router.get("/admin/users", async (_req, res) => {
  const rows = await db.select().from(usersTable).orderBy(asc(usersTable.id));
  res.json({ users: rows.map(toPublic) });
});

router.post("/admin/users", async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const password = req.body?.password;
  if (!email) { res.status(400).json({ error: "Enter a valid email" }); return; }
  if (!validPassword(password)) { res.status(400).json({ error: "Password must be at least 8 characters" }); return; }
  const dup = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.email, email)).limit(1);
  if (dup.length) { res.status(409).json({ error: "That email already has an account" }); return; }
  const [user] = await db.insert(usersTable).values({
    email, passwordHash: await hashPassword(password), role: req.body?.role === "admin" ? "admin" : "user",
  }).returning();
  res.status(201).json({ user: toPublic(user!) });
});

router.patch("/admin/users/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) { res.status(400).json({ error: "Bad id" }); return; }
  const b = req.body ?? {};
  const set: Partial<typeof usersTable.$inferInsert> = {};
  if (typeof b.active === "boolean") set.active = b.active;
  if (b.role === "admin" || b.role === "user") set.role = b.role;
  if (b.password !== undefined) {
    if (!validPassword(b.password)) { res.status(400).json({ error: "Password must be at least 8 characters" }); return; }
    set.passwordHash = await hashPassword(b.password);
  }
  if (id === req.user!.id && (set.active === false || set.role === "user")) {
    res.status(400).json({ error: "You can't disable or demote yourself" }); return;
  }
  const [user] = await db.update(usersTable).set(set).where(eq(usersTable.id, id)).returning();
  if (!user) { res.status(404).json({ error: "No such user" }); return; }
  if (set.active === false || set.passwordHash) await destroyAllSessions(id);
  res.json({ user: toPublic(user) });
});

router.delete("/admin/users/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) { res.status(400).json({ error: "Bad id" }); return; }
  if (id === req.user!.id) { res.status(400).json({ error: "You can't delete yourself" }); return; }
  const deleted = await db.delete(usersTable).where(eq(usersTable.id, id)).returning({ id: usersTable.id });
  if (!deleted.length) { res.status(404).json({ error: "No such user" }); return; }
  res.json({ ok: true });
});

export default router;
