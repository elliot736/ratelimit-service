import { describe, it, expect, vi } from 'vitest';
import { TieredPolicy } from '../../src/policies/tiered.js';
import { RateLimiter } from '../../src/core/limiter.js';
import { MemoryStore } from '../../src/store/memory.js';
import { byIp } from '../../src/keys/key-generator.js';
import type { KeyGeneratorRequest } from '../../src/keys/key-generator.js';

describe('TieredPolicy', () => {
  const tiers = {
    free: { limit: 100, windowMs: 3600000 },
    pro: { limit: 1000, windowMs: 3600000 },
    enterprise: { limit: 10000, windowMs: 3600000 },
  };

  const policy = new TieredPolicy(tiers, {
    algorithm: 'sliding-window-counter',
    tierResolver: (req) => (req['tier'] as string) ?? 'free',
    defaultTier: 'free',
  });

  it('should resolve the correct tier configuration', () => {
    const req: KeyGeneratorRequest = {
      headers: {},
      tier: 'pro',
    };

    const result = policy.resolve(req);
    expect(result.tierName).toBe('pro');
    expect(result.config.limit).toBe(1000);
    expect(result.config.windowMs).toBe(3600000);
  });

  it('should fall back to default tier for unknown tiers', () => {
    const req: KeyGeneratorRequest = {
      headers: {},
      tier: 'platinum',
    };

    const result = policy.resolve(req);
    expect(result.tierName).toBe('free');
    expect(result.config.limit).toBe(100);
  });

  it('should fall back to default tier when resolver returns undefined', () => {
    const req: KeyGeneratorRequest = {
      headers: {},
    };

    const result = policy.resolve(req);
    expect(result.tierName).toBe('free');
    expect(result.config.limit).toBe(100);
  });

  it('should resolve enterprise tier', () => {
    const req: KeyGeneratorRequest = {
      headers: {},
      tier: 'enterprise',
    };

    const result = policy.resolve(req);
    expect(result.tierName).toBe('enterprise');
    expect(result.config.limit).toBe(10000);
  });

  it('should report available tier names', () => {
    expect(policy.getTierNames()).toEqual(['free', 'pro', 'enterprise']);
  });

  it('should report the algorithm', () => {
    expect(policy.getAlgorithm()).toBe('sliding-window-counter');
  });

  it('should throw if default tier is not in tiers', () => {
    expect(
      () =>
        new TieredPolicy(tiers, {
          algorithm: 'fixed-window',
          tierResolver: () => 'free',
          defaultTier: 'nonexistent',
        }),
    ).toThrow('Default tier "nonexistent" is not defined');
  });

  // --- New comprehensive tests ---

  it('should resolve tier from request dynamically', () => {
    const dynamicPolicy = new TieredPolicy(tiers, {
      algorithm: 'fixed-window',
      tierResolver: (req) => {
        const auth = req.headers['authorization'];
        if (auth === 'Bearer enterprise-token') return 'enterprise';
        if (auth === 'Bearer pro-token') return 'pro';
        return 'free';
      },
      defaultTier: 'free',
    });

    const enterpriseReq: KeyGeneratorRequest = {
      headers: { authorization: 'Bearer enterprise-token' },
    };
    expect(dynamicPolicy.resolve(enterpriseReq).tierName).toBe('enterprise');

    const proReq: KeyGeneratorRequest = {
      headers: { authorization: 'Bearer pro-token' },
    };
    expect(dynamicPolicy.resolve(proReq).tierName).toBe('pro');

    const freeReq: KeyGeneratorRequest = {
      headers: {},
    };
    expect(dynamicPolicy.resolve(freeReq).tierName).toBe('free');
  });

  it('should give each tier independent tracking when used with limiter', async () => {
    vi.useFakeTimers();
    const now = 100000;
    vi.setSystemTime(now);

    const store = new MemoryStore({ nowFn: () => Date.now() });
    const limiter = new RateLimiter({
      store,
      algorithm: 'fixed-window',
      nowFn: () => Date.now(),
    });

    const smallTiers = {
      free: { limit: 2, windowMs: 10000 },
      pro: { limit: 5, windowMs: 10000 },
    };

    const tieredPolicy = new TieredPolicy(smallTiers, {
      algorithm: 'fixed-window',
      tierResolver: (req) => (req['tier'] as string) ?? 'free',
      defaultTier: 'free',
    });

    // Free user makes 2 requests (limit)
    const freeReq = { ip: '1.1.1.1', headers: {}, tier: 'free' };
    const freeResolution = tieredPolicy.resolve(freeReq);

    for (let i = 0; i < 2; i++) {
      const result = await limiter.consume(`free:${byIp(freeReq)}`, freeResolution.config);
      expect(result.allowed).toBe(true);
    }

    // Free user denied
    const freeDenied = await limiter.consume(`free:${byIp(freeReq)}`, freeResolution.config);
    expect(freeDenied.allowed).toBe(false);

    // Pro user still has capacity
    const proReq = { ip: '2.2.2.2', headers: {}, tier: 'pro' };
    const proResolution = tieredPolicy.resolve(proReq);

    const proResult = await limiter.consume(`pro:${byIp(proReq)}`, proResolution.config);
    expect(proResult.allowed).toBe(true);
    expect(proResult.remaining).toBe(4);

    vi.useRealTimers();
  });

  it('should handle tier change mid-session (user upgrades)', async () => {
    vi.useFakeTimers();
    const now = 100000;
    vi.setSystemTime(now);

    const store = new MemoryStore({ nowFn: () => Date.now() });
    const limiter = new RateLimiter({
      store,
      algorithm: 'fixed-window',
      nowFn: () => Date.now(),
    });

    const upgradeTiers = {
      free: { limit: 2, windowMs: 60000 },
      pro: { limit: 10, windowMs: 60000 },
    };

    let currentTier = 'free';
    const upgradePolicy = new TieredPolicy(upgradeTiers, {
      algorithm: 'fixed-window',
      tierResolver: () => currentTier,
      defaultTier: 'free',
    });

    // As free user, exhaust limit
    const freeRes = upgradePolicy.resolve({ headers: {} });
    await limiter.consume('user:upgrade-test', freeRes.config);
    await limiter.consume('user:upgrade-test', freeRes.config);
    const denied = await limiter.consume('user:upgrade-test', freeRes.config);
    expect(denied.allowed).toBe(false);

    // User upgrades to pro
    currentTier = 'pro';
    const proRes = upgradePolicy.resolve({ headers: {} });
    expect(proRes.tierName).toBe('pro');
    expect(proRes.config.limit).toBe(10);

    // With pro limits, the same key might still be exhausted (same counter)
    // but a new key prefix would give fresh capacity
    const proResult = await limiter.consume('user:upgrade-test-pro', proRes.config);
    expect(proResult.allowed).toBe(true);

    vi.useRealTimers();
  });

  it('should handle single-tier setup', () => {
    const singleTier = new TieredPolicy(
      { default: { limit: 100, windowMs: 60000 } },
      {
        algorithm: 'fixed-window',
        tierResolver: () => 'default',
        defaultTier: 'default',
      },
    );

    const result = singleTier.resolve({ headers: {} });
    expect(result.tierName).toBe('default');
    expect(result.config.limit).toBe(100);
  });
});
