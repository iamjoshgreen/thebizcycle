import { Router } from "express";
import { fetchAndCompute, type ChartPayload } from "../lib/dataFetcher.js";
import { readCache, writeCache, tryWriteCache } from "../lib/cache.js";

const router = Router();
const CACHE_KEY = "chart_payload";

router.get("/chart", async (req, res) => {
  try {
    const cached = await readCache<ChartPayload>(CACHE_KEY);
    if (cached) {
      res.json(cached);
      return;
    }
    const payload = await fetchAndCompute();
    await tryWriteCache(CACHE_KEY, payload);
    res.json(payload);
  } catch (err) {
    req.log.error({ err }, "Error fetching chart data");
    res.status(500).json({ error: "Failed to fetch chart data" });
  }
});

router.post("/refresh", async (req, res) => {
  try {
    const payload = await fetchAndCompute();
    await writeCache(CACHE_KEY, payload);
    res.json(payload);
  } catch (err) {
    req.log.error({ err }, "Error refreshing chart data");
    res.status(500).json({ error: "Failed to refresh chart data" });
  }
});

export default router;
