import { Router } from "express";
import {
  fetchCyclicalPayload,
  type CyclicalPayload,
} from "../lib/cyclicalFetcher.js";
import { readCache, writeCache } from "../lib/cache.js";

const router = Router();
const CACHE_KEY = "cyclical_payload";

router.get("/cyclical", async (req, res) => {
  try {
    const cached = await readCache<CyclicalPayload>(CACHE_KEY);
    if (cached) {
      res.json(cached);
      return;
    }
    const payload = await fetchCyclicalPayload();
    await writeCache(CACHE_KEY, payload);
    res.json(payload);
  } catch (err) {
    req.log.error({ err }, "Error fetching cyclical data");
    res.status(500).json({ error: "Failed to fetch cyclical data" });
  }
});

router.post("/cyclical/refresh", async (req, res) => {
  try {
    const payload = await fetchCyclicalPayload();
    await writeCache(CACHE_KEY, payload);
    res.json(payload);
  } catch (err) {
    req.log.error({ err }, "Error refreshing cyclical data");
    res.status(500).json({ error: "Failed to refresh cyclical data" });
  }
});

export default router;
