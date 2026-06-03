/**
 * De-duplicates concurrent refreshes for the same indicator.
 *
 * Each /refresh route fans out many FRED requests. If two refreshes for the
 * same indicator overlap (e.g. a double click, or a retrying client), they
 * would double the outbound FRED load for no benefit — both produce the same
 * payload. This collapses overlapping refreshes onto a single in-flight run:
 * the second caller awaits the first run's result instead of starting its own.
 */
const inFlight = new Map<string, Promise<unknown>>();

export function dedupeRefresh<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key) as Promise<T> | undefined;
  if (existing) return existing;

  const run = (async () => fn())().finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, run);
  return run;
}
