---
name: FRED rate limiting
description: How the api-server stays under FRED's per-key request limit across all indicator refreshes.
---

# FRED rate limiting

FRED enforces ~120 requests/minute per API key. Each indicator refresh fans out
many series in parallel, and several indicators can refresh at once, so any new
FRED-calling code MUST go through the shared throttle or it will re-trigger the
429 lockout that took down all refreshes in production.

**The rule:** every outbound FRED request goes through `fetchWithRetry`, which
routes each attempt (including retries) through the single process-wide
`fredLimiter` (`fredLimiter.ts`): a concurrency cap + minimum start-spacing gate.
Do NOT add a second FRED fetch path that bypasses `fetchWithRetry`/`fredLimiter`.

**Why:** the original lockout had three compounding causes — unbounded
`Promise.all` fan-out, no global throttle across the 6 refresh endpoints, and a
short (400ms) retry backoff on 429 that amplified load and kept the key
throttled. A single shared limiter + long 429 backoff (honoring, and clamping,
`Retry-After`) is what fixes it.

**How to apply:**
- New indicator/series → call FRED via `fetchWithRetry`; never raw `fetch`.
- Tuning rate: change `maxConcurrent`/`minIntervalMs` in `fredLimiter.ts` only.
  700ms spacing ≈ 85 req/min, comfortably under 120.
- Overlapping refreshes for the same indicator are collapsed by `dedupeRefresh`
  (`refreshDedup.ts`) in each refresh route — keep new refresh routes wrapped in it.
- The limiter is process-local. If the server is ever scaled to multiple
  instances sharing one FRED key, this throttle is no longer sufficient on its own.
