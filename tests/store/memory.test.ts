// TODO: add concurrent access tests
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { MemoryStore } from '../../src/store/memory.js';
import { TOKEN_BUCKET_SCRIPT } from '../../src/core/lua/token-bucket.lua.js';
import { FIXED_WINDOW_SCRIPT } from '../../src/core/lua/fixed-window.lua.js';
import { SLIDING_WINDOW_SCRIPT } from '../../src/core/lua/sliding-window.lua.js';
import { SLIDING_WINDOW_COUNTER_SCRIPT } from '../../src/core/lua/sliding-window-counter.lua.js';

describe('MemoryStore', () => {
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

  it('should execute token bucket script correctly', async () => {
    const result = (await store.eval(
      TOKEN_BUCKET_SCRIPT,
      ['test-key'],
      [10, 1, now / 1000, 1],
    )) as number[];

    expect(result[0]).toBe(1);
    expect(result[1]).toBe(9);
    expect(result[2]).toBe(0);
  });

  it('should execute fixed window script correctly', async () => {
    const result = (await store.eval(
      FIXED_WINDOW_SCRIPT,
      ['test-key'],
      [5, 10000, now],
    )) as number[];

    expect(result[0]).toBe(1);
    expect(result[1]).toBe(4);
  });

  it('should handle TTL expiry for token bucket', async () => {
    await store.eval(TOKEN_BUCKET_SCRIPT, ['test-key'], [2, 1, now / 1000, 2]);

    const denied = (await store.eval(
      TOKEN_BUCKET_SCRIPT,
      ['test-key'],
      [2, 1, now / 1000, 1],
    )) as number[];
    expect(denied[0]).toBe(0);

    vi.advanceTimersByTime(4000);
    const newNow = now + 4000;

    const result = (await store.eval(
      TOKEN_BUCKET_SCRIPT,
      ['test-key'],
      [2, 1, newNow / 1000, 1],
    )) as number[];
    expect(result[0]).toBe(1);
    expect(result[1]).toBe(1);
  });

  it('should isolate keys from each other', async () => {
    await store.eval(TOKEN_BUCKET_SCRIPT, ['key-a'], [1, 1, now / 1000, 1]);
    const deniedA = (await store.eval(
      TOKEN_BUCKET_SCRIPT,
      ['key-a'],
      [1, 1, now / 1000, 1],
    )) as number[];
    expect(deniedA[0]).toBe(0);

    const resultB = (await store.eval(
      TOKEN_BUCKET_SCRIPT,
      ['key-b'],
      [1, 1, now / 1000, 1],
    )) as number[];
    expect(resultB[0]).toBe(1);
  });

  it('should handle DEL script', async () => {
    await store.eval(TOKEN_BUCKET_SCRIPT, ['test-key'], [10, 1, now / 1000, 10]);

    await store.eval(`redis.call('DEL', KEYS[1]); return 1`, ['test-key'], []);

    const result = (await store.eval(
      TOKEN_BUCKET_SCRIPT,
      ['test-key'],
      [10, 1, now / 1000, 1],
    )) as number[];
    expect(result[0]).toBe(1);
    expect(result[1]).toBe(9);
  });

  it('should handle EXISTS script', async () => {
    const notExists = (await store.eval(
      `return redis.call('EXISTS', KEYS[1])`,
      ['nonexistent'],
      [],
    )) as number;
    expect(notExists).toBe(0);

    await store.eval(TOKEN_BUCKET_SCRIPT, ['test-key'], [10, 1, now / 1000, 1]);

    const exists = (await store.eval(
      `return redis.call('EXISTS', KEYS[1])`,
      ['test-key'],
      [],
    )) as number;
    expect(exists).toBe(1);
  });

  it('should throw on unrecognized scripts', async () => {
    await expect(
      store.eval('unknown_script()', ['key'], []),
    ).rejects.toThrow('unrecognized script');
  });

  it('should clean up on disconnect', async () => {
    await store.eval(TOKEN_BUCKET_SCRIPT, ['test-key'], [10, 1, now / 1000, 1]);
    await store.disconnect();

    const result = (await store.eval(
      TOKEN_BUCKET_SCRIPT,
      ['test-key'],
      [10, 1, now / 1000, 1],
    )) as number[];
    expect(result[1]).toBe(9);
  });

  // --- New comprehensive tests ---

  it('should expire token bucket entries after TTL', async () => {
    // Create entry with capacity=5, refillRate=1 -> TTL = 5000+1000=6000ms
    await store.eval(TOKEN_BUCKET_SCRIPT, ['ttl-key'], [5, 1, now / 1000, 5]);

    // Before expiry
    vi.advanceTimersByTime(5000);
    const beforeExpiry = (await store.eval(
      `return redis.call('EXISTS', KEYS[1])`,
      ['ttl-key'],
      [],
    )) as number;
    expect(beforeExpiry).toBe(1);

    // After expiry
    vi.advanceTimersByTime(2000); // now at 7000ms past
    const afterExpiry = (await store.eval(
      `return redis.call('EXISTS', KEYS[1])`,
      ['ttl-key'],
      [],
    )) as number;
    expect(afterExpiry).toBe(0);
  });

  it('should handle concurrent operations on same key', async () => {
    const results = await Promise.all([
      store.eval(TOKEN_BUCKET_SCRIPT, ['concurrent'], [10, 1, now / 1000, 1]),
      store.eval(TOKEN_BUCKET_SCRIPT, ['concurrent'], [10, 1, now / 1000, 1]),
      store.eval(TOKEN_BUCKET_SCRIPT, ['concurrent'], [10, 1, now / 1000, 1]),
    ]);

    // All should execute, though order is not guaranteed in memory store
    expect(results).toHaveLength(3);
    for (const r of results) {
      expect((r as number[])[0]).toBe(1); // all allowed
    }
  });

  it('should handle operations on expired keys as fresh', async () => {
    // Create entry
    await store.eval(TOKEN_BUCKET_SCRIPT, ['expire-test'], [2, 1, now / 1000, 2]);

    // Advance past TTL
    vi.advanceTimersByTime(10000);
    const newNow = now + 10000;

    // Should behave as fresh (full capacity)
    const result = (await store.eval(
      TOKEN_BUCKET_SCRIPT,
      ['expire-test'],
      [2, 1, newNow / 1000, 1],
    )) as number[];
    expect(result[0]).toBe(1); // allowed
    expect(result[1]).toBe(1); // 2 - 1 = 1 (fresh bucket)
  });

  it('should handle many keys (1000+)', async () => {
    for (let i = 0; i < 1000; i++) {
      await store.eval(
        FIXED_WINDOW_SCRIPT,
        [`key-${i}`],
        [10, 60000, now],
      );
    }

    // Verify a specific key still works
    const result = (await store.eval(
      FIXED_WINDOW_SCRIPT,
      ['key-500'],
      [10, 60000, now],
    )) as number[];
    expect(result[0]).toBe(1); // allowed
    expect(result[1]).toBe(8); // 10 - 2 = 8
  });

  it('should maintain store isolation between different algorithm instances', async () => {
    // Use token bucket on key-1
    await store.eval(TOKEN_BUCKET_SCRIPT, ['shared-key-tb'], [5, 1, now / 1000, 5]);

    // Use fixed window on key-2
    await store.eval(FIXED_WINDOW_SCRIPT, ['shared-key-fw'], [3, 10000, now]);

    // Token bucket key should be exhausted
    const tbResult = (await store.eval(
      TOKEN_BUCKET_SCRIPT,
      ['shared-key-tb'],
      [5, 1, now / 1000, 1],
    )) as number[];
    expect(tbResult[0]).toBe(0); // denied

    // Fixed window key should have remaining
    const fwResult = (await store.eval(
      FIXED_WINDOW_SCRIPT,
      ['shared-key-fw'],
      [3, 10000, now],
    )) as number[];
    expect(fwResult[0]).toBe(1); // allowed
    expect(fwResult[1]).toBe(1); // 3 - 2 = 1
  });

  it('should execute sliding window script correctly', async () => {
    const result = (await store.eval(
      SLIDING_WINDOW_SCRIPT,
      ['sw-key'],
      [5, 10000, now, 'req-1'],
    )) as number[];

    expect(result[0]).toBe(1); // allowed
    expect(result[1]).toBe(4); // 5 - 1 = 4
  });

  it('should execute sliding window counter script correctly', async () => {
    const result = (await store.eval(
      SLIDING_WINDOW_COUNTER_SCRIPT,
      ['swc-key'],
      [10, 10000, now],
    )) as number[];

    expect(result[0]).toBe(1); // allowed
    expect(result[1]).toBe(9); // 10 - 1 = 9 (first request reduces by 1)
  });

  it('should handle TTL expiry for sliding window sorted sets', async () => {
    // Add an entry
    await store.eval(SLIDING_WINDOW_SCRIPT, ['sw-ttl'], [5, 1000, now, 'req-1']);

    // Advance past TTL (windowMs + 1000 = 2000)
    vi.advanceTimersByTime(2500);

    const exists = (await store.eval(
      `return redis.call('EXISTS', KEYS[1])`,
      ['sw-ttl'],
      [],
    )) as number;
    expect(exists).toBe(0);
  });

  it('should DEL fixed window counter keys', async () => {
    // Create fixed window counter
    await store.eval(FIXED_WINDOW_SCRIPT, ['fw-del'], [5, 10000, now]);

    // Delete
    await store.eval(`redis.call('DEL', KEYS[1]); return 1`, ['fw-del'], []);

    // Should be fresh
    const result = (await store.eval(
      FIXED_WINDOW_SCRIPT,
      ['fw-del'],
      [5, 10000, now],
    )) as number[];
    expect(result[0]).toBe(1);
    expect(result[1]).toBe(4); // fresh
  });

  it('should handle nowFn override for deterministic testing', async () => {
    let mockTime = 5000;
    const deterministicStore = new MemoryStore({ nowFn: () => mockTime });

    await deterministicStore.eval(
      TOKEN_BUCKET_SCRIPT,
      ['test'],
      [3, 1, mockTime / 1000, 3],
    );

    // Advance mock time
    mockTime = 7000; // 2 seconds later

    const result = (await deterministicStore.eval(
      TOKEN_BUCKET_SCRIPT,
      ['test'],
      [3, 1, mockTime / 1000, 1],
    )) as number[];
    expect(result[0]).toBe(1); // allowed (2 tokens refilled)
    expect(result[1]).toBe(1); // 2 refilled - 1 consumed
  });
});
