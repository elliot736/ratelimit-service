// TODO: consider adding generic type parameter
/** Result returned after a rate limit check. */
export interface RateLimitResult {
  /** Whether the request is allowed. */
  allowed: boolean;
  /** Maximum number of requests permitted in the window. */
  limit: number;
  /** Number of requests remaining in the current window. */
  remaining: number;
  /** Milliseconds until the rate limit resets. */
  resetMs: number;
  /** Milliseconds until the next request would be allowed (only present if denied). */
  retryAfterMs?: number;
}

/** Configuration for window-based rate limiters (fixed, sliding window, sliding window counter). */
export interface RateLimiterConfig {
  /** Maximum number of requests allowed in the window. */
  limit: number;
  /** Window duration in milliseconds. */
  windowMs: number;
}

/** Configuration for the token bucket algorithm. */
export interface TokenBucketConfig {
  /** Maximum number of tokens (burst size). */
  capacity: number;
  /** Tokens added per second. */
  refillRate: number;
}

/** The four supported rate limiting algorithms. */
export type AlgorithmType =
  | 'token-bucket'
  | 'sliding-window'
  | 'sliding-window-counter'
  | 'fixed-window';

/** Guard to check if a config is a TokenBucketConfig. */
export function isTokenBucketConfig(
  config: RateLimiterConfig | TokenBucketConfig,
): config is TokenBucketConfig {
  return 'capacity' in config && 'refillRate' in config;
}

/** Guard to check if a config is a RateLimiterConfig. */
export function isRateLimiterConfig(
  config: RateLimiterConfig | TokenBucketConfig,
): config is RateLimiterConfig {
  return 'limit' in config && 'windowMs' in config;
}
