import type { RateLimitResult } from './core/types.js';

/** Thrown when a request exceeds the rate limit. */
export class RateLimitExceededError extends Error {
  public readonly result: RateLimitResult;

  constructor(result: RateLimitResult) {
    super(
      `Rate limit exceeded. Retry after ${result.retryAfterMs ?? 0}ms.`,
    );
    this.name = 'RateLimitExceededError';
    this.result = result;
  }
}

/** Thrown when the backing store (Redis) connection fails. */
export class StoreConnectionError extends Error {
  constructor(message: string, public readonly cause?: Error) {
    super(message);
    this.name = 'StoreConnectionError';
  }
}

/** Thrown when an invalid configuration is provided. */
export class InvalidConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidConfigError';
  }
}
