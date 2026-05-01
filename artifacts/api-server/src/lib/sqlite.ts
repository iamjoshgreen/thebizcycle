import Database from "better-sqlite3";
import path from "path";
import { existsSync, mkdirSync } from "fs";

const DB_PATH = "/home/runner/workspace/data/chart.db";

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;

  const dir = path.dirname(DB_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");

  _db.exec(`
    CREATE TABLE IF NOT EXISTS cache (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS drawings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      data TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  return _db;
}

// One-time invalidation of stale cache entries when the data-fetching logic
// changes. Bump CACHE_BUST_VERSION whenever a fix changes the *meaning* of
// cached values (e.g. the period2 fix that made today's SPX close visible).
// Each version runs at most once per database.
const CACHE_BUST_VERSION = "v3_spxm2_required_2026_05";
// Only invalidate caches whose meaning changed with this fix. The
// recession_payload/housing_payload caches use FRED data (unaffected).
const CACHE_BUST_KEYS = ["chart_payload"];

export function runCacheBustIfNeeded(): void {
  const db = getDb();
  const row = db
    .prepare("SELECT value FROM cache WHERE key = ?")
    .get("__cache_bust_version") as { value: string } | undefined;
  if (row?.value === CACHE_BUST_VERSION) return;

  const now = Math.floor(Date.now() / 1000);
  const del = db.prepare("DELETE FROM cache WHERE key = ?");
  let deleted = 0;
  for (const k of CACHE_BUST_KEYS) {
    deleted += del.run(k).changes;
  }
  db.prepare(
    "INSERT OR REPLACE INTO cache (key, value, updated_at) VALUES (?, ?, ?)"
  ).run("__cache_bust_version", CACHE_BUST_VERSION, now);
  // Use console here rather than the pino logger to avoid an import cycle
  console.log(
    `[sqlite] Cache bust ${CACHE_BUST_VERSION}: removed ${deleted} stale cache row(s)`
  );
}
