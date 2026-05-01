import { Router } from "express";
import { getDb } from "../lib/sqlite.js";

const router = Router();

const KEY_RE = /^[a-zA-Z0-9_.\-:]{1,128}$/;

function isValidKey(key: unknown): key is string {
  return typeof key === "string" && KEY_RE.test(key);
}

router.get("/settings/:key", (req, res) => {
  try {
    const { key } = req.params;
    if (!isValidKey(key)) {
      res.status(400).json({ error: "Invalid settings key" });
      return;
    }

    const db = getDb();
    const row = db
      .prepare("SELECT value, updated_at FROM settings WHERE key = ?")
      .get(key) as { value: string; updated_at: number } | undefined;

    if (!row) {
      res.json({ value: null, updatedAt: 0 });
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(row.value);
    } catch {
      parsed = null;
    }

    res.json({ value: parsed, updatedAt: row.updated_at });
  } catch (err) {
    req.log.error({ err }, "Error reading settings");
    res.status(500).json({ error: "Failed to read settings" });
  }
});

router.put("/settings/:key", (req, res) => {
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

    const now = Math.floor(Date.now() / 1000);
    const serialized = JSON.stringify(body.value);

    const db = getDb();
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)"
    ).run(key, serialized, now);

    res.json({ value: body.value, updatedAt: now });
  } catch (err) {
    req.log.error({ err }, "Error saving settings");
    res.status(500).json({ error: "Failed to save settings" });
  }
});

export default router;
