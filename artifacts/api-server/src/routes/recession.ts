import { Router } from "express";
import { fetchRecessionPayload, type RecessionPayload } from "../lib/recessionFetcher.js";
import { readIndicator, writeIndicator } from "../lib/indicatorStore.js";

const router = Router();
const NAME = "recession";

router.get("/recession", async (req, res) => {
  try {
    const data = await readIndicator<RecessionPayload>(NAME);
    if (!data) {
      res.status(404).json({ error: "no data" });
      return;
    }
    res.json(data);
  } catch (err) {
    req.log.error({ err }, "Error reading recession data from database");
    res.status(500).json({ error: "Failed to read recession data" });
  }
});

router.post("/recession/refresh", async (req, res) => {
  try {
    const payload = await fetchRecessionPayload();
    await writeIndicator(NAME, payload);
    res.json(payload);
  } catch (err) {
    req.log.error({ err }, "Error refreshing recession data");
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(502).json({ error: `Failed to refresh recession data: ${msg}` });
  }
});

export default router;
