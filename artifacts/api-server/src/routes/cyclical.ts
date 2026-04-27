import { Router } from "express";
import {
  fetchCyclicalPayload,
  type CyclicalPayload,
} from "../lib/cyclicalFetcher.js";
import { getDb } from "../lib/sqlite.js";

const router = Router();

const CACHE_KEY = "cyclical_payload";

function readCache(): CyclicalPayload | null {
  try {
    const db = getDb();
    const row = db
      .prepare("SELECT value FROM cache WHERE key = ?")
      .get(CACHE_KEY) as { value: string } | undefined;
    if (!row) return null;
    return JSON.parse(row.value) as CyclicalPayload;
  } catch {
    return null;
  }
}

function writeCache(payload: CyclicalPayload): void {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    "INSERT OR REPLACE INTO cache (key, value, updated_at) VALUES (?, ?, ?)"
  ).run(CACHE_KEY, JSON.stringify(payload), now);
}

// GET /api/cyclical
router.get("/cyclical", async (req, res) => {
  try {
    const cached = readCache();
    if (cached) {
      res.json(cached);
      return;
    }
    const payload = await fetchCyclicalPayload();
    writeCache(payload);
    res.json(payload);
  } catch (err) {
    req.log.error({ err }, "Error fetching cyclical data");
    res.status(500).json({ error: "Failed to fetch cyclical data" });
  }
});

// POST /api/cyclical/refresh
router.post("/cyclical/refresh", async (req, res) => {
  try {
    const payload = await fetchCyclicalPayload();
    writeCache(payload);
    res.json(payload);
  } catch (err) {
    req.log.error({ err }, "Error refreshing cyclical data");
    res.status(500).json({ error: "Failed to refresh cyclical data" });
  }
});

export default router;
