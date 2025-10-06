// TODO: optimize sorted set cleanup
import type { Store } from '../store/store.js';
import type { RateLimitResult, RateLimiterConfig } from './types.js';
import { SLIDING_WINDOW_SCRIPT } from './lua/sliding-window.lua.js';

let requestCounter = 0;

/**
 * Sliding window log algorithm backed by a Redis Lua script (or memory store emulation).
 *
 * Tracks every request timestamp in a sorted set for maximum accuracy.
 * O(n) memory per key where n is the number of requests in the window.
 */
export async function slidingWindowConsume(
  store: Store,
  key: string,
  config: RateLimiterConfig,
  nowMs: number,
  cost: number = 1,
): Promise<RateLimitResult> {
  // Generate a unique request ID to avoid sorted set deduplication
  const requestId = `${nowMs}:${requestCounter++}:${Math.random().toString(36).slice(2, 8)}`;

  // For cost > 1, we issue multiple consume calls but only report the last result.
  // This is a simplification; a production system might handle this in a single Lua call.
  let lastResult: RateLimitResult | undefined;

  for (let i = 0; i < cost; i++) {
    const id = i === 0 ? requestId : `${requestId}:${i}`;
    const result = (await store.eval(
      SLIDING_WINDOW_SCRIPT,
      [key],
      [config.limit, config.windowMs, nowMs, id],
    )) as number[];

    const allowed = result[0] === 1;
    const remaining = result[1]!;
    const retryAfterMs = result[2]!;
    const resetMs = result[3]!;

    lastResult = {
      allowed,
      limit: config.limit,
      remaining: Math.max(0, remaining),
      resetMs,
      ...(allowed ? {} : { retryAfterMs }),
    };

    if (!allowed) {
      return lastResult;
    }
  }

  return lastResult!;
}
