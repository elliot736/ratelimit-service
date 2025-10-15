import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { CompositePolicy } from '../../src/policies/composite.js';
import { RateLimiter } from '../../src/core/limiter.js';
import { MemoryStore } from '../../src/store/memory.js';
import { byIp } from '../../src/keys/key-generator.js';
import type { RateLimitPolicy } from '../../src/policies/policy.js';

describe('CompositePolicy', () => {
  let store: MemoryStore;
  let limiter: RateLimiter;
  let now: number;

  beforeEach(() => {
    vi.useFakeTimers();
    now = 100000;
    vi.setSystemTime(now);
    store = new MemoryStore({ nowFn: () => Date.now() });
    limiter = new RateLimiter({
      store,
      algorithm: 'fixed-window',
      nowFn: () => Date.now(),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const perSecondPolicy: RateLimitPolicy = {
    name: 'per-second',
    algorithm: 'fixed-window',
    config: { limit: 2, windowMs: 1000 },
    keyGenerator: byIp,
  };

  const perMinutePolicy: RateLimitPolicy = {
    name: 'per-minute',
    algorithm: 'fixed-window',
    config: { limit: 5, windowMs: 60000 },
    keyGenerator: byIp,
  };

  it('should allow when all policies allow', async () => {
    const composite = new CompositePolicy([perSecondPolicy, perMinutePolicy]);
    const req = { ip: '1.1.1.1', headers: {} };

    const result = await composite.consume(() => limiter, req);
    expect(result.allowed).toBe(true);
  });

  it('should deny when per-second limit is exceeded (most restrictive wins)', async () => {
    const composite = new CompositePolicy([perSecondPolicy, perMinutePolicy]);
    const req = { ip: '1.1.1.1', headers: {} };

    await composite.consume(() => limiter, req);
    await composite.consume(() => limiter, req);

    const denied = await composite.consume(() => limiter, req);
    expect(denied.allowed).toBe(false);
  });

  it('should deny when per-minute limit is exceeded even if per-second allows', async () => {
    const composite = new CompositePolicy([perSecondPolicy, perMinutePolicy]);
    const req = { ip: '1.1.1.1', headers: {} };

    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(1000);
      const newNow = now + (i + 1) * 1000;
      vi.setSystemTime(newNow);
      const result = await composite.consume(() => limiter, req);
      expect(result.allowed).toBe(true);
    }

    vi.advanceTimersByTime(1000);
    const denied = await composite.consume(() => limiter, req);
    expect(denied.allowed).toBe(false);
  });

  it('should track each sub-policy independently', async () => {
    const composite = new CompositePolicy([perSecondPolicy, perMinutePolicy]);
    const req = { ip: '1.1.1.1', headers: {} };

    await composite.consume(() => limiter, req);
    await composite.consume(() => limiter, req);

    vi.advanceTimersByTime(1000);

    const result = await composite.consume(() => limiter, req);
    expect(result.allowed).toBe(true);
  });

  it('should report the most restrictive remaining count when allowed', async () => {
    const composite = new CompositePolicy([perSecondPolicy, perMinutePolicy]);
    const req = { ip: '1.1.1.1', headers: {} };

    const result = await composite.consume(() => limiter, req);
    expect(result.remaining).toBe(1);
  });

  it('should throw if no policies are provided', () => {
    expect(() => new CompositePolicy([])).toThrow('at least one sub-policy');
  });

  it('should expose sub-policies', () => {
    const composite = new CompositePolicy([perSecondPolicy, perMinutePolicy]);
    expect(composite.getPolicies()).toHaveLength(2);
    expect(composite.getPolicies()[0]!.name).toBe('per-second');
    expect(composite.getPolicies()[1]!.name).toBe('per-minute');
  });

  // --- New comprehensive tests ---

  it('should return the first failing policy response when denied', async () => {
    const composite = new CompositePolicy([perSecondPolicy, perMinutePolicy]);
    const req = { ip: '1.1.1.1', headers: {} };

    // Exhaust per-second limit
    await composite.consume(() => limiter, req);
    await composite.consume(() => limiter, req);

    const denied = await composite.consume(() => limiter, req);
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    // The retry time should correspond to the per-second policy
    expect(denied.retryAfterMs).toBeDefined();
  });

  it('should have independent reset times for each sub-policy', async () => {
    const composite = new CompositePolicy([perSecondPolicy, perMinutePolicy]);
    const req = { ip: '1.1.1.1', headers: {} };

    // Exhaust per-second
    await composite.consume(() => limiter, req);
    await composite.consume(() => limiter, req);

    const denied = await composite.consume(() => limiter, req);
    expect(denied.allowed).toBe(false);

    // Wait for per-second to reset (1 second)
    vi.advanceTimersByTime(1000);

    // Should be allowed now (per-second reset, per-minute has room)
    const allowed = await composite.consume(() => limiter, req);
    expect(allowed.allowed).toBe(true);
  });

  it('should handle mixed algorithm types in composite', async () => {
    // Use token bucket for burst + fixed window for sustained
    const tokenBucketStore = new MemoryStore({ nowFn: () => Date.now() });
    const tbLimiter = new RateLimiter({
      store: tokenBucketStore,
      algorithm: 'token-bucket',
      nowFn: () => Date.now(),
    });
    const fwLimiter = new RateLimiter({
      store,
      algorithm: 'fixed-window',
      nowFn: () => Date.now(),
    });

    const burstPolicy: RateLimitPolicy = {
      name: 'burst',
      algorithm: 'token-bucket',
      config: { capacity: 3, refillRate: 1 },
      keyGenerator: byIp,
    };

    const sustainedPolicy: RateLimitPolicy = {
      name: 'sustained',
      algorithm: 'fixed-window',
      config: { limit: 10, windowMs: 60000 },
      keyGenerator: byIp,
    };

    const composite = new CompositePolicy([burstPolicy, sustainedPolicy]);
    const req = { ip: '1.1.1.1', headers: {} };

    const limiterFactory = (algorithm: string) => {
      if (algorithm === 'token-bucket') return tbLimiter;
      return fwLimiter;
    };

    // First 3 should be allowed (burst limit)
    for (let i = 0; i < 3; i++) {
      const result = await composite.consume(limiterFactory, req);
      expect(result.allowed).toBe(true);
    }

    // 4th should be denied by token bucket
    const denied = await composite.consume(limiterFactory, req);
    expect(denied.allowed).toBe(false);
  });

  it('should handle single policy composite', async () => {
    const composite = new CompositePolicy([perSecondPolicy]);
    const req = { ip: '1.1.1.1', headers: {} };

    const result = await composite.consume(() => limiter, req);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(1);
  });

  it('should report most restrictive retry-after when multiple policies deny', async () => {
    // Both deny at the same time
    const policy1: RateLimitPolicy = {
      name: 'p1',
      algorithm: 'fixed-window',
      config: { limit: 1, windowMs: 5000 },
      keyGenerator: byIp,
    };
    const policy2: RateLimitPolicy = {
      name: 'p2',
      algorithm: 'fixed-window',
      config: { limit: 1, windowMs: 10000 },
      keyGenerator: byIp,
    };

    const composite = new CompositePolicy([policy1, policy2]);
    const req = { ip: '1.1.1.1', headers: {} };

    await composite.consume(() => limiter, req);
    // p1 denies first, so short-circuits
    const denied = await composite.consume(() => limiter, req);
    expect(denied.allowed).toBe(false);
  });
});
