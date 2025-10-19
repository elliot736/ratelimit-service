import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { expressRateLimit } from '../../src/middleware/express.js';
import { RateLimiter } from '../../src/core/limiter.js';
import { MemoryStore } from '../../src/store/memory.js';
import { byIp } from '../../src/keys/key-generator.js';
import type { RateLimitPolicy } from '../../src/policies/policy.js';

describe('Express Middleware', () => {
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

  function mockReq(ip: string = '127.0.0.1') {
    return {
      ip,
      headers: {} as Record<string, string | string[] | undefined>,
    };
  }

  function mockRes() {
    const headers: Record<string, string> = {};
    let statusCode = 200;
    let body: unknown = null;

    return {
      headers,
      statusCode,
      body,
      headersSent: false,
      status(code: number) {
        statusCode = code;
        this.statusCode = code;
        return this;
      },
      json(data: unknown) {
        body = data;
        this.body = data;
        this.headersSent = true;
      },
      set(h: Record<string, string>) {
        Object.assign(headers, h);
      },
    };
  }

  const policy: RateLimitPolicy = {
    name: 'test',
    algorithm: 'fixed-window',
    config: { limit: 3, windowMs: 10000 },
    keyGenerator: byIp,
  };

  it('should set rate limit headers on allowed requests', async () => {
    const middleware = expressRateLimit({ limiter, policy });
    const req = mockReq();
    const res = mockRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(res.headers['X-RateLimit-Limit']).toBe('3');
    expect(res.headers['X-RateLimit-Remaining']).toBe('2');
    expect(res.headers['X-RateLimit-Reset']).toBeDefined();
    expect(next).toHaveBeenCalled();
  });

  it('should return 429 when rate limited', async () => {
    const middleware = expressRateLimit({ limiter, policy });
    const req = mockReq();
    const next = vi.fn();

    for (let i = 0; i < 3; i++) {
      const res = mockRes();
      await middleware(req, res, next);
    }

    const res = mockRes();
    await middleware(req, res, next);

    expect(res.statusCode).toBe(429);
    expect(res.body).toHaveProperty('error', 'Too Many Requests');
    expect(res.headers['Retry-After']).toBeDefined();
  });

  it('should call onRateLimited when denied', async () => {
    const onRateLimited = vi.fn();
    const middleware = expressRateLimit({ limiter, policy, onRateLimited });
    const req = mockReq();
    const next = vi.fn();

    for (let i = 0; i < 3; i++) {
      await middleware(req, mockRes(), next);
    }

    await middleware(req, mockRes(), next);

    expect(onRateLimited).toHaveBeenCalledOnce();
    expect(onRateLimited.mock.calls[0]![1]).toHaveProperty('allowed', false);
  });

  it('should skip rate limiting when skip returns true', async () => {
    const middleware = expressRateLimit({
      limiter,
      policy,
      skip: () => true,
    });
    const req = mockReq();
    const res = mockRes();
    const next = vi.fn();

    await middleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('should attach result to request when requestPropertyName is set', async () => {
    const middleware = expressRateLimit({
      limiter,
      policy,
      requestPropertyName: 'rateLimit',
    });
    const req = mockReq() as Record<string, unknown>;
    const res = mockRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(req['rateLimit']).toBeDefined();
    expect(req['rateLimit']).toHaveProperty('allowed', true);
  });

  it('should differentiate by IP', async () => {
    const middleware = expressRateLimit({ limiter, policy });
    const next = vi.fn();

    for (let i = 0; i < 3; i++) {
      await middleware(mockReq('1.1.1.1'), mockRes(), next);
    }

    const res = mockRes();
    await middleware(mockReq('2.2.2.2'), res, next);
    expect(res.headers['X-RateLimit-Remaining']).toBe('2');
  });

  // --- New comprehensive tests ---

  it('should include all required IETF headers on allowed requests', async () => {
    const middleware = expressRateLimit({ limiter, policy });
    const req = mockReq();
    const res = mockRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(res.headers).toHaveProperty('X-RateLimit-Limit');
    expect(res.headers).toHaveProperty('X-RateLimit-Remaining');
    expect(res.headers).toHaveProperty('X-RateLimit-Reset');
    expect(res.headers).not.toHaveProperty('Retry-After');
  });

  it('should include Retry-After header on 429 responses', async () => {
    const middleware = expressRateLimit({ limiter, policy });
    const req = mockReq();
    const next = vi.fn();

    for (let i = 0; i < 3; i++) {
      await middleware(req, mockRes(), next);
    }

    const res = mockRes();
    await middleware(req, res, next);

    expect(res.headers['Retry-After']).toBeDefined();
    expect(parseInt(res.headers['Retry-After']!)).toBeGreaterThan(0);
  });

  it('should have correct 429 response body format', async () => {
    const middleware = expressRateLimit({ limiter, policy });
    const req = mockReq();
    const next = vi.fn();

    for (let i = 0; i < 3; i++) {
      await middleware(req, mockRes(), next);
    }

    const res = mockRes();
    await middleware(req, res, next);

    expect(res.body).toHaveProperty('error', 'Too Many Requests');
    expect(res.body).toHaveProperty('message');
    expect(res.body).toHaveProperty('retryAfterMs');
    expect((res.body as Record<string, unknown>)['retryAfterMs']).toBeTypeOf('number');
  });

  it('should use custom key generator from middleware config', async () => {
    let keyGenCalled = false;
    const customKeyGen = (req: { ip?: string; headers: Record<string, string | string[] | undefined>; [k: string]: unknown }) => {
      keyGenCalled = true;
      return `custom:${req.ip ?? 'none'}`;
    };

    const middleware = expressRateLimit({
      limiter,
      policy,
      keyGenerator: customKeyGen,
    });
    const req = mockReq();
    const res = mockRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(keyGenCalled).toBe(true);
    expect(next).toHaveBeenCalled();
  });

  it('should successfully return 200-level responses with limit headers', async () => {
    const middleware = expressRateLimit({ limiter, policy });
    const req = mockReq();
    const res = mockRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    // Headers set but status not explicitly set to 429
    expect(res.statusCode).toBe(200);
    expect(res.headers['X-RateLimit-Limit']).toBe('3');
  });

  it('should call next with error when middleware throws', async () => {
    const errorStore = {
      eval: vi.fn().mockRejectedValue(new Error('store error')),
      disconnect: vi.fn(),
    };
    const errorLimiter = new RateLimiter({
      store: errorStore,
      algorithm: 'fixed-window',
      nowFn: () => Date.now(),
    });

    const middleware = expressRateLimit({ limiter: errorLimiter, policy });
    const req = mockReq();
    const res = mockRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  it('should not call next when rate limited (no double response)', async () => {
    const middleware = expressRateLimit({ limiter, policy });
    const req = mockReq();
    const next = vi.fn();

    // Exhaust limit
    for (let i = 0; i < 3; i++) {
      await middleware(req, mockRes(), next);
    }

    const nextForDenied = vi.fn();
    const res = mockRes();
    await middleware(req, res, nextForDenied);

    // next should NOT be called when rate limited
    expect(nextForDenied).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(429);
  });

  it('should handle x-forwarded-for header for IP extraction', async () => {
    const middleware = expressRateLimit({ limiter, policy });
    const next = vi.fn();

    const req = {
      ip: '10.0.0.1',
      headers: { 'x-forwarded-for': '203.0.113.50' } as Record<string, string | string[] | undefined>,
    };

    const res = mockRes();
    await middleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });
});
