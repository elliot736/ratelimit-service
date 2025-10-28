// TODO: fix timing sensitivity
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { MemoryStore } from '../../src/store/memory.js';
import { slidingWindowConsume } from '../../src/core/sliding-window.js';
import type { RateLimiterConfig } from '../../src/core/types.js';

describe('Sliding Window Log Algorithm', () => {
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

  const config: RateLimiterConfig = { limit: 5, windowMs: 10000 };

  it('should allow requests within the limit', async () => {
    for (let i = 0; i < 5; i++) {
      const result = await slidingWindowConsume(store, 'test', config, now);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(4 - i);
    }
  });

  it('should deny requests that exceed the limit', async () => {
    for (let i = 0; i < 5; i++) {
      await slidingWindowConsume(store, 'test', config, now);
    }

    const denied = await slidingWindowConsume(store, 'test', config, now);
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
  });

  it('should allow requests after the window expires', async () => {
    for (let i = 0; i < 5; i++) {
      await slidingWindowConsume(store, 'test', config, now);
    }

    vi.advanceTimersByTime(10001);
    const newNow = now + 10001;

    const result = await slidingWindowConsume(store, 'test', config, newNow);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4);
  });

  it('should accurately count across window boundary (sliding behavior)', async () => {
    // Make 3 requests at t=0
    for (let i = 0; i < 3; i++) {
      await slidingWindowConsume(store, 'test', config, now);
    }

    // Advance 6 seconds
    vi.advanceTimersByTime(6000);
    const midNow = now + 6000;

    // Make 2 more requests at t=6s
    for (let i = 0; i < 2; i++) {
      await slidingWindowConsume(store, 'test', config, midNow);
    }

    // At t=6s, all 5 requests are in window
    const denied = await slidingWindowConsume(store, 'test', config, midNow);
    expect(denied.allowed).toBe(false);

    // At t=11s, the 3 requests at t=0 are now expired
    vi.advanceTimersByTime(5000);
    const laterNow = now + 11000;

    const allowed = await slidingWindowConsume(store, 'test', config, laterNow);
    expect(allowed.allowed).toBe(true);
    expect(allowed.remaining).toBe(2);
  });

  it('should calculate correct retry-after from oldest entry', async () => {
    for (let i = 0; i < 5; i++) {
      await slidingWindowConsume(store, 'test', config, now + i);
    }

    const denied = await slidingWindowConsume(store, 'test', config, now + 5);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBe(9995);
  });

  it('should report window size as resetMs', async () => {
    const result = await slidingWindowConsume(store, 'test', config, now);
    expect(result.resetMs).toBe(10000);
  });

  // --- New comprehensive tests ---

  it('should handle requests exactly at window boundary', async () => {
    // Make requests at exact window boundary
    for (let i = 0; i < 5; i++) {
      await slidingWindowConsume(store, 'test', config, now);
    }

    // At exactly window end, old entries should be removed
    vi.advanceTimersByTime(10000);
    const boundaryNow = now + 10000;

    const result = await slidingWindowConsume(store, 'test', config, boundaryNow);
    expect(result.allowed).toBe(true);
    // Old entries at `now` have score <= windowStart (boundaryNow - 10000 = now), so removed
    expect(result.remaining).toBe(4);
  });

  it('should handle requests spanning two windows correctly', async () => {
    // Make 2 requests in first window
    await slidingWindowConsume(store, 'test', config, now);
    await slidingWindowConsume(store, 'test', config, now + 1000);

    // Make 2 requests in overlapping period
    vi.advanceTimersByTime(8000);
    await slidingWindowConsume(store, 'test', config, now + 8000);
    await slidingWindowConsume(store, 'test', config, now + 9000);

    // At t=9000, window is [-1000, 9000], all 4 requests are in window
    const result = await slidingWindowConsume(store, 'test', config, now + 9000);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(0); // 5th request, 0 remaining
  });

  it('should drop old entries as window slides', async () => {
    // Make request at t=0
    await slidingWindowConsume(store, 'test', config, now);
    // Make request at t=3000
    vi.advanceTimersByTime(3000);
    await slidingWindowConsume(store, 'test', config, now + 3000);
    // Make request at t=7000
    vi.advanceTimersByTime(4000);
    await slidingWindowConsume(store, 'test', config, now + 7000);

    // At t=11000, window is [1000, 11000] - t=0 entry dropped
    vi.advanceTimersByTime(4000);
    const result = await slidingWindowConsume(store, 'test', config, now + 11000);
    expect(result.allowed).toBe(true);
    // Only t=3000 and t=7000 are in window, plus this new one = 3 total
    expect(result.remaining).toBe(2);
  });

  it('should handle rapid requests then long pause then resume', async () => {
    // Burst 5 requests
    for (let i = 0; i < 5; i++) {
      await slidingWindowConsume(store, 'test', config, now);
    }

    // Denied
    const denied = await slidingWindowConsume(store, 'test', config, now);
    expect(denied.allowed).toBe(false);

    // Long pause (30 seconds) - well past window
    vi.advanceTimersByTime(30000);
    const laterNow = now + 30000;

    // Should be fully reset
    const result = await slidingWindowConsume(store, 'test', config, laterNow);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4);
  });

  it('should handle limit of 1', async () => {
    const strictConfig: RateLimiterConfig = { limit: 1, windowMs: 5000 };

    const first = await slidingWindowConsume(store, 'test', strictConfig, now);
    expect(first.allowed).toBe(true);
    expect(first.remaining).toBe(0);

    const second = await slidingWindowConsume(store, 'test', strictConfig, now + 100);
    expect(second.allowed).toBe(false);

    // After window expires
    vi.advanceTimersByTime(5001);
    const afterWindow = await slidingWindowConsume(store, 'test', strictConfig, now + 5001);
    expect(afterWindow.allowed).toBe(true);
  });

  it('should handle large limit (10000)', async () => {
    const largeConfig: RateLimiterConfig = { limit: 10000, windowMs: 60000 };

    // Make 100 requests rapidly
    for (let i = 0; i < 100; i++) {
      const result = await slidingWindowConsume(store, 'test', largeConfig, now + i);
      expect(result.allowed).toBe(true);
    }

    const result = await slidingWindowConsume(store, 'test', largeConfig, now + 100);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(9899); // 10000 - 101
  });

  it('should isolate different keys', async () => {
    for (let i = 0; i < 5; i++) {
      await slidingWindowConsume(store, 'key-a', config, now);
    }

    const denied = await slidingWindowConsume(store, 'key-a', config, now);
    expect(denied.allowed).toBe(false);

    const allowed = await slidingWindowConsume(store, 'key-b', config, now);
    expect(allowed.allowed).toBe(true);
    expect(allowed.remaining).toBe(4);
  });

  it('should handle cost > 1 by consuming multiple slots', async () => {
    const result = await slidingWindowConsume(store, 'test', config, now, 3);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(2);

    // Only 2 more should be allowed
    const result2 = await slidingWindowConsume(store, 'test', config, now, 2);
    expect(result2.allowed).toBe(true);
    expect(result2.remaining).toBe(0);

    const denied = await slidingWindowConsume(store, 'test', config, now, 1);
    expect(denied.allowed).toBe(false);
  });
});
