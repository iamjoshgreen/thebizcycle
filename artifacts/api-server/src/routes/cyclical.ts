import { Router } from "express";
import {
  fetchCyclicalPayload,
  type CyclicalPayload,
} from "../lib/cyclicalFetcher.js";
import { readIndicator, writeIndicator } from "../lib/indicatorStore.js";
import { dedupeRefresh } from "../lib/refreshDedup.js";

const router = Router();
const NAME = "cyclical";

router.get("/cyclical", async (req, res) => {
  try {
    const data = await readIndicator<CyclicalPayload>(NAME);
    if (!data) {
      res.status(404).json({ error: "no data" });
      return;
    }
    res.json(data);
  } catch (err) {
    req.log.error({ err }, "Error reading cyclical data from database");
    res.status(500).json({ error: "Failed to read cyclical data" });
  }
});

router.post("/cyclical/refresh", async (req, res) => {
  try {
    const payload = await dedupeRefresh(NAME, async () => {
      const p = await fetchCyclicalPayload();
      await writeIndicator(NAME, p);
      return p;
    });
    res.json(payload);
  } catch (err) {
    req.log.error({ err }, "Error refreshing cyclical data");
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(502).json({ error: `Failed to refresh cyclical data: ${msg}` });
  }
});

export default router;
