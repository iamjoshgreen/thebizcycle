import { logger } from "./logger.js";

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 400;
const DEFAULT_MAX_DELAY_MS = 4000;
const DEFAULT_TIMEOUT_MS = 20_000;

function jitter(ms: number): number {
  return ms * (0.5 + Math.random());
}

function isTransientStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export interface FetchWithRetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  timeoutMs?: number;
  label?: string;
}

/**
 * fetch() with bounded retries and per-attempt timeout.
 *
 * Retries on:
 *   - network errors (TypeError from fetch, AbortError on timeout)
 *   - HTTP 408 / 425 / 429 / 5xx
 *
 * Fails fast on:
 *   - Other 4xx (e.g. bad series id) — propagated as a thrown Error
 *
 * Returns the final Response if it is ok, otherwise throws an Error with the
 * last status / cause attached.
 */
export async function fetchWithRetry(
  url: string,
  options: FetchWithRetryOptions = {},
): Promise<Response> {
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  const baseDelay = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelay = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const label = options.label ?? url;

  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (resp.ok) return resp;

      if (!isTransientStatus(resp.status) || attempt === attempts) {
        const body = await resp.text().catch(() => "");
        throw new Error(
          `HTTP ${resp.status} for ${label}${body ? `: ${body.slice(0, 200)}` : ""}`,
        );
      }
      lastErr = new Error(`HTTP ${resp.status} for ${label}`);
      logger.warn(
        { label, status: resp.status, attempt },
        "fetchWithRetry: transient HTTP error, retrying",
      );
    } catch (err) {
      clearTimeout(timer);
      // If we already decided this was non-transient and threw, re-throw.
      if (
        err instanceof Error &&
        err.message.startsWith("HTTP ") &&
        !err.message.match(/HTTP (408|425|429|5\d\d)/)
      ) {
        throw err;
      }
      lastErr = err;
      if (attempt === attempts) break;
      logger.warn({ label, err, attempt }, "fetchWithRetry: network error, retrying");
    }

    const delay = jitter(Math.min(maxDelay, baseDelay * 2 ** (attempt - 1)));
    await new Promise((r) => setTimeout(r, delay));
  }

  throw new Error(
    `fetchWithRetry failed after ${attempts} attempts for ${label}: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`,
  );
}
