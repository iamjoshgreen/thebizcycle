import { Router } from "express";
import { fetchGliPayload, type GliPayload } from "../lib/gliFetcher.js";
import { readIndicator, writeIndicator } from "../lib/indicatorStore.js";

const router = Router();
const NAME = "gli";

router.get("/gli", async (req, res) => {
  try {
    const data = await readIndicator<GliPayload>(NAME);
    if (!data) {
      res.status(404).json({ error: "no data" });
      return;
    }
    res.json(data);
  } catch (err) {
    req.log.error({ err }, "Error reading gli data from database");
    res.status(500).json({ error: "Failed to read gli data" });
  }
});

router.post("/gli/refresh", async (req, res) => {
  try {
    const payload = await fetchGliPayload();
    await writeIndicator(NAME, payload);
    res.json(payload);
  } catch (err) {
    req.log.error({ err }, "Error refreshing gli data");
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(502).json({ error: `Failed to refresh gli data: ${msg}` });
  }
});

export default router;
