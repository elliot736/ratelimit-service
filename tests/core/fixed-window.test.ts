import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { MemoryStore } from '../../src/store/memory.js';
import { fixedWindowConsume } from '../../src/core/fixed-window.js';
import type { RateLimiterConfig } from '../../src/core/types.js';

describe('Fixed Window Algorithm', () => {
  let store: MemoryStore;
  let now: number;

  beforeEach(() => {
    vi.useFakeTimers();
    now = 100000; // Clean window boundary for windowMs=10000
    vi.setSystemTime(now);
    store = new MemoryStore({ nowFn: () => Date.now() });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const config: RateLimiterConfig = { limit: 5, windowMs: 10000 };

  it('should allow requests within the limit', async () => {
    for (let i = 0; i < 5; i++) {
      const result = await fixedWindowConsume(store, 'test', config, now);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(4 - i);
    }
  });

  it('should deny requests that exceed the limit', async () => {
    for (let i = 0; i < 5; i++) {
      await fixedWindowConsume(store, 'test', config, now);
    }

    const denied = await fixedWindowConsume(store, 'test', config, now);
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
  });

  it('should reset at window boundary', async () => {
    for (let i = 0; i < 5; i++) {
      await fixedWindowConsume(store, 'test', config, now);
    }

    vi.advanceTimersByTime(10000);
    const newNow = now + 10000;

    const result = await fixedWindowConsume(store, 'test', config, newNow);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4);
  });

  it('should demonstrate the 2x burst problem at window boundaries', async () => {
    // Make 5 requests at the end of one window
    const windowEnd = now + 9999;
    for (let i = 0; i < 5; i++) {
      const result = await fixedWindowConsume(store, 'test', config, windowEnd);
      expect(result.allowed).toBe(true);
    }

    // Immediately after the window boundary, make 5 more
    const nextWindowStart = now + 10000;
    vi.setSystemTime(nextWindowStart);
    for (let i = 0; i < 5; i++) {
      const result = await fixedWindowConsume(store, 'test', config, nextWindowStart);
      expect(result.allowed).toBe(true);
    }

    // 10 requests in ~1ms - this is the 2x burst problem
  });

  it('should report correct retry-after time', async () => {
    for (let i = 0; i < 5; i++) {
      await fixedWindowConsume(store, 'test', config, now);
    }

    const denied = await fixedWindowConsume(store, 'test', config, now);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBe(10000);
  });

  it('should report correct resetMs', async () => {
    const result = await fixedWindowConsume(store, 'test', config, now);
    expect(result.resetMs).toBe(10000);

    vi.advanceTimersByTime(3000);
    const midNow = now + 3000;
    const result2 = await fixedWindowConsume(store, 'test', config, midNow);
    expect(result2.resetMs).toBe(7000);
  });

  it('should isolate different keys', async () => {
    for (let i = 0; i < 5; i++) {
      await fixedWindowConsume(store, 'key-a', config, now);
    }

    const result = await fixedWindowConsume(store, 'key-b', config, now);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4);
  });

  // --- New comprehensive tests ---

  it('should demonstrate 2x burst problem explicitly with counts', async () => {
    const burstConfig: RateLimiterConfig = { limit: 10, windowMs: 1000 };

    // Make 10 requests at the very end of a window (t=999ms)
    const windowEnd = now + 999;
    for (let i = 0; i < 10; i++) {
      const result = await fixedWindowConsume(store, 'test', burstConfig, windowEnd);
      expect(result.allowed).toBe(true);
    }

    // Make 10 more at the very start of next window (t=1000ms)
    const nextStart = now + 1000;
    vi.setSystemTime(nextStart);
    for (let i = 0; i < 10; i++) {
      const result = await fixedWindowConsume(store, 'test', burstConfig, nextStart);
      expect(result.allowed).toBe(true);
    }

    // 20 requests passed in 1ms, despite a limit of 10 per second
    // This is the core weakness of fixed window
  });

  it('should handle window key rotation (different window keys)', async () => {
    // Window 0
    await fixedWindowConsume(store, 'test', config, now);

    // Advance to window 1
    vi.advanceTimersByTime(10000);
    const w1 = now + 10000;
    const result1 = await fixedWindowConsume(store, 'test', config, w1);
    expect(result1.allowed).toBe(true);
    expect(result1.remaining).toBe(4); // fresh window

    // Advance to window 2
    vi.advanceTimersByTime(10000);
    const w2 = now + 20000;
    const result2 = await fixedWindowConsume(store, 'test', config, w2);
    expect(result2.allowed).toBe(true);
    expect(result2.remaining).toBe(4); // fresh window
  });

  it('should handle very short windows (100ms)', async () => {
    const shortConfig: RateLimiterConfig = { limit: 2, windowMs: 100 };

    // Fill window
    await fixedWindowConsume(store, 'test', shortConfig, now);
    await fixedWindowConsume(store, 'test', shortConfig, now);

    const denied = await fixedWindowConsume(store, 'test', shortConfig, now);
    expect(denied.allowed).toBe(false);

    // Advance past window
    vi.advanceTimersByTime(100);
    const newNow = now + 100;
    const allowed = await fixedWindowConsume(store, 'test', shortConfig, newNow);
    expect(allowed.allowed).toBe(true);
  });

  it('should handle very long windows (1hr)', async () => {
    const longConfig: RateLimiterConfig = { limit: 1000, windowMs: 3600000 };

    const result = await fixedWindowConsume(store, 'test', longConfig, now);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(999);
    // now=100000, windowMs=3600000, currentWindow=0, windowEnd=3600000
    // resetMs = windowEnd - now = 3600000 - 100000 = 3500000
    expect(result.resetMs).toBe(3500000);
  });

  it('should report retry-after equal to remaining time in window', async () => {
    for (let i = 0; i < 5; i++) {
      await fixedWindowConsume(store, 'test', config, now);
    }

    // At 3 seconds into window, retry-after should be 7 seconds
    vi.advanceTimersByTime(3000);
    const midNow = now + 3000;
    const denied = await fixedWindowConsume(store, 'test', config, midNow);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBe(7000);
  });

  it('should handle limit of 1', async () => {
    const strictConfig: RateLimiterConfig = { limit: 1, windowMs: 5000 };

    const first = await fixedWindowConsume(store, 'test', strictConfig, now);
    expect(first.allowed).toBe(true);
    expect(first.remaining).toBe(0);

    const second = await fixedWindowConsume(store, 'test', strictConfig, now + 100);
    expect(second.allowed).toBe(false);
  });

  it('should correctly count requests within same window at different timestamps', async () => {
    await fixedWindowConsume(store, 'test', config, now);
    await fixedWindowConsume(store, 'test', config, now + 1000);
    await fixedWindowConsume(store, 'test', config, now + 2000);

    // 3 requests made, 2 remaining
    vi.advanceTimersByTime(3000);
    const result = await fixedWindowConsume(store, 'test', config, now + 3000);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(1);
  });

  it('should not carry over counts between windows', async () => {
    // Fill first window
    for (let i = 0; i < 5; i++) {
      await fixedWindowConsume(store, 'test', config, now);
    }

    // Move to next window
    vi.advanceTimersByTime(10000);

    // Should have a completely fresh count
    for (let i = 0; i < 5; i++) {
      const result = await fixedWindowConsume(store, 'test', config, now + 10000);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(4 - i);
    }
  });
});
