import { Router } from "express";
import {
  fetchBtcQuantilePayload,
  type BtcQuantilePayload,
} from "../lib/btcQuantileFetcher.js";
import { readIndicator, writeIndicator } from "../lib/indicatorStore.js";
import { dedupeRefresh } from "../lib/refreshDedup.js";

const router = Router();
const NAME = "btc-quantile";

router.get("/btc-quantile", async (req, res) => {
  try {
    const data = await readIndicator<BtcQuantilePayload>(NAME);
    if (!data) {
      res.status(404).json({ error: "no data" });
      return;
    }
    res.json(data);
  } catch (err) {
    req.log.error({ err }, "Error reading btc-quantile data from database");
    res.status(500).json({ error: "Failed to read btc-quantile data" });
  }
});

router.post("/btc-quantile/refresh", async (req, res) => {
  try {
    const payload = await dedupeRefresh(NAME, async () => {
      const p = await fetchBtcQuantilePayload();
      await writeIndicator(NAME, p);
      return p;
    });
    res.json(payload);
  } catch (err) {
    req.log.error({ err }, "Error refreshing btc-quantile data");
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(502).json({ error: `Failed to refresh btc-quantile data: ${msg}` });
  }
});

export default router;
