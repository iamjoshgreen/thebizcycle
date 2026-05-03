import { Router } from "express";
import { db, drawingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const router = Router();

router.get("/drawings", async (req, res) => {
  try {
    const rows = await db
      .select()
      .from(drawingsTable)
      .where(eq(drawingsTable.id, 1))
      .limit(1);

    if (rows.length === 0) {
      res.json({ data: null, updatedAt: 0 });
      return;
    }

    const row = rows[0]!;
    res.json({
      data: row.data,
      updatedAt: Math.floor(row.updatedAt.getTime() / 1000),
    });
  } catch (err) {
    req.log.error({ err }, "Error reading drawings");
    res.status(500).json({ error: "Failed to read drawings" });
  }
});

router.post("/drawings", async (req, res) => {
  try {
    const body = req.body as { data?: unknown };
    if (
      !body ||
      typeof body !== "object" ||
      body.data === undefined ||
      body.data === null ||
      typeof body.data !== "object"
    ) {
      res.status(400).json({ error: "Body must be { data: object | array }" });
      return;
    }
    const { data } = body;
    const now = new Date();

    await db
      .insert(drawingsTable)
      .values({ id: 1, data: data as object })
      .onConflictDoUpdate({
        target: drawingsTable.id,
        set: { data: data as object, updatedAt: now },
      });

    res.json({ data, updatedAt: Math.floor(now.getTime() / 1000) });
  } catch (err) {
    req.log.error({ err }, "Error saving drawings");
    res.status(500).json({ error: "Failed to save drawings" });
  }
});

export default router;
