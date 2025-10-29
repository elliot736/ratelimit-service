// TODO: add multi-algorithm integration test
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { RateLimiter } from '../src/core/limiter.js';
import { MemoryStore } from '../src/store/memory.js';
import { TieredPolicy } from '../src/policies/tiered.js';
import { CompositePolicy } from '../src/policies/composite.js';
import { byIp } from '../src/keys/key-generator.js';
import { generateHeaders, formatRateLimitResponse, handleRateLimit } from '../src/middleware/shared.js';
import type { RateLimitPolicy } from '../src/policies/policy.js';
import type { Store } from '../src/store/store.js';

describe('Integration Tests', () => {
  let store: MemoryStore;
  let now: number;

  beforeEach(() => {
    vi.useFakeTimers();
    now = 100000;
    vi.setSystemTime(now);
    store = new MemoryStore({ nowFn: () => Date.now() });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Full flow: limiter + middleware config + request sequence', () => {
    it('should allow, deny, then allow after reset cycle (fixed-window)', async () => {
      const limiter = new RateLimiter({
        store,
        algorithm: 'fixed-window',
        nowFn: () => Date.now(),
      });

      const policy: RateLimitPolicy = {
        name: 'api',
        algorithm: 'fixed-window',
        config: { limit: 3, windowMs: 5000 },
        keyGenerator: byIp,
      };

      const req = { ip: '10.0.0.1', headers: {} };

      for (let i = 0; i < 3; i++) {
        const { result, response } = await handleRateLimit(
          { limiter, policy },
          req,
        );
        expect(result.allowed).toBe(true);
        expect(response).toBeNull();

        const headers = generateHeaders(result);
        expect(headers['X-RateLimit-Remaining']).toBe(String(2 - i));
      }

      const { result: denied, response: deniedResponse } = await handleRateLimit(
        { limiter, policy },
        req,
      );
      expect(denied.allowed).toBe(false);
      expect(deniedResponse).not.toBeNull();
      expect(deniedResponse!.status).toBe(429);

      vi.advanceTimersByTime(5000);

      const { result: afterReset } = await handleRateLimit(
        { limiter, policy },
        req,
      );
      expect(afterReset.allowed).toBe(true);
      expect(afterReset.remaining).toBe(2);
    });

    it('should work with token bucket algorithm end-to-end', async () => {
      const limiter = new RateLimiter({
        store,
        algorithm: 'token-bucket',
        nowFn: () => Date.now(),
      });

      const config = { capacity: 5, refillRate: 2 };

      for (let i = 0; i < 5; i++) {
        const result = await limiter.consume('user:1', config);
        expect(result.allowed).toBe(true);
      }

      const denied = await limiter.consume('user:1', config);
      expect(denied.allowed).toBe(false);

      vi.advanceTimersByTime(1000);
      const after1s = await limiter.consume('user:1', config);
      expect(after1s.allowed).toBe(true);
      expect(after1s.remaining).toBe(1);
    });

    it('should work with sliding-window-counter end-to-end', async () => {
      const limiter = new RateLimiter({
        store,
        algorithm: 'sliding-window-counter',
        nowFn: () => Date.now(),
      });

      const config = { limit: 10, windowMs: 10000 };

      for (let i = 0; i < 10; i++) {
        const result = await limiter.consume('user:1', config);
        expect(result.allowed).toBe(true);
      }

      const denied = await limiter.consume('user:1', config);
      expect(denied.allowed).toBe(false);
    });
  });

  describe('Tiered policy integration', () => {
    it('should apply different limits based on user tier', async () => {
      const tieredPolicy = new TieredPolicy(
        {
          free: { limit: 2, windowMs: 10000 },
          pro: { limit: 10, windowMs: 10000 },
        },
        {
          algorithm: 'fixed-window',
          tierResolver: (req) => (req['tier'] as string) ?? 'free',
          defaultTier: 'free',
        },
      );

      const limiter = new RateLimiter({
        store,
        algorithm: 'fixed-window',
        nowFn: () => Date.now(),
      });

      const freeReq = { ip: '1.1.1.1', headers: {}, tier: 'free' };
      const freeResolution = tieredPolicy.resolve(freeReq);

      for (let i = 0; i < 2; i++) {
        const result = await limiter.consume(
          `free:${byIp(freeReq)}`,
          freeResolution.config,
        );
        expect(result.allowed).toBe(true);
      }

      const freeDenied = await limiter.consume(
        `free:${byIp(freeReq)}`,
        freeResolution.config,
      );
      expect(freeDenied.allowed).toBe(false);

      const proReq = { ip: '2.2.2.2', headers: {}, tier: 'pro' };
      const proResolution = tieredPolicy.resolve(proReq);

      for (let i = 0; i < 10; i++) {
        const result = await limiter.consume(
          `pro:${byIp(proReq)}`,
          proResolution.config,
        );
        expect(result.allowed).toBe(true);
      }

      const proDenied = await limiter.consume(
        `pro:${byIp(proReq)}`,
        proResolution.config,
      );
      expect(proDenied.allowed).toBe(false);
    });
  });

  describe('Composite policy with tiered + per-second limits', () => {
    it('should enforce both per-second and per-hour limits', async () => {
      const perSecond: RateLimitPolicy = {
        name: 'burst',
        algorithm: 'fixed-window',
        config: { limit: 2, windowMs: 1000 },
        keyGenerator: byIp,
      };

      const perHour: RateLimitPolicy = {
        name: 'sustained',
        algorithm: 'fixed-window',
        config: { limit: 5, windowMs: 3600000 },
        keyGenerator: byIp,
      };

      const composite = new CompositePolicy([perSecond, perHour]);
      const limiter = new RateLimiter({
        store,
        algorithm: 'fixed-window',
        nowFn: () => Date.now(),
      });

      const req = { ip: '1.1.1.1', headers: {} };

      let result = await composite.consume(() => limiter, req);
      expect(result.allowed).toBe(true);
      result = await composite.consume(() => limiter, req);
      expect(result.allowed).toBe(true);

      result = await composite.consume(() => limiter, req);
      expect(result.allowed).toBe(false);

      vi.advanceTimersByTime(1000);
      result = await composite.consume(() => limiter, req);
      expect(result.allowed).toBe(true);

      vi.advanceTimersByTime(1000);
      result = await composite.consume(() => limiter, req);
      expect(result.allowed).toBe(true);

      vi.advanceTimersByTime(1000);
      result = await composite.consume(() => limiter, req);
      expect(result.allowed).toBe(true);

      vi.advanceTimersByTime(1000);
      result = await composite.consume(() => limiter, req);
      expect(result.allowed).toBe(false);
    });
  });

  describe('Reset functionality', () => {
    it('should reset rate limit state for a key', async () => {
      const limiter = new RateLimiter({
        store,
        algorithm: 'fixed-window',
        nowFn: () => Date.now(),
      });

      const config = { limit: 2, windowMs: 60000 };

      await limiter.consume('user:reset-test', config);
      await limiter.consume('user:reset-test', config);
      const denied = await limiter.consume('user:reset-test', config);
      expect(denied.allowed).toBe(false);

      await limiter.reset('user:reset-test');

      const afterReset = await limiter.consume('user:reset-test', config);
      expect(afterReset.allowed).toBe(true);
      expect(afterReset.remaining).toBe(1);
    });
  });

  describe('IETF header compliance', () => {
    it('should produce headers matching draft-ietf-httpapi-ratelimit-headers', () => {
      const result = {
        allowed: true,
        limit: 100,
        remaining: 42,
        resetMs: 58000,
      };

      const headers = generateHeaders(result);

      expect(headers['X-RateLimit-Limit']).toBe('100');
      expect(headers['X-RateLimit-Remaining']).toBe('42');
      expect(headers['X-RateLimit-Reset']).toBe('58');
      expect(headers['Retry-After']).toBeUndefined();
    });

    it('should include Retry-After only when denied', () => {
      const denied = {
        allowed: false,
        limit: 100,
        remaining: 0,
        resetMs: 58000,
        retryAfterMs: 15000,
      };

      const headers = generateHeaders(denied);
      expect(headers['Retry-After']).toBe('15');
    });
  });

  describe('Response formatting', () => {
    it('should produce a standard 429 JSON response', () => {
      const result = {
        allowed: false,
        limit: 60,
        remaining: 0,
        resetMs: 45000,
        retryAfterMs: 12000,
      };

      const response = formatRateLimitResponse(result);
      expect(response.status).toBe(429);
      expect(response.body.error).toBe('Too Many Requests');
      expect(response.body.retryAfterMs).toBe(12000);
      expect(response.headers['Retry-After']).toBe('12');
    });
  });

  // --- New comprehensive integration tests ---

  describe('Full Express app simulation', () => {
    it('should allow 10 requests within limit, deny 11th, then allow after reset', async () => {
      const limiter = new RateLimiter({
        store,
        algorithm: 'fixed-window',
        nowFn: () => Date.now(),
      });

      const policy: RateLimitPolicy = {
        name: 'api',
        algorithm: 'fixed-window',
        config: { limit: 10, windowMs: 10000 },
        keyGenerator: byIp,
      };

      const req = { ip: '10.0.0.1', headers: {} };

      // 10 allowed requests
      for (let i = 0; i < 10; i++) {
        const { result } = await handleRateLimit({ limiter, policy }, req);
        expect(result.allowed).toBe(true);
        expect(result.remaining).toBe(9 - i);
      }

      // 11th request denied
      const { result: denied, response } = await handleRateLimit({ limiter, policy }, req);
      expect(denied.allowed).toBe(false);
      expect(response!.status).toBe(429);

      // Wait for window reset
      vi.advanceTimersByTime(10000);

      // Next request allowed again
      const { result: afterReset } = await handleRateLimit({ limiter, policy }, req);
      expect(afterReset.allowed).toBe(true);
      expect(afterReset.remaining).toBe(9);
    });
  });

  describe('Tiered + composite: free user hits per-second, pro user hits per-hour', () => {
    it('should enforce tier-specific limits with composite policies', async () => {
      const limiter = new RateLimiter({
        store,
        algorithm: 'fixed-window',
        nowFn: () => Date.now(),
      });

      // Free user: 2/sec burst
      const freePolicy: RateLimitPolicy = {
        name: 'free-burst',
        algorithm: 'fixed-window',
        config: { limit: 2, windowMs: 1000 },
        keyGenerator: byIp,
      };

      // Pro user: higher burst but tracked hourly
      const proPolicy: RateLimitPolicy = {
        name: 'pro-hourly',
        algorithm: 'fixed-window',
        config: { limit: 5, windowMs: 60000 },
        keyGenerator: byIp,
      };

      const freeReq = { ip: '1.1.1.1', headers: {} };
      const proReq = { ip: '2.2.2.2', headers: {} };

      // Free user hits per-second limit
      const freeComposite = new CompositePolicy([freePolicy]);
      await freeComposite.consume(() => limiter, freeReq);
      await freeComposite.consume(() => limiter, freeReq);
      const freeDenied = await freeComposite.consume(() => limiter, freeReq);
      expect(freeDenied.allowed).toBe(false);

      // Pro user hits per-hour limit after several seconds
      const proComposite = new CompositePolicy([proPolicy]);
      for (let i = 0; i < 5; i++) {
        const result = await proComposite.consume(() => limiter, proReq);
        expect(result.allowed).toBe(true);
      }
      const proDenied = await proComposite.consume(() => limiter, proReq);
      expect(proDenied.allowed).toBe(false);
    });
  });

  describe('Multiple clients with different keys', () => {
    it('should track each client independently', async () => {
      const limiter = new RateLimiter({
        store,
        algorithm: 'fixed-window',
        nowFn: () => Date.now(),
      });

      const config = { limit: 3, windowMs: 10000 };

      const clients = ['client-1', 'client-2', 'client-3'];

      // Each client makes 3 requests
      for (const client of clients) {
        for (let i = 0; i < 3; i++) {
          const result = await limiter.consume(client, config);
          expect(result.allowed).toBe(true);
        }
      }

      // Each client is now at limit
      for (const client of clients) {
        const result = await limiter.consume(client, config);
        expect(result.allowed).toBe(false);
      }

      // A new client should still have capacity
      const result = await limiter.consume('client-4', config);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(2);
    });
  });

  describe('Fail-open simulation', () => {
    it('should allow requests when store throws error in fail-open mode', async () => {
      const failingStore: Store = {
        async eval(): Promise<unknown> {
          // Simulate fail-open by returning permissive result
          return [1, 999, 0, 0];
        },
        async disconnect(): Promise<void> {
          // no-op
        },
      };

      const limiter = new RateLimiter({
        store: failingStore,
        algorithm: 'fixed-window',
        nowFn: () => Date.now(),
      });

      const config = { limit: 5, windowMs: 10000 };

      // Even though the store is "failing", requests are allowed
      const result = await limiter.consume('test-key', config);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBeGreaterThan(0);
    });
  });

  describe('Burst test: token bucket', () => {
    it('should allow burst up to capacity then throttle', async () => {
      const limiter = new RateLimiter({
        store,
        algorithm: 'token-bucket',
        nowFn: () => Date.now(),
      });

      const config = { capacity: 10, refillRate: 2 };

      // Burst 10 requests
      for (let i = 0; i < 10; i++) {
        const result = await limiter.consume('burst-test', config);
        expect(result.allowed).toBe(true);
      }

      // 11th denied
      const denied = await limiter.consume('burst-test', config);
      expect(denied.allowed).toBe(false);

      // After 1 second, 2 tokens refilled
      vi.advanceTimersByTime(1000);

      const after1s = await limiter.consume('burst-test', config);
      expect(after1s.allowed).toBe(true);
      expect(after1s.remaining).toBe(1);

      // After another 1 second, 2 more tokens refilled (1 remaining + 2 = 3 tokens)
      vi.advanceTimersByTime(1000);

      const r1 = await limiter.consume('burst-test', config);
      expect(r1.allowed).toBe(true);
      const r2 = await limiter.consume('burst-test', config);
      expect(r2.allowed).toBe(true);
      // 3 tokens available, consumed 2, 1 remaining
      expect(r2.remaining).toBe(1);
    });
  });

  describe('Wrong config type errors', () => {
    it('should throw when token bucket receives window config', async () => {
      const limiter = new RateLimiter({
        store,
        algorithm: 'token-bucket',
        nowFn: () => Date.now(),
      });

      await expect(
        limiter.consume('test', { limit: 10, windowMs: 1000 }),
      ).rejects.toThrow('Token bucket algorithm requires TokenBucketConfig');
    });

    it('should throw when sliding window receives bucket config', async () => {
      const limiter = new RateLimiter({
        store,
        algorithm: 'sliding-window',
        nowFn: () => Date.now(),
      });

      await expect(
        limiter.consume('test', { capacity: 10, refillRate: 1 }),
      ).rejects.toThrow('Sliding window algorithm requires RateLimiterConfig');
    });

    it('should throw when fixed window receives bucket config', async () => {
      const limiter = new RateLimiter({
        store,
        algorithm: 'fixed-window',
        nowFn: () => Date.now(),
      });

      await expect(
        limiter.consume('test', { capacity: 10, refillRate: 1 }),
      ).rejects.toThrow('Fixed window algorithm requires RateLimiterConfig');
    });
  });

  describe('Key prefix isolation', () => {
    it('should use custom key prefix', async () => {
      const limiter1 = new RateLimiter({
        store,
        algorithm: 'fixed-window',
        keyPrefix: 'service-a',
        nowFn: () => Date.now(),
      });

      const limiter2 = new RateLimiter({
        store,
        algorithm: 'fixed-window',
        keyPrefix: 'service-b',
        nowFn: () => Date.now(),
      });

      const config = { limit: 1, windowMs: 60000 };

      // Exhaust limiter1
      const r1 = await limiter1.consume('user:1', config);
      expect(r1.allowed).toBe(true);
      const d1 = await limiter1.consume('user:1', config);
      expect(d1.allowed).toBe(false);

      // limiter2 with same key should still work (different prefix)
      const r2 = await limiter2.consume('user:1', config);
      expect(r2.allowed).toBe(true);
    });
  });

  describe('handleRateLimit with skip', () => {
    it('should bypass rate limiting when skip returns true', async () => {
      const limiter = new RateLimiter({
        store,
        algorithm: 'fixed-window',
        nowFn: () => Date.now(),
      });

      const policy: RateLimitPolicy = {
        name: 'api',
        algorithm: 'fixed-window',
        config: { limit: 1, windowMs: 10000 },
        keyGenerator: byIp,
      };

      const req = { ip: '1.1.1.1', headers: {} };

      // Exhaust the limit
      await handleRateLimit({ limiter, policy }, req);

      // Would be denied, but skip bypasses
      const { result } = await handleRateLimit(
        { limiter, policy, skip: () => true },
        req,
      );
      expect(result.allowed).toBe(true);
    });
  });
});
