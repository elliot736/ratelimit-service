import type { AlgorithmType, RateLimiterConfig } from '../core/types.js';
import type { KeyGeneratorRequest } from '../keys/key-generator.js';

export interface TieredPolicyOptions {
  /** Which algorithm to use for all tiers. */
  algorithm: AlgorithmType;
  /** Function to extract the tier name from a request (e.g., from JWT claims). */
  tierResolver: (req: KeyGeneratorRequest) => string;
  /** Tier to use when the resolver returns an unknown tier name. */
  defaultTier: string;
}

export interface TieredResolution {
  config: RateLimiterConfig;
  tierName: string;
}

/**
 * A policy that applies different rate limits based on the user's tier.
 *
 * Example tiers: free (100 req/hr), pro (1000 req/hr), enterprise (10000 req/hr).
 * The tier is resolved per-request via a user-provided function.
 */
export class TieredPolicy {
  private readonly tiers: Record<string, RateLimiterConfig>;
  private readonly algorithm: AlgorithmType;
  private readonly tierResolver: (req: KeyGeneratorRequest) => string;
  private readonly defaultTier: string;

  constructor(
    tiers: Record<string, RateLimiterConfig>,
    options: TieredPolicyOptions,
  ) {
    this.tiers = { ...tiers };
    this.algorithm = options.algorithm;
    this.tierResolver = options.tierResolver;
    this.defaultTier = options.defaultTier;

    if (!(this.defaultTier in this.tiers)) {
      throw new Error(
        `Default tier "${this.defaultTier}" is not defined in the tiers configuration`,
      );
    }
  }

  /** Resolve the rate limit configuration and tier name for a given request. */
  resolve(req: KeyGeneratorRequest): TieredResolution {
    const tierName = this.tierResolver(req);
    const config = this.tiers[tierName] ?? this.tiers[this.defaultTier];

    if (!config) {
      throw new Error(`No configuration found for tier "${tierName}" or default tier`);
    }

    return {
      config,
      tierName: tierName in this.tiers ? tierName : this.defaultTier,
    };
  }

  /** Get the algorithm type for this tiered policy. */
  getAlgorithm(): AlgorithmType {
    return this.algorithm;
  }

  /** Get the tier names defined in this policy. */
  getTierNames(): string[] {
    return Object.keys(this.tiers);
  }
}
