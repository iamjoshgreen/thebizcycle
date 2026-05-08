import { db, indicatorDataTable } from "@workspace/db";
import { eq } from "drizzle-orm";

/**
 * Read a stored indicator payload from the database.
 * Returns null if no row exists for `name`.
 *
 * GET routes use this and ONLY this. They never call FRED.
 */
export async function readIndicator<T>(name: string): Promise<T | null> {
  const rows = await db
    .select({ data: indicatorDataTable.data })
    .from(indicatorDataTable)
    .where(eq(indicatorDataTable.name, name))
    .limit(1);
  if (rows.length === 0) return null;
  return rows[0]!.data as T;
}

/**
 * UPSERT a freshly-computed indicator payload into the database.
 * Called by /refresh routes after fetching new data from FRED.
 */
export async function writeIndicator<T>(name: string, data: T): Promise<void> {
  await db
    .insert(indicatorDataTable)
    .values({ name, data: data as unknown as object })
    .onConflictDoUpdate({
      target: indicatorDataTable.name,
      set: { data: data as unknown as object, updatedAt: new Date() },
    });
}
