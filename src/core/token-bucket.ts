// TODO: handle burst overflow
import type { Store } from '../store/store.js';
import type { RateLimitResult, TokenBucketConfig } from './types.js';
import { TOKEN_BUCKET_SCRIPT } from './lua/token-bucket.lua.js';

/**
 * Token bucket algorithm backed by a Redis Lua script (or memory store emulation).
 *
 * Allows controlled bursts up to the bucket capacity, then enforces a steady rate
 * determined by the refill rate. Best for APIs that want burst tolerance.
 */
export async function tokenBucketConsume(
  store: Store,
  key: string,
  config: TokenBucketConfig,
  nowMs: number,
  cost: number = 1,
): Promise<RateLimitResult> {
  const nowSec = nowMs / 1000;

  const result = (await store.eval(
    TOKEN_BUCKET_SCRIPT,
    [key],
    [config.capacity, config.refillRate, nowSec, cost],
  )) as number[];

  const allowed = result[0] === 1;
  const remaining = result[1]!;
  const retryAfterMs = result[2]!;

  // Reset time: time to refill from 0 to capacity
  const resetMs = Math.ceil((config.capacity / config.refillRate) * 1000);

  return {
    allowed,
    limit: config.capacity,
    remaining: Math.max(0, remaining),
    resetMs,
    ...(allowed ? {} : { retryAfterMs }),
  };
}
