import { Router } from "express";
import { fetchAndCompute, type ChartPayload } from "../lib/dataFetcher.js";
import { getDb } from "../lib/sqlite.js";

const router = Router();

const CACHE_KEY = "chart_payload";

function readCache(): ChartPayload | null {
  try {
    const db = getDb();
    const row = db
      .prepare("SELECT value FROM cache WHERE key = ?")
      .get(CACHE_KEY) as { value: string } | undefined;
    if (!row) return null;
    return JSON.parse(row.value) as ChartPayload;
  } catch {
    return null;
  }
}

function writeCache(payload: ChartPayload): void {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    "INSERT OR REPLACE INTO cache (key, value, updated_at) VALUES (?, ?, ?)"
  ).run(CACHE_KEY, JSON.stringify(payload), now);
}

// GET /api/chart
router.get("/chart", async (req, res) => {
  try {
    const cached = readCache();
    if (cached) {
      res.json(cached);
      return;
    }

    // No cache — fetch on demand
    const payload = await fetchAndCompute();
    writeCache(payload);
    res.json(payload);
  } catch (err) {
    req.log.error({ err }, "Error fetching chart data");
    res.status(500).json({ error: "Failed to fetch chart data" });
  }
});

// POST /api/refresh
router.post("/refresh", async (req, res) => {
  try {
    const payload = await fetchAndCompute();
    writeCache(payload);
    res.json(payload);
  } catch (err) {
    req.log.error({ err }, "Error refreshing chart data");
    res.status(500).json({ error: "Failed to refresh chart data" });
  }
});

export default router;
