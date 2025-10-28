// TODO: add refill precision tests
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { MemoryStore } from '../../src/store/memory.js';
import { tokenBucketConsume } from '../../src/core/token-bucket.js';
import type { TokenBucketConfig } from '../../src/core/types.js';

describe('Token Bucket Algorithm', () => {
  let store: MemoryStore;
  let now: number;

  beforeEach(() => {
    vi.useFakeTimers();
    now = 1000000;
    vi.setSystemTime(now);
    store = new MemoryStore({ nowFn: () => Date.now() });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const config: TokenBucketConfig = { capacity: 10, refillRate: 1 };

  it('should allow requests when bucket is full (initial capacity)', async () => {
    const result = await tokenBucketConsume(store, 'test', config, now);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(9);
    expect(result.limit).toBe(10);
  });

  it('should consume tokens on each request', async () => {
    for (let i = 0; i < 5; i++) {
      const result = await tokenBucketConsume(store, 'test', config, now);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(9 - i);
    }
  });

  it('should deny requests when tokens are exhausted', async () => {
    for (let i = 0; i < 10; i++) {
      const result = await tokenBucketConsume(store, 'test', config, now);
      expect(result.allowed).toBe(true);
    }

    const denied = await tokenBucketConsume(store, 'test', config, now);
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
  });

  it('should refill tokens over time', async () => {
    for (let i = 0; i < 10; i++) {
      await tokenBucketConsume(store, 'test', config, now);
    }

    vi.advanceTimersByTime(5000);
    const newNow = now + 5000;

    const result = await tokenBucketConsume(store, 'test', config, newNow);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4);
  });

  it('should not exceed capacity when refilling', async () => {
    vi.advanceTimersByTime(60000);
    const newNow = now + 60000;

    const result = await tokenBucketConsume(store, 'test', config, newNow);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(9);
  });

  it('should calculate correct retry-after when denied', async () => {
    for (let i = 0; i < 10; i++) {
      await tokenBucketConsume(store, 'test', config, now);
    }

    const denied = await tokenBucketConsume(store, 'test', config, now);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBe(1000);
  });

  it('should handle burst consumption (cost > 1)', async () => {
    const result = await tokenBucketConsume(store, 'test', config, now, 5);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(5);

    const result2 = await tokenBucketConsume(store, 'test', config, now, 5);
    expect(result2.allowed).toBe(true);
    expect(result2.remaining).toBe(0);

    const denied = await tokenBucketConsume(store, 'test', config, now, 1);
    expect(denied.allowed).toBe(false);
  });

  it('should isolate different keys', async () => {
    for (let i = 0; i < 10; i++) {
      await tokenBucketConsume(store, 'key-a', config, now);
    }

    const result = await tokenBucketConsume(store, 'key-b', config, now);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(9);
  });

  it('should handle fractional refill rates', async () => {
    const slowConfig: TokenBucketConfig = { capacity: 5, refillRate: 0.5 };

    for (let i = 0; i < 5; i++) {
      await tokenBucketConsume(store, 'test', slowConfig, now);
    }

    vi.advanceTimersByTime(2000);
    const newNow = now + 2000;

    const result = await tokenBucketConsume(store, 'test', slowConfig, newNow);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(0);
  });

  // --- New comprehensive tests ---

  it('should refill exactly at the configured rate over precise intervals', async () => {
    const preciseConfig: TokenBucketConfig = { capacity: 10, refillRate: 2 };

    // Exhaust all tokens
    for (let i = 0; i < 10; i++) {
      await tokenBucketConsume(store, 'test', preciseConfig, now);
    }

    // After 1 second: 2 tokens refilled
    vi.advanceTimersByTime(1000);
    let t = now + 1000;
    let result = await tokenBucketConsume(store, 'test', preciseConfig, t);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(1); // 2 refilled - 1 consumed

    // After another 0.5 seconds: 1 more token refilled (total 2 remaining from earlier - 1 consumed + 1 refilled = 2)
    vi.advanceTimersByTime(500);
    t = now + 1500;
    result = await tokenBucketConsume(store, 'test', preciseConfig, t);
    expect(result.allowed).toBe(true);
    // Previous state: 1 remaining after consuming. 0.5s * 2/sec = 1 refilled => 2 tokens - 1 consumed = 1
    expect(result.remaining).toBe(1);
  });

  it('should handle partial refill (less than 1 token)', async () => {
    const preciseConfig: TokenBucketConfig = { capacity: 5, refillRate: 1 };

    // Exhaust all tokens
    for (let i = 0; i < 5; i++) {
      await tokenBucketConsume(store, 'test', preciseConfig, now);
    }

    // After 0.5 seconds: 0.5 tokens refilled (not enough for 1)
    vi.advanceTimersByTime(500);
    const halfSec = now + 500;
    const denied = await tokenBucketConsume(store, 'test', preciseConfig, halfSec);
    expect(denied.allowed).toBe(false);

    // After 1 full second from exhaust: 1 token refilled
    vi.advanceTimersByTime(500);
    const fullSec = now + 1000;
    const allowed = await tokenBucketConsume(store, 'test', preciseConfig, fullSec);
    expect(allowed.allowed).toBe(true);
  });

  it('should consume exactly capacity tokens and deny the next', async () => {
    const smallConfig: TokenBucketConfig = { capacity: 3, refillRate: 1 };
    for (let i = 0; i < 3; i++) {
      const result = await tokenBucketConsume(store, 'test', smallConfig, now);
      expect(result.allowed).toBe(true);
    }

    const denied = await tokenBucketConsume(store, 'test', smallConfig, now);
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
  });

  it('should deny when cost exceeds capacity', async () => {
    const smallConfig: TokenBucketConfig = { capacity: 3, refillRate: 1 };
    const denied = await tokenBucketConsume(store, 'test', smallConfig, now, 4);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
  });

  it('should handle zero-cost request without consuming tokens', async () => {
    const result = await tokenBucketConsume(store, 'test', config, now, 0);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(10);

    // Next request with cost=1 should still have full capacity
    const result2 = await tokenBucketConsume(store, 'test', config, now, 1);
    expect(result2.allowed).toBe(true);
    expect(result2.remaining).toBe(9);
  });

  it('should handle concurrent consumers on same key', async () => {
    // Simulate concurrent requests by making them at the same timestamp
    const results = await Promise.all([
      tokenBucketConsume(store, 'test', config, now),
      tokenBucketConsume(store, 'test', config, now),
      tokenBucketConsume(store, 'test', config, now),
    ]);

    // All should be allowed (10 capacity, 3 consumed)
    expect(results.every(r => r.allowed)).toBe(true);
  });

  it('should reset mid-usage and restore full capacity', async () => {
    // Consume 5 tokens
    for (let i = 0; i < 5; i++) {
      await tokenBucketConsume(store, 'test', config, now);
    }

    // Reset by creating a fresh store state (simulate DEL)
    await store.eval(`redis.call('DEL', KEYS[1]); return 1`, ['test'], []);

    // Should have full capacity again
    const result = await tokenBucketConsume(store, 'test', config, now);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(9);
  });

  it('should refill does not exceed capacity after long idle', async () => {
    // Consume 1 token
    await tokenBucketConsume(store, 'test', config, now);

    // Wait a very long time (100 seconds for capacity of 10 at rate 1/sec)
    vi.advanceTimersByTime(100000);
    const laterNow = now + 100000;

    const result = await tokenBucketConsume(store, 'test', config, laterNow);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(9); // capped at capacity, minus 1
  });

  it('should calculate correct retry-after for multi-token cost', async () => {
    // Exhaust all tokens
    for (let i = 0; i < 10; i++) {
      await tokenBucketConsume(store, 'test', config, now);
    }

    // Request 3 tokens - need 3 seconds of refill at 1/sec
    const denied = await tokenBucketConsume(store, 'test', config, now, 3);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBe(3000);
  });

  it('should handle high refill rate correctly', async () => {
    const fastConfig: TokenBucketConfig = { capacity: 100, refillRate: 100 };

    // Exhaust all
    const result = await tokenBucketConsume(store, 'test', fastConfig, now, 100);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(0);

    // After 0.5 seconds: 50 tokens refilled
    vi.advanceTimersByTime(500);
    const halfSec = now + 500;
    const after = await tokenBucketConsume(store, 'test', fastConfig, halfSec, 50);
    expect(after.allowed).toBe(true);
    expect(after.remaining).toBe(0); // 50 refilled - 50 consumed
  });
});
