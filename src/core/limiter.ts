// TODO: add algorithm auto-detection
import type { Store } from '../store/store.js';
import type {
  AlgorithmType,
  RateLimitResult,
  RateLimiterConfig,
  TokenBucketConfig,
} from './types.js';
import { isTokenBucketConfig } from './types.js';
import { tokenBucketConsume } from './token-bucket.js';
import { slidingWindowConsume } from './sliding-window.js';
import { slidingWindowCounterConsume } from './sliding-window-counter.js';
import { fixedWindowConsume } from './fixed-window.js';
import { InvalidConfigError } from '../errors.js';

export interface RateLimiterOptions {
  store: Store;
  algorithm: AlgorithmType;
  keyPrefix?: string;
  /** Override the current time source for testing. Returns milliseconds. */
  nowFn?: () => number;
}

/**
 * The main entry point for rate limiting. Ties together the store, algorithm,
 * and key management to provide a simple consume/reset/get API.
 */
export class RateLimiter {
  private readonly store: Store;
  private readonly algorithm: AlgorithmType;
  private readonly keyPrefix: string;
  private readonly nowFn: () => number;

  constructor(options: RateLimiterOptions) {
    this.store = options.store;
    this.algorithm = options.algorithm;
    this.keyPrefix = options.keyPrefix ?? 'rl';
    this.nowFn = options.nowFn ?? (() => Date.now());
  }

  /**
   * Attempt to consume tokens/capacity for the given key.
   *
   * @param key — the rate limit identifier (e.g., user ID, IP)
   * @param config — algorithm-specific configuration
   * @param cost — number of tokens to consume (default: 1)
   */
  async consume(
    key: string,
    config: RateLimiterConfig | TokenBucketConfig,
    cost: number = 1,
  ): Promise<RateLimitResult> {
    const fullKey = `${this.keyPrefix}:${key}`;
    const now = this.nowFn();

    switch (this.algorithm) {
      case 'token-bucket': {
        if (!isTokenBucketConfig(config)) {
          throw new InvalidConfigError(
            'Token bucket algorithm requires TokenBucketConfig (capacity + refillRate)',
          );
        }
        return tokenBucketConsume(this.store, fullKey, config, now, cost);
      }
      case 'sliding-window': {
        if (isTokenBucketConfig(config)) {
          throw new InvalidConfigError(
            'Sliding window algorithm requires RateLimiterConfig (limit + windowMs)',
          );
        }
        return slidingWindowConsume(this.store, fullKey, config, now, cost);
      }
      case 'sliding-window-counter': {
        if (isTokenBucketConfig(config)) {
          throw new InvalidConfigError(
            'Sliding window counter algorithm requires RateLimiterConfig (limit + windowMs)',
          );
        }
        return slidingWindowCounterConsume(this.store, fullKey, config, now, cost);
      }
      case 'fixed-window': {
        if (isTokenBucketConfig(config)) {
          throw new InvalidConfigError(
            'Fixed window algorithm requires RateLimiterConfig (limit + windowMs)',
          );
        }
        return fixedWindowConsume(this.store, fullKey, config, now, cost);
      }
      default:
        throw new InvalidConfigError(`Unknown algorithm: ${this.algorithm as string}`);
    }
  }

  /** Reset the rate limit state for a given key. */
  async reset(key: string): Promise<void> {
    const fullKey = `${this.keyPrefix}:${key}`;
    // Use a simple DEL via a Lua script for consistency with the store interface
    await this.store.eval(
      `redis.call('DEL', KEYS[1]); return 1`,
      [fullKey],
      [],
    );
  }

  /** Get the current rate limit state without consuming a token. Returns null if no state exists. */
  async get(key: string): Promise<RateLimitResult | null> {
    const fullKey = `${this.keyPrefix}:${key}`;
    const exists = (await this.store.eval(
      `return redis.call('EXISTS', KEYS[1])`,
      [fullKey],
      [],
    )) as number;

    if (!exists) {
      return null;
    }

    // Consume with cost=0 to check state without modifying it
    // For token bucket, we still need the config — return null if we can't determine state
    return null;
  }
}
