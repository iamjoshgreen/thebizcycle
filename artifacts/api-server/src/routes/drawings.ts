import { Router } from "express";
import { getDb } from "../lib/sqlite.js";

const router = Router();

// GET /api/drawings
router.get("/drawings", (req, res) => {
  try {
    const db = getDb();
    const row = db
      .prepare("SELECT data, updated_at FROM drawings WHERE id = 1")
      .get() as { data: string; updated_at: number } | undefined;

    if (!row) {
      res.json({ data: null, updatedAt: 0 });
      return;
    }

    res.json({ data: JSON.parse(row.data), updatedAt: row.updated_at });
  } catch (err) {
    req.log.error({ err }, "Error reading drawings");
    res.status(500).json({ error: "Failed to read drawings" });
  }
});

// POST /api/drawings
router.post("/drawings", (req, res) => {
  try {
    const { data } = req.body as { data: unknown };
    const now = Math.floor(Date.now() / 1000);
    const db = getDb();

    db.prepare(
      "INSERT OR REPLACE INTO drawings (id, data, updated_at) VALUES (1, ?, ?)"
    ).run(JSON.stringify(data), now);

    res.json({ data, updatedAt: now });
  } catch (err) {
    req.log.error({ err }, "Error saving drawings");
    res.status(500).json({ error: "Failed to save drawings" });
  }
});

export default router;
