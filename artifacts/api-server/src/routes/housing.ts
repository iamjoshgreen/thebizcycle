import { Router } from "express";
import { fetchHousingPayload, type HousingPayload } from "../lib/housingFetcher.js";
import { readCache, writeCache, tryWriteCache } from "../lib/cache.js";

const router = Router();
const CACHE_KEY = "housing_payload";

router.get("/housing", async (req, res) => {
  try {
    const cached = await readCache<HousingPayload>(CACHE_KEY);
    if (cached) {
      res.json(cached);
      return;
    }
    const payload = await fetchHousingPayload();
    await tryWriteCache(CACHE_KEY, payload);
    res.json(payload);
  } catch (err) {
    req.log.error({ err }, "Error fetching housing data");
    res.status(500).json({ error: "Failed to fetch housing data" });
  }
});

router.post("/housing/refresh", async (req, res) => {
  try {
    const payload = await fetchHousingPayload();
    await writeCache(CACHE_KEY, payload);
    res.json(payload);
  } catch (err) {
    req.log.error({ err }, "Error refreshing housing data");
    res.status(500).json({ error: "Failed to refresh housing data" });
  }
});

export default router;
