import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { honoRateLimit } from '../../src/middleware/hono.js';
import { RateLimiter } from '../../src/core/limiter.js';
import { MemoryStore } from '../../src/store/memory.js';
import { byIp } from '../../src/keys/key-generator.js';
import type { RateLimitPolicy } from '../../src/policies/policy.js';

describe('Hono Middleware', () => {
  let store: MemoryStore;
  let limiter: RateLimiter;
  let now: number;

  beforeEach(() => {
    vi.useFakeTimers();
    now = 1000000;
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

  const policy: RateLimitPolicy = {
    name: 'test',
    algorithm: 'fixed-window',
    config: { limit: 3, windowMs: 10000 },
    keyGenerator: byIp,
  };

  function mockHonoContext(ip: string = '127.0.0.1') {
    const responseHeaders: Record<string, string> = {};
    const contextStore: Record<string, unknown> = {};
    let jsonResponse: { body: unknown; status: number } | null = null;

    const headers = new Map<string, string>();
    headers.set('x-forwarded-for', ip);

    return {
      context: {
        req: {
          header(name: string) {
            return headers.get(name.toLowerCase());
          },
          raw: {
            headers: {
              forEach(cb: (value: string, key: string) => void) {
                headers.forEach((v, k) => cb(v, k));
              },
            },
          },
        },
        header(name: string, value: string) {
          responseHeaders[name] = value;
        },
        json(body: unknown, status?: number) {
          jsonResponse = { body, status: status ?? 200 };
          return new Response(JSON.stringify(body), { status: status ?? 200 });
        },
        set(key: string, value: unknown) {
          contextStore[key] = value;
        },
        get(key: string) {
          return contextStore[key];
        },
      },
      responseHeaders,
      contextStore,
      getJsonResponse: () => jsonResponse,
    };
  }

  it('should set rate limit headers on allowed requests', async () => {
    const middleware = honoRateLimit({ limiter, policy });
    const { context, responseHeaders } = mockHonoContext();
    const next = vi.fn().mockResolvedValue(undefined);

    await middleware(context as never, next);

    expect(responseHeaders['X-RateLimit-Limit']).toBe('3');
    expect(responseHeaders['X-RateLimit-Remaining']).toBe('2');
    expect(next).toHaveBeenCalled();
  });

  it('should return 429 response when rate limited', async () => {
    const middleware = honoRateLimit({ limiter, policy });
    const next = vi.fn().mockResolvedValue(undefined);

    for (let i = 0; i < 3; i++) {
      const { context } = mockHonoContext();
      await middleware(context as never, next);
    }

    const { context, getJsonResponse } = mockHonoContext();
    const result = await middleware(context as never, next);

    const jsonResp = getJsonResponse();
    expect(jsonResp).not.toBeNull();
    expect(jsonResp!.status).toBe(429);
    expect(jsonResp!.body).toHaveProperty('error', 'Too Many Requests');
    expect(result).toBeInstanceOf(Response);
  });

  it('should set result in context store when requestPropertyName is set', async () => {
    const middleware = honoRateLimit({
      limiter,
      policy,
      requestPropertyName: 'rateLimit',
    });
    const { context, contextStore } = mockHonoContext();
    const next = vi.fn().mockResolvedValue(undefined);

    await middleware(context as never, next);

    expect(contextStore['rateLimit']).toBeDefined();
    expect(contextStore['rateLimit']).toHaveProperty('allowed', true);
  });

  // --- New comprehensive tests ---

  it('should set all IETF headers on response', async () => {
    const middleware = honoRateLimit({ limiter, policy });
    const { context, responseHeaders } = mockHonoContext();
    const next = vi.fn().mockResolvedValue(undefined);

    await middleware(context as never, next);

    expect(responseHeaders).toHaveProperty('X-RateLimit-Limit');
    expect(responseHeaders).toHaveProperty('X-RateLimit-Remaining');
    expect(responseHeaders).toHaveProperty('X-RateLimit-Reset');
    expect(responseHeaders).not.toHaveProperty('Retry-After');
  });

  it('should include Retry-After on 429', async () => {
    const middleware = honoRateLimit({ limiter, policy });
    const next = vi.fn().mockResolvedValue(undefined);

    for (let i = 0; i < 3; i++) {
      const { context } = mockHonoContext();
      await middleware(context as never, next);
    }

    const { context, responseHeaders } = mockHonoContext();
    await middleware(context as never, next);

    expect(responseHeaders['Retry-After']).toBeDefined();
  });

  it('should return JSON response body on 429', async () => {
    const middleware = honoRateLimit({ limiter, policy });
    const next = vi.fn().mockResolvedValue(undefined);

    for (let i = 0; i < 3; i++) {
      const { context } = mockHonoContext();
      await middleware(context as never, next);
    }

    const { context, getJsonResponse } = mockHonoContext();
    await middleware(context as never, next);

    const body = getJsonResponse()!.body as Record<string, unknown>;
    expect(body['error']).toBe('Too Many Requests');
    expect(body['message']).toBeTypeOf('string');
    expect(body['retryAfterMs']).toBeTypeOf('number');
  });

  it('should call next() when request is allowed (middleware chain continues)', async () => {
    const middleware = honoRateLimit({ limiter, policy });
    const { context } = mockHonoContext();
    const next = vi.fn().mockResolvedValue(undefined);

    const result = await middleware(context as never, next);

    expect(next).toHaveBeenCalledOnce();
    expect(result).toBeUndefined(); // No Response returned = continue chain
  });

  it('should not call next() when rate limited', async () => {
    const middleware = honoRateLimit({ limiter, policy });

    for (let i = 0; i < 3; i++) {
      const { context } = mockHonoContext();
      const next = vi.fn().mockResolvedValue(undefined);
      await middleware(context as never, next);
    }

    const { context } = mockHonoContext();
    const next = vi.fn().mockResolvedValue(undefined);
    await middleware(context as never, next);

    // next should have been called 3 times for allowed, but not for the denied request
    expect(next).not.toHaveBeenCalled();
  });

  it('should differentiate by IP via x-forwarded-for', async () => {
    const middleware = honoRateLimit({ limiter, policy });
    const next = vi.fn().mockResolvedValue(undefined);

    // Exhaust limit for IP 1
    for (let i = 0; i < 3; i++) {
      const { context } = mockHonoContext('1.1.1.1');
      await middleware(context as never, next);
    }

    // IP 2 should still have capacity
    const { context, responseHeaders } = mockHonoContext('2.2.2.2');
    await middleware(context as never, next);
    expect(responseHeaders['X-RateLimit-Remaining']).toBe('2');
  });

  it('should handle skip function', async () => {
    const middleware = honoRateLimit({
      limiter,
      policy,
      skip: () => true,
    });
    const { context } = mockHonoContext();
    const next = vi.fn().mockResolvedValue(undefined);

    await middleware(context as never, next);
    expect(next).toHaveBeenCalled();
  });
});
