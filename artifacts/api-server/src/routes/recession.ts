import { Router } from "express";
import { fetchRecessionPayload, type RecessionPayload } from "../lib/recessionFetcher.js";
import { readCache, writeCache } from "../lib/cache.js";

const router = Router();
const CACHE_KEY = "recession_payload";

router.get("/recession", async (req, res) => {
  try {
    const cached = await readCache<RecessionPayload>(CACHE_KEY);
    if (cached) {
      res.json(cached);
      return;
    }
    const payload = await fetchRecessionPayload();
    await writeCache(CACHE_KEY, payload);
    res.json(payload);
  } catch (err) {
    req.log.error({ err }, "Error fetching recession data");
    res.status(500).json({ error: "Failed to fetch recession data" });
  }
});

router.post("/recession/refresh", async (req, res) => {
  try {
    const payload = await fetchRecessionPayload();
    await writeCache(CACHE_KEY, payload);
    res.json(payload);
  } catch (err) {
    req.log.error({ err }, "Error refreshing recession data");
    res.status(500).json({ error: "Failed to refresh recession data" });
  }
});

export default router;
