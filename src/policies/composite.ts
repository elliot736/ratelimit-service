// TODO: add short-circuit evaluation
import type { RateLimitResult } from '../core/types.js';
import type { RateLimitPolicy } from './policy.js';
import type { RateLimiter } from '../core/limiter.js';
import type { KeyGeneratorRequest } from '../keys/key-generator.js';

/**
 * A composite policy that combines multiple rate limit policies.
 * ALL sub-policies must allow a request for it to pass.
 * If any sub-policy denies, the request is denied.
 *
 * Example: 10 req/sec AND 1000 req/hour — both limits are enforced independently.
 */
export class CompositePolicy {
  private readonly policies: RateLimitPolicy[];

  constructor(policies: RateLimitPolicy[]) {
    if (policies.length === 0) {
      throw new Error('CompositePolicy requires at least one sub-policy');
    }
    this.policies = [...policies];
  }

  /**
   * Consume from all sub-policies. All must allow for the request to pass.
   * Returns the most restrictive result (lowest remaining, shortest retry).
   *
   * @param limiterFactory — function that returns a RateLimiter for a given algorithm
   * @param req — the incoming request (used for key generation)
   */
  async consume(
    limiterFactory: (algorithm: string) => RateLimiter,
    req: KeyGeneratorRequest,
  ): Promise<RateLimitResult> {
    const results: RateLimitResult[] = [];

    for (const policy of this.policies) {
      const limiter = limiterFactory(policy.algorithm);
      const key = `${policy.name}:${policy.keyGenerator(req)}`;
      const result = await limiter.consume(key, policy.config);
      results.push(result);

      // If any policy denies, short-circuit
      if (!result.allowed) {
        return this.mergeResults(results);
      }
    }

    return this.mergeResults(results);
  }

  /** Get the sub-policies. */
  getPolicies(): readonly RateLimitPolicy[] {
    return this.policies;
  }

  /**
   * Merge results from multiple policies.
   * If any denied: return denied with the most restrictive retry time.
   * If all allowed: return allowed with the lowest remaining count.
   */
  private mergeResults(results: RateLimitResult[]): RateLimitResult {
    const denied = results.filter((r) => !r.allowed);

    if (denied.length > 0) {
      // Return the most restrictive denial
      const mostRestrictive = denied.reduce((a, b) =>
        (a.retryAfterMs ?? 0) > (b.retryAfterMs ?? 0) ? a : b,
      );
      return {
        allowed: false,
        limit: mostRestrictive.limit,
        remaining: 0,
        resetMs: mostRestrictive.resetMs,
        retryAfterMs: mostRestrictive.retryAfterMs,
      };
    }

    // All allowed — return the most restrictive (lowest remaining)
    const mostRestrictive = results.reduce((a, b) =>
      a.remaining < b.remaining ? a : b,
    );
    return {
      allowed: true,
      limit: mostRestrictive.limit,
      remaining: mostRestrictive.remaining,
      resetMs: mostRestrictive.resetMs,
    };
  }
}
