import type { Store } from './store.js';
import { TOKEN_BUCKET_SCRIPT } from '../core/lua/token-bucket.lua.js';
import { SLIDING_WINDOW_SCRIPT } from '../core/lua/sliding-window.lua.js';
import { SLIDING_WINDOW_COUNTER_SCRIPT } from '../core/lua/sliding-window-counter.lua.js';
import { FIXED_WINDOW_SCRIPT } from '../core/lua/fixed-window.lua.js';

interface MemoryEntry {
  value: unknown;
  expiresAt?: number;
}

/**
 * In-memory store that emulates Redis Lua script semantics in TypeScript.
 * Used for testing and single-instance deployments where Redis is not needed.
 *
 * This does NOT actually interpret Lua. Instead, it recognizes the specific scripts
 * used by each algorithm and executes equivalent TypeScript logic.
 */
export class MemoryStore implements Store {
  private data = new Map<string, MemoryEntry>();
  private hashes = new Map<string, Map<string, string>>();
  private hashExpiry = new Map<string, number>();
  private sortedSets = new Map<string, Map<string, number>>();
  private sortedSetExpiry = new Map<string, number>();
  private counters = new Map<string, { value: number; expiresAt?: number }>();

  /** Override the time source for testing. Returns ms since epoch. */
  public nowFn: () => number = () => Date.now();

  constructor(options?: { nowFn?: () => number }) {
    if (options?.nowFn) {
      this.nowFn = options.nowFn;
    }
  }

  async eval(
    script: string,
    keys: string[],
    args: (string | number)[],
  ): Promise<unknown> {
    this.cleanExpired();

    if (script === TOKEN_BUCKET_SCRIPT) {
      return this.evalTokenBucket(keys[0]!, args);
    }
    if (script === SLIDING_WINDOW_SCRIPT) {
      return this.evalSlidingWindow(keys[0]!, args);
    }
    if (script === SLIDING_WINDOW_COUNTER_SCRIPT) {
      return this.evalSlidingWindowCounter(keys[0]!, args);
    }
    if (script === FIXED_WINDOW_SCRIPT) {
      return this.evalFixedWindow(keys[0]!, args);
    }

    // Handle simple utility scripts
    const trimmed = script.trim();
    if (trimmed.includes("redis.call('DEL'")) {
      const key = keys[0]!;
      this.hashes.delete(key);
      this.hashExpiry.delete(key);
      this.sortedSets.delete(key);
      this.sortedSetExpiry.delete(key);
      // Also delete any fixed-window counter keys
      for (const k of this.counters.keys()) {
        if (k.startsWith(key)) {
          this.counters.delete(k);
        }
      }
      this.data.delete(key);
      return 1;
    }
    if (trimmed.includes("redis.call('EXISTS'")) {
      const key = keys[0]!;
      if (
        this.hashes.has(key) ||
        this.sortedSets.has(key) ||
        this.data.has(key)
      ) {
        return 1;
      }
      return 0;
    }

    throw new Error(`MemoryStore: unrecognized script`);
  }

  async disconnect(): Promise<void> {
    this.data.clear();
    this.hashes.clear();
    this.hashExpiry.clear();
    this.sortedSets.clear();
    this.sortedSetExpiry.clear();
    this.counters.clear();
  }

  private cleanExpired(): void {
    const now = this.nowFn();
    for (const [key, expiresAt] of this.hashExpiry) {
      if (expiresAt <= now) {
        this.hashes.delete(key);
        this.hashExpiry.delete(key);
      }
    }
    for (const [key, expiresAt] of this.sortedSetExpiry) {
      if (expiresAt <= now) {
        this.sortedSets.delete(key);
        this.sortedSetExpiry.delete(key);
      }
    }
    for (const [key, entry] of this.counters) {
      if (entry.expiresAt !== undefined && entry.expiresAt <= now) {
        this.counters.delete(key);
      }
    }
    for (const [key, entry] of this.data) {
      if (entry.expiresAt !== undefined && entry.expiresAt <= now) {
        this.data.delete(key);
      }
    }
  }

  // ── Token Bucket ──────────────────────────────────────────────────────

  private evalTokenBucket(
    key: string,
    args: (string | number)[],
  ): number[] {
    const capacity = Number(args[0]);
    const refillRate = Number(args[1]);
    const now = Number(args[2]); // seconds
    const cost = Number(args[3]);

    let hash = this.hashes.get(key);
    let tokens: number;
    let lastRefill: number;

    if (!hash) {
      tokens = capacity;
      lastRefill = now;
    } else {
      tokens = Number(hash.get('tokens') ?? capacity);
      lastRefill = Number(hash.get('last_refill') ?? now);
    }

    const elapsed = Math.max(0, now - lastRefill);
    tokens = Math.min(capacity, tokens + elapsed * refillRate);

    let allowed = 0;
    let retryAfter = 0;

    if (tokens >= cost) {
      tokens = tokens - cost;
      allowed = 1;
    } else {
      retryAfter = Math.ceil(((cost - tokens) / refillRate) * 1000);
    }

    // Store updated state
    hash = new Map<string, string>();
    hash.set('tokens', String(tokens));
    hash.set('last_refill', String(now));
    this.hashes.set(key, hash);

    const ttlMs = Math.ceil((capacity / refillRate) * 1000) + 1000;
    this.hashExpiry.set(key, this.nowFn() + ttlMs);

    return [allowed, Math.floor(tokens), retryAfter];
  }

