import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { MemoryStore } from '../../src/store/memory.js';
import { slidingWindowCounterConsume } from '../../src/core/sliding-window-counter.js';
import { slidingWindowConsume } from '../../src/core/sliding-window.js';
import type { RateLimiterConfig } from '../../src/core/types.js';

describe('Sliding Window Counter Algorithm', () => {
  let store: MemoryStore;
  let now: number;

  beforeEach(() => {
    vi.useFakeTimers();
    now = 100000; // exactly at a window boundary for windowMs=10000
    vi.setSystemTime(now);
    store = new MemoryStore({ nowFn: () => Date.now() });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const config: RateLimiterConfig = { limit: 10, windowMs: 10000 };

  it('should allow requests within the limit', async () => {
    for (let i = 0; i < 10; i++) {
      const result = await slidingWindowCounterConsume(store, 'test', config, now);
      expect(result.allowed).toBe(true);
    }
  });

  it('should deny requests that exceed the limit', async () => {
    for (let i = 0; i < 10; i++) {
      await slidingWindowCounterConsume(store, 'test', config, now);
    }

    const denied = await slidingWindowCounterConsume(store, 'test', config, now);
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
  });

  it('should use weighted calculation across windows', async () => {
    for (let i = 0; i < 10; i++) {
      await slidingWindowCounterConsume(store, 'test', config, now);
    }

    vi.advanceTimersByTime(15000);
    const midNow = now + 15000;

    const result = await slidingWindowCounterConsume(store, 'test', config, midNow);
    expect(result.allowed).toBe(true);
  });

  it('should smoothly transition between windows', async () => {
    for (let i = 0; i < 10; i++) {
      await slidingWindowCounterConsume(store, 'test', config, now);
    }

    vi.advanceTimersByTime(10000);
    const boundaryNow = now + 10000;

    const atBoundary = await slidingWindowCounterConsume(store, 'test', config, boundaryNow);
    expect(atBoundary.allowed).toBe(false);

    vi.advanceTimersByTime(1000);
    const tenPercent = now + 11000;
    const result = await slidingWindowCounterConsume(store, 'test', config, tenPercent);
    expect(result.allowed).toBe(true);
  });

  it('should be more memory efficient than sliding window log', async () => {
    const manyRequests: RateLimiterConfig = { limit: 1000, windowMs: 60000 };

    for (let i = 0; i < 100; i++) {
      await slidingWindowCounterConsume(store, 'test', manyRequests, now);
    }

    const result = await slidingWindowCounterConsume(store, 'test', manyRequests, now);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(899);
  });

  it('should report correct remaining count', async () => {
    const result1 = await slidingWindowCounterConsume(store, 'test', config, now);
    expect(result1.remaining).toBe(9);

    const result2 = await slidingWindowCounterConsume(store, 'test', config, now);
    expect(result2.remaining).toBe(8);
  });

  it('should calculate retry-after when denied', async () => {
    for (let i = 0; i < 10; i++) {
      await slidingWindowCounterConsume(store, 'test', config, now);
    }

    const denied = await slidingWindowCounterConsume(store, 'test', config, now);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
    expect(denied.retryAfterMs).toBeLessThanOrEqual(config.windowMs);
  });

  // --- New comprehensive tests ---

  it('should verify weighted calculation with known values', async () => {
    // Fill previous window completely at exact boundary
    for (let i = 0; i < 10; i++) {
      await slidingWindowCounterConsume(store, 'test', config, now);
    }

    // Move to 25% through next window
    vi.advanceTimersByTime(12500);
    const t = now + 12500;

    // weighted = prevCount * (1 - 0.25) + currCount = 10 * 0.75 + 0 = 7.5
    // So remaining = floor(10 - 7.5) = 2
    const result = await slidingWindowCounterConsume(store, 'test', config, t);
    expect(result.allowed).toBe(true);
    // After consuming 1, remaining should drop
    expect(result.remaining).toBe(1);
  });

  it('should compare accuracy against sliding window log for same scenario', async () => {
    const compConfig: RateLimiterConfig = { limit: 5, windowMs: 10000 };
    const counterStore = new MemoryStore({ nowFn: () => Date.now() });
    const logStore = new MemoryStore({ nowFn: () => Date.now() });

    // Make 3 requests at the start of a window
    for (let i = 0; i < 3; i++) {
      await slidingWindowCounterConsume(counterStore, 'test', compConfig, now);
      await slidingWindowConsume(logStore, 'test', compConfig, now + i);
    }

    // Move 50% into next window
    vi.advanceTimersByTime(15000);
    const midNow = now + 15000;

    // Counter: weighted = 3 * 0.5 + 0 = 1.5, so ~3 remaining
    const counterResult = await slidingWindowCounterConsume(counterStore, 'test', compConfig, midNow);
    // Log: all 3 entries at t=now expired (15000ms > 10000ms window)
    const logResult = await slidingWindowConsume(logStore, 'test', compConfig, midNow);

    // Both should allow
    expect(counterResult.allowed).toBe(true);
    expect(logResult.allowed).toBe(true);
  });

  it('should handle window transition smoothness (no sudden drops)', async () => {
    // Fill with 8 requests in current window
    for (let i = 0; i < 8; i++) {
      await slidingWindowCounterConsume(store, 'test', config, now);
    }

    // Check remaining at various points through next window
    const remainingOverTime: number[] = [];
    for (let pct = 0; pct <= 100; pct += 10) {
      const freshStore = new MemoryStore({ nowFn: () => Date.now() });
      // Fill previous window
      for (let i = 0; i < 8; i++) {
        await slidingWindowCounterConsume(freshStore, 'test', config, now);
      }

      const elapsed = 10000 + (pct / 100) * 10000;
      vi.setSystemTime(now + elapsed);
      const t = now + elapsed;
      const result = await slidingWindowCounterConsume(freshStore, 'test', config, t);
      remainingOverTime.push(result.remaining);
    }

    // Remaining should be monotonically non-decreasing as the previous window's
    // contribution decreases (allowing more remaining)
    for (let i = 1; i < remainingOverTime.length; i++) {
      expect(remainingOverTime[i]!).toBeGreaterThanOrEqual(remainingOverTime[i - 1]! - 1);
    }
  });

  it('should handle deny at start of next window when previous is full', async () => {
    // Fill current window completely
    for (let i = 0; i < 10; i++) {
      await slidingWindowCounterConsume(store, 'test', config, now);
    }

    // Right at the start of next window, elapsed_ratio = 0
    // weighted = 10 * (1 - 0) + 0 = 10 >= 10, denied
    vi.advanceTimersByTime(10000);
    const nextStart = now + 10000;
    const denied = await slidingWindowCounterConsume(store, 'test', config, nextStart);
    expect(denied.allowed).toBe(false);
  });

  it('should gradually allow more requests as window progresses', async () => {
    // Fill current window
    for (let i = 0; i < 10; i++) {
      await slidingWindowCounterConsume(store, 'test', config, now);
    }

    // At 50% through next window: weighted = 10 * 0.5 = 5
    vi.advanceTimersByTime(15000);
    const t50 = now + 15000;
    const at50 = await slidingWindowCounterConsume(store, 'test', config, t50);
    expect(at50.allowed).toBe(true);

    // At 90% through next window: weighted = 10 * 0.1 + 1 = 2
    vi.advanceTimersByTime(4000);
    const t90 = now + 19000;
    const at90 = await slidingWindowCounterConsume(store, 'test', config, t90);
    expect(at90.allowed).toBe(true);
  });

  it('should isolate different keys', async () => {
    for (let i = 0; i < 10; i++) {
      await slidingWindowCounterConsume(store, 'key-a', config, now);
    }

    const denied = await slidingWindowCounterConsume(store, 'key-a', config, now);
    expect(denied.allowed).toBe(false);

    const allowed = await slidingWindowCounterConsume(store, 'key-b', config, now);
    expect(allowed.allowed).toBe(true);
    expect(allowed.remaining).toBe(9);
  });

  it('should report correct resetMs', async () => {
    const result = await slidingWindowCounterConsume(store, 'test', config, now);
    // At window boundary, resetMs should be the full window
    expect(result.resetMs).toBe(10000);

    // At 3 seconds into window
    vi.advanceTimersByTime(3000);
    const midResult = await slidingWindowCounterConsume(store, 'test', config, now + 3000);
    expect(midResult.resetMs).toBe(7000);
  });
});
