import { Router } from "express";
import { fetchHousingPayload, type HousingPayload } from "../lib/housingFetcher.js";
import { readIndicator, writeIndicator } from "../lib/indicatorStore.js";

const router = Router();
const NAME = "housing";

router.get("/housing", async (req, res) => {
  try {
    const data = await readIndicator<HousingPayload>(NAME);
    if (!data) {
      res.status(404).json({ error: "no data" });
      return;
    }
    res.json(data);
  } catch (err) {
    req.log.error({ err }, "Error reading housing data from database");
    res.status(500).json({ error: "Failed to read housing data" });
  }
});

router.post("/housing/refresh", async (req, res) => {
  try {
    const payload = await fetchHousingPayload();
    await writeIndicator(NAME, payload);
    res.json(payload);
  } catch (err) {
    req.log.error({ err }, "Error refreshing housing data");
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(502).json({ error: `Failed to refresh housing data: ${msg}` });
  }
});

export default router;
