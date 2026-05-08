import { Router } from "express";
import { fetchAndCompute, type ChartPayload } from "../lib/dataFetcher.js";
import { readIndicator, writeIndicator } from "../lib/indicatorStore.js";

const router = Router();
const NAME = "chart";

router.get("/chart", async (req, res) => {
  try {
    const data = await readIndicator<ChartPayload>(NAME);
    if (!data) {
      res.status(404).json({ error: "no data" });
      return;
    }
    res.json(data);
  } catch (err) {
    req.log.error({ err }, "Error reading chart data from database");
    res.status(500).json({ error: "Failed to read chart data" });
  }
});

router.post("/refresh", async (req, res) => {
  try {
    const payload = await fetchAndCompute();
    await writeIndicator(NAME, payload);
    res.json(payload);
  } catch (err) {
    req.log.error({ err }, "Error refreshing chart data");
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(502).json({ error: `Failed to refresh chart data: ${msg}` });
  }
});

export default router;
