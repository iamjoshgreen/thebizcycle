import { Router } from "express";
import { fetchHousingPayload, type HousingPayload } from "../lib/housingFetcher.js";
import { getDb } from "../lib/sqlite.js";

const router = Router();

const CACHE_KEY = "housing_payload";

function readCache(): HousingPayload | null {
  try {
    const db = getDb();
    const row = db
      .prepare("SELECT value FROM cache WHERE key = ?")
      .get(CACHE_KEY) as { value: string } | undefined;
    if (!row) return null;
    return JSON.parse(row.value) as HousingPayload;
  } catch {
    return null;
  }
}

function writeCache(payload: HousingPayload): void {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    "INSERT OR REPLACE INTO cache (key, value, updated_at) VALUES (?, ?, ?)"
  ).run(CACHE_KEY, JSON.stringify(payload), now);
}

// GET /api/housing
router.get("/housing", async (req, res) => {
  try {
    const cached = readCache();
    if (cached) {
      res.json(cached);
      return;
    }
    const payload = await fetchHousingPayload();
    writeCache(payload);
    res.json(payload);
  } catch (err) {
    req.log.error({ err }, "Error fetching housing data");
    res.status(500).json({ error: "Failed to fetch housing data" });
  }
});

// POST /api/housing/refresh
router.post("/housing/refresh", async (req, res) => {
  try {
    const payload = await fetchHousingPayload();
    writeCache(payload);
    res.json(payload);
  } catch (err) {
    req.log.error({ err }, "Error refreshing housing data");
    res.status(500).json({ error: "Failed to refresh housing data" });
  }
});

export default router;
