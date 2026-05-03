import { Router } from "express";
import { db, settingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const router = Router();

const KEY_RE = /^[a-zA-Z0-9_.\-:]{1,128}$/;

function isValidKey(key: unknown): key is string {
  return typeof key === "string" && KEY_RE.test(key);
}

router.get("/settings/:key", async (req, res) => {
  try {
    const { key } = req.params;
    if (!isValidKey(key)) {
      res.status(400).json({ error: "Invalid settings key" });
      return;
    }

    const rows = await db
      .select()
      .from(settingsTable)
      .where(eq(settingsTable.key, key))
      .limit(1);

    if (rows.length === 0) {
      res.json({ value: null, updatedAt: 0 });
      return;
    }

    const row = rows[0]!;
    res.json({
      value: row.value,
      updatedAt: Math.floor(row.updatedAt.getTime() / 1000),
    });
  } catch (err) {
    req.log.error({ err }, "Error reading settings");
    res.status(500).json({ error: "Failed to read settings" });
  }
});

router.put("/settings/:key", async (req, res) => {
  try {
    const { key } = req.params;
    if (!isValidKey(key)) {
      res.status(400).json({ error: "Invalid settings key" });
      return;
    }

    const body = req.body as { value?: unknown };
    if (
      !body ||
      typeof body !== "object" ||
      body.value === undefined ||
      body.value === null ||
      typeof body.value !== "object" ||
      Array.isArray(body.value)
    ) {
      res.status(400).json({ error: "Body must be { value: object }" });
      return;
    }

    const now = new Date();
    await db
      .insert(settingsTable)
      .values({ key, value: body.value as object })
      .onConflictDoUpdate({
        target: settingsTable.key,
        set: { value: body.value as object, updatedAt: now },
      });

    res.json({ value: body.value, updatedAt: Math.floor(now.getTime() / 1000) });
  } catch (err) {
    req.log.error({ err }, "Error saving settings");
    res.status(500).json({ error: "Failed to save settings" });
  }
});

export default router;
