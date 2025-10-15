import type { AlgorithmType, RateLimiterConfig, TokenBucketConfig } from '../core/types.js';
import type { KeyGenerator } from '../keys/key-generator.js';

/**
 * A named, reusable rate limit configuration.
 * Policies encapsulate the algorithm, configuration, and key generation strategy
 * into a single unit that can be referenced by middleware.
 */
export interface RateLimitPolicy {
  /** Descriptive name for this policy (used in key namespacing). */
  name: string;
  /** Which algorithm to use. */
  algorithm: AlgorithmType;
  /** Algorithm-specific configuration. */
  config: RateLimiterConfig | TokenBucketConfig;
  /** How to extract the rate limit key from the request. */
  keyGenerator: KeyGenerator;
}

/** Helper to create a policy with validation. */
export function createPolicy(policy: RateLimitPolicy): RateLimitPolicy {
  if (!policy.name) {
    throw new Error('Policy must have a name');
  }
  return { ...policy };
}
