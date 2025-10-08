import type { Store } from '../store/store.js';
import type { RateLimitResult, RateLimiterConfig } from './types.js';
import { FIXED_WINDOW_SCRIPT } from './lua/fixed-window.lua.js';

/**
 * Fixed window counter algorithm backed by a Redis Lua script (or memory store emulation).
 *
 * Simple, low memory (1 counter per window). Allows 2x burst at window boundaries.
 */
export async function fixedWindowConsume(
  store: Store,
  key: string,
  config: RateLimiterConfig,
  nowMs: number,
  _cost: number = 1,
): Promise<RateLimitResult> {
  const result = (await store.eval(
    FIXED_WINDOW_SCRIPT,
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
