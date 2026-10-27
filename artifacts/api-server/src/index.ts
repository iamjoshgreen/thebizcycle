import app from "./app";
import { logger } from "./lib/logger";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { hashPassword, normalizeEmail, sweepExpiredSessions } from "./lib/auth";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

/** First boot: create the admin from ADMIN_EMAIL / ADMIN_PASSWORD if missing. */
async function seedAdmin(): Promise<void> {
  const email = normalizeEmail(process.env.ADMIN_EMAIL);
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) return;
  const existing = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.email, email)).limit(1);
  if (existing.length) return;
  await db.insert(usersTable).values({ email, passwordHash: await hashPassword(password), role: "admin" });
  logger.info({ email }, "Created admin user");
}

await seedAdmin();
setInterval(() => { sweepExpiredSessions().catch((err) => logger.warn({ err }, "session sweep failed")); }, 6 * 3600 * 1000).unref();

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});