  // ── Sliding Window Log ────────────────────────────────────────────────

  private evalSlidingWindow(
    key: string,
    args: (string | number)[],
  ): number[] {
    const limit = Number(args[0]);
    const windowMs = Number(args[1]);
    const now = Number(args[2]); // ms
    const requestId = String(args[3]);

    const windowStart = now - windowMs;

    let zset = this.sortedSets.get(key);
    if (!zset) {
      zset = new Map<string, number>();
      this.sortedSets.set(key, zset);
    }

    // Remove entries outside window
    for (const [member, score] of zset) {
      if (score <= windowStart) {
        zset.delete(member);
      }
    }

    const count = zset.size;
    let allowed = 0;
    let remaining = Math.max(0, limit - count);
    let retryAfter = 0;

    if (count < limit) {
      zset.set(requestId, now);
      allowed = 1;
      remaining = limit - count - 1;
    } else {
      // Find oldest entry
      let oldestTime = Infinity;
      for (const score of zset.values()) {
        if (score < oldestTime) {
          oldestTime = score;
        }
      }
      if (oldestTime !== Infinity) {
        retryAfter = Math.max(0, Math.ceil(oldestTime + windowMs - now));
      }
    }

    this.sortedSetExpiry.set(key, this.nowFn() + windowMs + 1000);

    const resetMs = windowMs;
    return [allowed, remaining, retryAfter, resetMs];
  }

  // ── Sliding Window Counter ────────────────────────────────────────────

  private evalSlidingWindowCounter(
    key: string,
    args: (string | number)[],
  ): number[] {
    const limit = Number(args[0]);
    const windowMs = Number(args[1]);
    const now = Number(args[2]); // ms

    const currentWindow = Math.floor(now / windowMs);
    const currentWindowStart = currentWindow * windowMs;
    const elapsedInWindow = now - currentWindowStart;
    const elapsedRatio = elapsedInWindow / windowMs;

    const prevWindow = currentWindow - 1;
    const currKey = String(currentWindow);
    const prevKey = String(prevWindow);

    let hash = this.hashes.get(key);
    if (!hash) {
      hash = new Map<string, string>();
      this.hashes.set(key, hash);
    }

    const currCount = Number(hash.get(currKey) ?? 0);
    const prevCount = Number(hash.get(prevKey) ?? 0);

    const weighted = prevCount * (1 - elapsedRatio) + currCount;

    let allowed = 0;
    let remaining = Math.max(0, Math.floor(limit - weighted));
    let retryAfter = 0;

    if (weighted < limit) {
      hash.set(currKey, String(currCount + 1));
      allowed = 1;
      remaining = Math.max(0, remaining - 1);

      // Clean old windows
      for (const field of hash.keys()) {
        const fieldNum = Number(field);
        if (!isNaN(fieldNum) && fieldNum < prevWindow) {
          hash.delete(field);
        }
      }
    } else {
      if (prevCount > 0) {
        const neededRatio = (prevCount + currCount - limit) / prevCount;
        if (neededRatio < 1) {
          const neededElapsed = neededRatio * windowMs;
          retryAfter = Math.max(0, Math.ceil(neededElapsed - elapsedInWindow));
        } else {
          retryAfter = Math.ceil(windowMs - elapsedInWindow);
        }
      } else {
        retryAfter = Math.ceil(windowMs - elapsedInWindow);
      }
    }

    const ttlMs = windowMs * 2 + 1000;
    this.hashExpiry.set(key, this.nowFn() + ttlMs);

    const resetMs = Math.ceil(windowMs - elapsedInWindow);

    return [allowed, remaining, retryAfter, resetMs];
  }

  // ── Fixed Window ──────────────────────────────────────────────────────

  private evalFixedWindow(
    key: string,
    args: (string | number)[],
  ): number[] {
    const limit = Number(args[0]);
    const windowMs = Number(args[1]);
    const now = Number(args[2]); // ms

    const currentWindow = Math.floor(now / windowMs);
    const windowKey = `${key}:${currentWindow}`;
    const windowEnd = (currentWindow + 1) * windowMs;

    const counter = this.counters.get(windowKey);
    const count = counter?.value ?? 0;

    let allowed = 0;
    let remaining = Math.max(0, limit - count);
    let retryAfter = 0;
    const resetMs = windowEnd - now;

    if (count < limit) {
      this.counters.set(windowKey, {
        value: count + 1,
        expiresAt: this.nowFn() + resetMs + 1000,
      });
      allowed = 1;
      remaining = limit - count - 1;
    } else {
      retryAfter = resetMs;
    }

    return [allowed, remaining, retryAfter, Math.ceil(resetMs)];
  }
}
