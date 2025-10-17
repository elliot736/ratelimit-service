// TODO: add rate limit header configuration
import type { RateLimitResult, RateLimiterConfig, TokenBucketConfig } from '../core/types.js';
import type { RateLimiter } from '../core/limiter.js';
import type { KeyGenerator, KeyGeneratorRequest } from '../keys/key-generator.js';
import type { RateLimitPolicy } from '../policies/policy.js';
import type { TieredPolicy } from '../policies/tiered.js';
import type { CompositePolicy } from '../policies/composite.js';
import { byIp } from '../keys/key-generator.js';

/** Configuration shared across all middleware adapters. */
export interface MiddlewareConfig {
  /** The rate limiter instance. */
  limiter: RateLimiter;
  /** Key generator (default: by IP). */
  keyGenerator?: KeyGenerator;
  /** A named policy to use. */
  policy?: RateLimitPolicy;
  /** A tiered policy for per-tier limits. */
  tieredPolicy?: TieredPolicy;
  /** A composite policy combining multiple limits. */
  compositePolicy?: CompositePolicy;
  /** Callback when a request is rate limited. */
  onRateLimited?: (key: string, result: RateLimitResult) => void;
  /** Skip rate limiting for failed requests (status >= 400). */
  skipFailedRequests?: boolean;
  /** Skip rate limiting for successful requests (status < 400). */
  skipSuccessfulRequests?: boolean;
  /** Custom skip function. Return true to bypass rate limiting. */
  skip?: (req: KeyGeneratorRequest) => boolean;
  /** Attach the result to the request under this property name. */
  requestPropertyName?: string;
}

/**
 * Generate IETF-compliant rate limit headers.
 * Follows draft-ietf-httpapi-ratelimit-headers.
 *
 * @see https://datatracker.ietf.org/doc/draft-ietf-httpapi-ratelimit-headers/
 */
export function generateHeaders(
  result: RateLimitResult,
): Record<string, string> {
  const headers: Record<string, string> = {
    'X-RateLimit-Limit': String(result.limit),
    'X-RateLimit-Remaining': String(result.remaining),
    'X-RateLimit-Reset': String(Math.ceil(result.resetMs / 1000)),
  };

  if (!result.allowed && result.retryAfterMs !== undefined) {
    headers['Retry-After'] = String(Math.ceil(result.retryAfterMs / 1000));
  }

  return headers;
}

/**
 * Format a standard 429 rate limit response.
 */
export function formatRateLimitResponse(result: RateLimitResult): {
  status: 429;
  body: {
    error: string;
    message: string;
    retryAfterMs: number;
  };
  headers: Record<string, string>;
} {
  return {
    status: 429,
    body: {
      error: 'Too Many Requests',
      message: `Rate limit exceeded. Retry after ${Math.ceil((result.retryAfterMs ?? 0) / 1000)} seconds.`,
      retryAfterMs: result.retryAfterMs ?? 0,
    },
    headers: generateHeaders(result),
  };
}

/**
 * Core rate limit check logic, shared across all framework adapters.
 * Returns null if the request should proceed, or a response to send if rate limited.
 */
export async function handleRateLimit(
  config: MiddlewareConfig,
  req: KeyGeneratorRequest,
): Promise<{
  result: RateLimitResult;
  response: ReturnType<typeof formatRateLimitResponse> | null;
  key: string;
}> {
  // Skip check
  if (config.skip?.(req)) {
    return {
      result: { allowed: true, limit: 0, remaining: 0, resetMs: 0 },
      response: null,
      key: '',
    };
  }

  const keyGen = config.keyGenerator ?? byIp;

  // Composite policy: delegate to the composite
  if (config.compositePolicy) {
    const compositeKey = keyGen(req);
    const result = await config.compositePolicy.consume(
      () => config.limiter,
      req,
    );

    if (!result.allowed) {
      config.onRateLimited?.(compositeKey, result);
      return { result, response: formatRateLimitResponse(result), key: compositeKey };
    }

    return { result, response: null, key: compositeKey };
  }

  // Tiered policy: resolve config from tier
  let policyConfig: RateLimiterConfig | TokenBucketConfig | undefined = config.policy?.config;
  let key: string;

  if (config.tieredPolicy) {
    const resolution = config.tieredPolicy.resolve(req);
    policyConfig = resolution.config;
    key = `${resolution.tierName}:${keyGen(req)}`;
  } else if (config.policy) {
    key = `${config.policy.name}:${keyGen(req)}`;
    policyConfig = config.policy.config;
  } else {
    key = keyGen(req);
  }

  if (!policyConfig) {
    throw new Error('No rate limit configuration found. Provide a policy, tieredPolicy, or configure the limiter.');
  }

  const result = await config.limiter.consume(key, policyConfig);

  if (!result.allowed) {
    config.onRateLimited?.(key, result);
    return { result, response: formatRateLimitResponse(result), key };
  }

  return { result, response: null, key };
}
