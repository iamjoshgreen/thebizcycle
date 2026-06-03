import { logger } from "./logger.js";
import { fredLimiter } from "./fredLimiter.js";

const DEFAULT_ATTEMPTS = 4;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 8000;
const DEFAULT_TIMEOUT_MS = 20_000;

// HTTP 429 (rate limit) gets a much longer, dedicated backoff. When FRED tells
// us we're over the limit, retrying after a few hundred ms only deepens the
// lockout — so we back off for seconds and honor any Retry-After it sends.
const RATE_LIMIT_BASE_DELAY_MS = 5_000;
const RATE_LIMIT_MAX_DELAY_MS = 60_000;

function jitter(ms: number): number {
  return ms * (0.5 + Math.random());
}

function isTransientStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

// Parse a Retry-After header value (either delta-seconds or an HTTP date) into
// a delay in milliseconds. Returns null when absent or unparseable.
function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(header);
  if (!Number.isNaN(when)) return Math.max(0, when - Date.now());
  return null;
}

export interface FetchWithRetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  timeoutMs?: number;
  label?: string;
}

/**
 * fetch() with bounded retries and per-attempt timeout, routed through the
 * shared process-wide FRED rate limiter so concurrency and request spacing are
 * capped no matter how many callers fan out in parallel.
 *
 * Retries on:
 *   - network errors (TypeError from fetch, AbortError on timeout)
 *   - HTTP 408 / 425 / 429 / 5xx
 *
 * Backoff:
 *   - 429 uses a long, dedicated backoff and honors the Retry-After header.
 *   - other transient errors use exponential backoff with jitter.
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
    // Default exponential backoff for this attempt; may be overridden for 429.
    let delay = jitter(Math.min(maxDelay, baseDelay * 2 ** (attempt - 1)));

    try {
      const resp = await fredLimiter.schedule(async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          return await fetch(url, { signal: controller.signal });
        } finally {
          clearTimeout(timer);
        }
      });

      if (resp.ok) return resp;

      if (!isTransientStatus(resp.status) || attempt === attempts) {
        const body = await resp.text().catch(() => "");
        throw new Error(
          `HTTP ${resp.status} for ${label}${body ? `: ${body.slice(0, 200)}` : ""}`,
        );
      }

      lastErr = new Error(`HTTP ${resp.status} for ${label}`);

      if (resp.status === 429) {
        const retryAfter = parseRetryAfter(resp.headers.get("retry-after"));
        delay =
          // Clamp Retry-After so an unexpectedly large upstream value can't
          // stall a refresh (and every deduped follower) for minutes.
          retryAfter != null
            ? Math.min(retryAfter, RATE_LIMIT_MAX_DELAY_MS)
            : jitter(
                Math.min(RATE_LIMIT_MAX_DELAY_MS, RATE_LIMIT_BASE_DELAY_MS * 2 ** (attempt - 1)),
              );
        logger.warn(
          { label, status: 429, attempt, delayMs: Math.round(delay) },
          "fetchWithRetry: FRED rate limited (429), backing off",
        );
      } else {
        logger.warn(
          { label, status: resp.status, attempt },
          "fetchWithRetry: transient HTTP error, retrying",
        );
      }
    } catch (err) {
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

    await new Promise((r) => setTimeout(r, delay));
  }

  throw new Error(
    `fetchWithRetry failed after ${attempts} attempts for ${label}: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`,
  );
}
