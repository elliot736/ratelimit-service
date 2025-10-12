import type { Store } from '../store/store.js';
import type { RateLimitResult, RateLimiterConfig } from './types.js';
import { SLIDING_WINDOW_COUNTER_SCRIPT } from './lua/sliding-window-counter.lua.js';

/**
 * Sliding window counter (hybrid) algorithm backed by a Redis Lua script (or memory store emulation).
 *
 * Uses two fixed windows with weighted interpolation. Near-accurate with O(1) memory.
 * Best default choice for most use cases.
 */
export async function slidingWindowCounterConsume(
  store: Store,
  key: string,
  config: RateLimiterConfig,
  nowMs: number,
  _cost: number = 1,
): Promise<RateLimitResult> {
  const result = (await store.eval(
    SLIDING_WINDOW_COUNTER_SCRIPT,
    [key],
    [config.limit, config.windowMs, nowMs],
  )) as number[];

  const allowed = result[0] === 1;
  const remaining = result[1]!;
  const retryAfterMs = result[2]!;
  const resetMs = result[3]!;

  return {
    allowed,
    limit: config.limit,
    remaining: Math.max(0, remaining),
    resetMs,
    ...(allowed ? {} : { retryAfterMs }),
  };
}
