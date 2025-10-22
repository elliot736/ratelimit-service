// TODO: add convenience re-exports
// Core
export { RateLimiter } from './core/limiter.js';
export type {
  RateLimitResult,
  RateLimiterConfig,
  TokenBucketConfig,
  AlgorithmType,
} from './core/types.js';
export { isTokenBucketConfig, isRateLimiterConfig } from './core/types.js';

// Store
export type { Store } from './store/store.js';
export { MemoryStore } from './store/memory.js';
export { RedisStore } from './store/redis.js';
export type { RedisStoreOptions } from './store/redis.js';

// Key Generators
export {
  byIp,
  byUserId,
  byApiKey,
  byHeader,
  composite as compositeKey,
  custom as customKey,
} from './keys/key-generator.js';
export type { KeyGenerator, KeyGeneratorRequest } from './keys/key-generator.js';

// Policies
export type { RateLimitPolicy } from './policies/policy.js';
export { createPolicy } from './policies/policy.js';
export { TieredPolicy } from './policies/tiered.js';
export { CompositePolicy } from './policies/composite.js';

// Middleware
export { expressRateLimit } from './middleware/express.js';
export { fastifyRateLimit } from './middleware/fastify.js';
export { honoRateLimit } from './middleware/hono.js';
export { generateHeaders, formatRateLimitResponse } from './middleware/shared.js';
export type { MiddlewareConfig } from './middleware/shared.js';

// Errors
export {
  RateLimitExceededError,
  StoreConnectionError,
  InvalidConfigError,
} from './errors.js';
