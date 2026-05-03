import { db, cacheTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const CACHE_BUST_VERSION = "v3_spxm2_required_2026_05";
const CACHE_BUST_KEYS = ["chart_payload"];
const CACHE_BUST_KEY = "__cache_bust_version";

export async function readCache<T>(key: string): Promise<T | null> {
  try {
    const rows = await db
      .select({ value: cacheTable.value })
      .from(cacheTable)
      .where(eq(cacheTable.key, key))
      .limit(1);
    if (rows.length === 0) return null;
    return rows[0]!.value as T;
  } catch {
    return null;
  }
}

export async function writeCache<T>(key: string, value: T): Promise<void> {
  await db
    .insert(cacheTable)
    .values({ key, value: value as unknown as object })
    .onConflictDoUpdate({
      target: cacheTable.key,
      set: { value: value as unknown as object, updatedAt: new Date() },
    });
}

/**
 * Best-effort cache write: never throws. Use this on read paths so that a
 * transient DB write failure does not break a successful fetch.
 */
export async function tryWriteCache<T>(key: string, value: T): Promise<void> {
  try {
    await writeCache(key, value);
  } catch (err) {
    console.warn(`[cache] writeCache failed for key=${key}`, err);
  }
}

export async function runCacheBustIfNeeded(): Promise<void> {
  const current = await readCache<string>(CACHE_BUST_KEY);
  if (current === CACHE_BUST_VERSION) return;

  for (const k of CACHE_BUST_KEYS) {
    await db.delete(cacheTable).where(eq(cacheTable.key, k));
  }
  await writeCache(CACHE_BUST_KEY, CACHE_BUST_VERSION);
  console.log(
    `[cache] Cache bust ${CACHE_BUST_VERSION}: cleared ${CACHE_BUST_KEYS.join(", ")}`,
  );
}
