import { Router } from "express";
import { fetchRateShockPayload, type RateShockPayload } from "../lib/rateShockFetcher.js";
import { readIndicator, writeIndicator } from "../lib/indicatorStore.js";
import { dedupeRefresh } from "../lib/refreshDedup.js";

const router = Router();
const NAME = "rateShock";

router.get("/rate-shock", async (req, res) => {
  try {
    const data = await readIndicator<RateShockPayload>(NAME);
    if (!data) {
      res.status(404).json({ error: "no data" });
      return;
    }
    res.json(data);
  } catch (err) {
    req.log.error({ err }, "Error reading rate shock data from database");
    res.status(500).json({ error: "Failed to read rate shock data" });
  }
});

router.post("/rate-shock/refresh", async (req, res) => {
  try {
    const payload = await dedupeRefresh(NAME, async () => {
      const p = await fetchRateShockPayload();
      await writeIndicator(NAME, p);
      return p;
    });
    res.json(payload);
  } catch (err) {
    req.log.error({ err }, "Error refreshing rate shock data");
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(502).json({ error: `Failed to refresh rate shock data: ${msg}` });
  }
});

export default router;
