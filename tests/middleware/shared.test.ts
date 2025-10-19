import { describe, it, expect } from 'vitest';
import { generateHeaders, formatRateLimitResponse } from '../../src/middleware/shared.js';
import type { RateLimitResult } from '../../src/core/types.js';

describe('Shared Middleware Logic', () => {
  describe('generateHeaders', () => {
    it('should generate IETF-compliant rate limit headers for allowed requests', () => {
      const result: RateLimitResult = {
        allowed: true,
        limit: 100,
        remaining: 99,
        resetMs: 60000,
      };

      const headers = generateHeaders(result);

      expect(headers['X-RateLimit-Limit']).toBe('100');
      expect(headers['X-RateLimit-Remaining']).toBe('99');
      expect(headers['X-RateLimit-Reset']).toBe('60');
      expect(headers['Retry-After']).toBeUndefined();
    });

    it('should include Retry-After header for denied requests', () => {
      const result: RateLimitResult = {
        allowed: false,
        limit: 100,
        remaining: 0,
        resetMs: 60000,
        retryAfterMs: 30000,
      };

      const headers = generateHeaders(result);

      expect(headers['X-RateLimit-Limit']).toBe('100');
      expect(headers['X-RateLimit-Remaining']).toBe('0');
      expect(headers['X-RateLimit-Reset']).toBe('60');
      expect(headers['Retry-After']).toBe('30');
    });

    it('should ceil the reset and retry-after to whole seconds', () => {
      const result: RateLimitResult = {
        allowed: false,
        limit: 10,
        remaining: 0,
        resetMs: 1500,
        retryAfterMs: 2500,
      };

      const headers = generateHeaders(result);

      expect(headers['X-RateLimit-Reset']).toBe('2');
      expect(headers['Retry-After']).toBe('3');
    });

    // --- New tests ---

    it('should handle remaining=0 correctly', () => {
      const result: RateLimitResult = {
        allowed: true,
        limit: 1,
        remaining: 0,
        resetMs: 5000,
      };

      const headers = generateHeaders(result);
      expect(headers['X-RateLimit-Remaining']).toBe('0');
      expect(headers['Retry-After']).toBeUndefined(); // still allowed
    });

    it('should handle resetMs=0 by returning reset of 0', () => {
      const result: RateLimitResult = {
        allowed: true,
        limit: 100,
        remaining: 99,
        resetMs: 0,
      };

      const headers = generateHeaders(result);
      expect(headers['X-RateLimit-Reset']).toBe('0');
    });

    it('should not include Retry-After when allowed even if retryAfterMs is present', () => {
      const result: RateLimitResult = {
        allowed: true,
        limit: 10,
        remaining: 5,
        resetMs: 3000,
      };

      const headers = generateHeaders(result);
      expect(headers['Retry-After']).toBeUndefined();
    });

    it('should handle very large limit values', () => {
      const result: RateLimitResult = {
        allowed: true,
        limit: 1000000,
        remaining: 999999,
        resetMs: 3600000,
      };

      const headers = generateHeaders(result);
      expect(headers['X-RateLimit-Limit']).toBe('1000000');
      expect(headers['X-RateLimit-Remaining']).toBe('999999');
      expect(headers['X-RateLimit-Reset']).toBe('3600');
    });

    it('should ceil sub-second resetMs to 1', () => {
      const result: RateLimitResult = {
        allowed: true,
        limit: 10,
        remaining: 9,
        resetMs: 100, // 100ms
      };

      const headers = generateHeaders(result);
      expect(headers['X-RateLimit-Reset']).toBe('1'); // ceil(0.1)
    });
  });

  describe('formatRateLimitResponse', () => {
    it('should return a 429 response with proper body and headers', () => {
      const result: RateLimitResult = {
        allowed: false,
        limit: 100,
        remaining: 0,
        resetMs: 60000,
        retryAfterMs: 30000,
      };

      const response = formatRateLimitResponse(result);

      expect(response.status).toBe(429);
      expect(response.body.error).toBe('Too Many Requests');
      expect(response.body.message).toContain('30 seconds');
      expect(response.body.retryAfterMs).toBe(30000);
      expect(response.headers['X-RateLimit-Limit']).toBe('100');
      expect(response.headers['Retry-After']).toBe('30');
    });

    it('should handle zero retry-after', () => {
      const result: RateLimitResult = {
        allowed: false,
        limit: 10,
        remaining: 0,
        resetMs: 5000,
        retryAfterMs: 0,
      };

      const response = formatRateLimitResponse(result);

      expect(response.body.retryAfterMs).toBe(0);
    });

    // --- New tests ---

    it('should handle missing retryAfterMs gracefully', () => {
      const result: RateLimitResult = {
        allowed: false,
        limit: 10,
        remaining: 0,
        resetMs: 5000,
      };

      const response = formatRateLimitResponse(result);

      expect(response.body.retryAfterMs).toBe(0);
      expect(response.body.message).toContain('0 seconds');
    });

    it('should always return status 429', () => {
      const result: RateLimitResult = {
        allowed: false,
        limit: 50,
        remaining: 0,
        resetMs: 10000,
        retryAfterMs: 5000,
      };

      const response = formatRateLimitResponse(result);
      expect(response.status).toBe(429);
    });

    it('should include all required response fields', () => {
      const result: RateLimitResult = {
        allowed: false,
        limit: 100,
        remaining: 0,
        resetMs: 60000,
        retryAfterMs: 15000,
      };

      const response = formatRateLimitResponse(result);

      expect(response).toHaveProperty('status');
      expect(response).toHaveProperty('body');
      expect(response).toHaveProperty('headers');
      expect(response.body).toHaveProperty('error');
      expect(response.body).toHaveProperty('message');
      expect(response.body).toHaveProperty('retryAfterMs');
    });
  });
});
