/**
 * Process-wide rate limiter for outbound FRED API requests.
 *
 * FRED enforces a per-key request limit (120 requests/minute). Each indicator
 * refresh fans out many series in parallel, and several indicators can refresh
 * at once, so without a single shared gate the server bursts far past the limit
 * and FRED locks the key out with HTTP 429.
 *
 * This limiter enforces two things across the WHOLE process:
 *   - a minimum spacing between request starts (caps the steady-state rate)
 *   - a maximum number of in-flight requests (bounds connection pile-up when
 *     responses are slow)
 *
 * Every FRED call routes through `fredLimiter.schedule(...)` via fetchWithRetry,
 * including retries, so even a retry storm stays under the limit.
 */
export class RateLimiter {
  private readonly maxConcurrent: number;
  private readonly minIntervalMs: number;
  private active = 0;
  private nextSlot = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(opts: { maxConcurrent: number; minIntervalMs: number }) {
    this.maxConcurrent = opts.maxConcurrent;
    this.minIntervalMs = opts.minIntervalMs;
  }

  private acquire(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active++;
      return Promise.resolve();
    }
    // At capacity — wait for a permit to be transferred to us on release.
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      // Transfer the permit directly to the next waiter; `active` is unchanged.
      next();
    } else {
      this.active--;
    }
  }

  // Reserve the next start slot so requests begin at least `minIntervalMs`
  // apart, regardless of how many callers are queued.
  private async waitForSlot(): Promise<void> {
    const now = Date.now();
    const start = Math.max(now, this.nextSlot);
    this.nextSlot = start + this.minIntervalMs;
    const wait = start - now;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }

  async schedule<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      await this.waitForSlot();
      return await fn();
    } finally {
      this.release();
    }
  }
}

// Conservative defaults: ~85 requests/minute steady state, at most 3 concurrent.
// Comfortably under FRED's 120/min so a full multi-indicator refresh never trips
// the rate limit, while still completing a 10-series indicator in a few seconds.
export const fredLimiter = new RateLimiter({
  maxConcurrent: 3,
  minIntervalMs: 700,
});
