import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { fastifyRateLimit } from '../../src/middleware/fastify.js';
import { RateLimiter } from '../../src/core/limiter.js';
import { MemoryStore } from '../../src/store/memory.js';
import { byIp } from '../../src/keys/key-generator.js';
import type { RateLimitPolicy } from '../../src/policies/policy.js';

describe('Fastify Middleware', () => {
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

  function createMockFastify() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let hookFn: ((...args: any[]) => any) | null = null;
    const fastifyInstance = {
      addHook(name: string, handler: (...args: unknown[]) => unknown) {
        if (name === 'onRequest') {
          hookFn = handler as typeof hookFn;
        }
      },
    };
    return { fastifyInstance, getHook: () => hookFn };
  }

  function createMockReply() {
    const headersSet: Record<string, string> = {};
    let sentCode: number | null = null;
    let sentBody: unknown = null;

    const reply = {
      code(c: number) { sentCode = c; return reply; },
      headers(h: Record<string, string>) { Object.assign(headersSet, h); return reply; },
      send(body: unknown) { sentBody = body; return reply; },
    };

    return { reply, headersSet, getSentCode: () => sentCode, getSentBody: () => sentBody };
  }

  it('should register as a Fastify plugin with onRequest hook', async () => {
    const plugin = fastifyRateLimit({ limiter, policy });
    const { fastifyInstance, getHook } = createMockFastify();

    await plugin(fastifyInstance as never, {});
    expect(getHook()).not.toBeNull();
  });

  it('should set rate limit headers via the hook', async () => {
    const plugin = fastifyRateLimit({ limiter, policy });
    const { fastifyInstance, getHook } = createMockFastify();

    await plugin(fastifyInstance as never, {});

    const request = { ip: '127.0.0.1', headers: {} };
    const { reply, headersSet, getSentCode, getSentBody } = createMockReply();

    await getHook()!(request, reply);

    expect(headersSet['X-RateLimit-Limit']).toBe('3');
    expect(headersSet['X-RateLimit-Remaining']).toBe('2');
    expect(getSentCode()).toBeNull();
    expect(getSentBody()).toBeNull();
  });

  it('should respond with 429 when rate limited', async () => {
    const plugin = fastifyRateLimit({ limiter, policy });
    const { fastifyInstance, getHook } = createMockFastify();

    await plugin(fastifyInstance as never, {});

    const request = { ip: '127.0.0.1', headers: {} };

    // Exhaust limit
    for (let i = 0; i < 3; i++) {
      const { reply } = createMockReply();
      await getHook()!(request, reply);
    }

    // 4th should be denied
    const { reply, getSentCode, getSentBody } = createMockReply();
    await getHook()!(request, reply);

    expect(getSentCode()).toBe(429);
    expect(getSentBody()).toHaveProperty('error', 'Too Many Requests');
  });

  // --- New comprehensive tests ---

  it('should register onRequest hook specifically', async () => {
    const plugin = fastifyRateLimit({ limiter, policy });
    const hooks: string[] = [];

    const fastifyInstance = {
      addHook(name: string, _handler: (...args: unknown[]) => unknown) {
        hooks.push(name);
      },
    };

    await plugin(fastifyInstance as never, {});
    expect(hooks).toContain('onRequest');
    expect(hooks).toHaveLength(1);
  });

  it('should include all IETF headers on 429 response', async () => {
    const plugin = fastifyRateLimit({ limiter, policy });
    const { fastifyInstance, getHook } = createMockFastify();

    await plugin(fastifyInstance as never, {});

    const request = { ip: '127.0.0.1', headers: {} };

    for (let i = 0; i < 3; i++) {
      const { reply } = createMockReply();
      await getHook()!(request, reply);
    }

    const { reply, headersSet } = createMockReply();
    await getHook()!(request, reply);

    expect(headersSet['X-RateLimit-Limit']).toBeDefined();
    expect(headersSet['X-RateLimit-Remaining']).toBe('0');
    expect(headersSet['Retry-After']).toBeDefined();
  });

  it('should attach result to request when requestPropertyName is set', async () => {
    const plugin = fastifyRateLimit({
      limiter,
      policy,
      requestPropertyName: 'rateLimit',
    });
    const { fastifyInstance, getHook } = createMockFastify();

    await plugin(fastifyInstance as never, {});

    const request: Record<string, unknown> = { ip: '127.0.0.1', headers: {} };
    const { reply } = createMockReply();

    await getHook()!(request, reply);

    expect(request['rateLimit']).toBeDefined();
    expect(request['rateLimit']).toHaveProperty('allowed', true);
  });

  it('should differentiate by IP', async () => {
    const plugin = fastifyRateLimit({ limiter, policy });
    const { fastifyInstance, getHook } = createMockFastify();

    await plugin(fastifyInstance as never, {});

    // Exhaust limit for IP 1
    for (let i = 0; i < 3; i++) {
      const { reply } = createMockReply();
      await getHook()!({ ip: '1.1.1.1', headers: {} }, reply);
    }

    // IP 2 should still have capacity
    const { reply, headersSet } = createMockReply();
    await getHook()!({ ip: '2.2.2.2', headers: {} }, reply);
    expect(headersSet['X-RateLimit-Remaining']).toBe('2');
  });

  it('should handle 429 response body format correctly', async () => {
    const plugin = fastifyRateLimit({ limiter, policy });
    const { fastifyInstance, getHook } = createMockFastify();

    await plugin(fastifyInstance as never, {});

    const request = { ip: '127.0.0.1', headers: {} };

    for (let i = 0; i < 3; i++) {
      const { reply } = createMockReply();
      await getHook()!(request, reply);
    }

    const { reply, getSentBody } = createMockReply();
    await getHook()!(request, reply);

    const body = getSentBody() as Record<string, unknown>;
    expect(body['error']).toBe('Too Many Requests');
    expect(body['message']).toBeDefined();
    expect(body['retryAfterMs']).toBeTypeOf('number');
  });
});
