import { Router } from "express";
import { fetchRecessionPayload, type RecessionPayload } from "../lib/recessionFetcher.js";
import { getDb } from "../lib/sqlite.js";

const router = Router();

const CACHE_KEY = "recession_payload";

function readCache(): RecessionPayload | null {
  try {
    const db = getDb();
    const row = db
      .prepare("SELECT value FROM cache WHERE key = ?")
      .get(CACHE_KEY) as { value: string } | undefined;
    if (!row) return null;
    return JSON.parse(row.value) as RecessionPayload;
  } catch {
    return null;
  }
}

function writeCache(payload: RecessionPayload): void {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    "INSERT OR REPLACE INTO cache (key, value, updated_at) VALUES (?, ?, ?)"
  ).run(CACHE_KEY, JSON.stringify(payload), now);
}

// GET /api/recession
router.get("/recession", async (req, res) => {
  try {
    const cached = readCache();
    if (cached) {
      res.json(cached);
      return;
    }
    const payload = await fetchRecessionPayload();
    writeCache(payload);
    res.json(payload);
  } catch (err) {
    req.log.error({ err }, "Error fetching recession data");
    res.status(500).json({ error: "Failed to fetch recession data" });
  }
});

// POST /api/recession/refresh
router.post("/recession/refresh", async (req, res) => {
  try {
    const payload = await fetchRecessionPayload();
    writeCache(payload);
    res.json(payload);
  } catch (err) {
    req.log.error({ err }, "Error refreshing recession data");
    res.status(500).json({ error: "Failed to refresh recession data" });
  }
});

export default router;
