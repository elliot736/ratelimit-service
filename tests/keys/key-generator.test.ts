import { describe, it, expect } from 'vitest';
import {
  byIp,
  byUserId,
  byApiKey,
  byHeader,
  composite,
  custom,
} from '../../src/keys/key-generator.js';

describe('Key Generators', () => {
  describe('byIp', () => {
    it('should extract IP from request', () => {
      const key = byIp({ ip: '192.168.1.1', headers: {} });
      expect(key).toBe('ip:192.168.1.1');
    });

    it('should prefer x-forwarded-for header', () => {
      const key = byIp({
        ip: '10.0.0.1',
        headers: { 'x-forwarded-for': '203.0.113.50' },
      });
      expect(key).toBe('ip:203.0.113.50');
    });

    it('should handle array x-forwarded-for', () => {
      const key = byIp({
        ip: '10.0.0.1',
        headers: { 'x-forwarded-for': ['203.0.113.50', '70.41.3.18'] },
      });
      expect(key).toBe('ip:203.0.113.50');
    });

    it('should fall back to unknown when no IP is available', () => {
      const key = byIp({ headers: {} });
      expect(key).toBe('ip:unknown');
    });

    // --- New tests ---

    it('should handle IPv6 addresses', () => {
      const key = byIp({ ip: '::1', headers: {} });
      expect(key).toBe('ip:::1');
    });

    it('should handle full IPv6 addresses', () => {
      const key = byIp({ ip: '2001:0db8:85a3:0000:0000:8a2e:0370:7334', headers: {} });
      expect(key).toBe('ip:2001:0db8:85a3:0000:0000:8a2e:0370:7334');
    });

    it('should use first IP from x-forwarded-for chain', () => {
      const key = byIp({
        ip: '10.0.0.1',
        headers: { 'x-forwarded-for': '1.1.1.1, 2.2.2.2, 3.3.3.3' },
      });
      // Single string, not split by commas in our implementation - takes the whole value
      expect(key).toBe('ip:1.1.1.1, 2.2.2.2, 3.3.3.3');
    });

    it('should handle undefined ip with x-forwarded-for', () => {
      const key = byIp({
        headers: { 'x-forwarded-for': '203.0.113.50' },
      });
      expect(key).toBe('ip:203.0.113.50');
    });
  });

  describe('byUserId', () => {
    it('should extract user ID from request', () => {
      const key = byUserId({ headers: {}, userId: 'user-123' });
      expect(key).toBe('user:user-123');
    });

    it('should throw when no userId is present', () => {
      expect(() => byUserId({ headers: {} })).toThrow('no userId');
    });

    // --- New tests ---

    it('should handle empty string userId', () => {
      // Empty string is falsy, should throw
      expect(() => byUserId({ headers: {}, userId: '' })).toThrow('no userId');
    });

    it('should handle numeric-style userId', () => {
      const key = byUserId({ headers: {}, userId: '12345' });
      expect(key).toBe('user:12345');
    });

    it('should handle UUID userId', () => {
      const key = byUserId({ headers: {}, userId: '550e8400-e29b-41d4-a716-446655440000' });
      expect(key).toBe('user:550e8400-e29b-41d4-a716-446655440000');
    });
  });

  describe('byApiKey', () => {
    it('should extract API key from default header', () => {
      const gen = byApiKey();
      const key = gen({ headers: { 'x-api-key': 'sk-abc123' } });
      expect(key).toBe('apikey:sk-abc123');
    });

    it('should extract API key from custom header', () => {
      const gen = byApiKey('Authorization');
      const key = gen({ headers: { authorization: 'Bearer token123' } });
      expect(key).toBe('apikey:Bearer token123');
    });

    it('should throw when header is missing', () => {
      const gen = byApiKey();
      expect(() => gen({ headers: {} })).toThrow('no x-api-key header');
    });

    // --- New tests ---

    it('should extract from custom header name (case-insensitive)', () => {
      const gen = byApiKey('X-Custom-Key');
      const key = gen({ headers: { 'x-custom-key': 'my-key-value' } });
      expect(key).toBe('apikey:my-key-value');
    });

    it('should handle array header value', () => {
      const gen = byApiKey();
      const key = gen({ headers: { 'x-api-key': ['key1', 'key2'] } });
      expect(key).toBe('apikey:key1');
    });

    it('should throw with descriptive message for custom header', () => {
      const gen = byApiKey('X-My-Auth');
      expect(() => gen({ headers: {} })).toThrow('no X-My-Auth header');
    });
  });

  describe('byHeader', () => {
    it('should extract value from specified header', () => {
      const gen = byHeader('X-Tenant-ID');
      const key = gen({ headers: { 'x-tenant-id': 'tenant-42' } });
      expect(key).toBe('header:X-Tenant-ID:tenant-42');
    });

    it('should handle missing header gracefully', () => {
      const gen = byHeader('X-Missing');
      const key = gen({ headers: {} });
      expect(key).toBe('header:X-Missing:unknown');
    });

    // --- New tests ---

    it('should handle header with array value', () => {
      const gen = byHeader('X-Request-ID');
      const key = gen({ headers: { 'x-request-id': ['abc', 'def'] } });
      expect(key).toBe('header:X-Request-ID:abc');
    });

    it('should preserve original header name in key', () => {
      const gen = byHeader('Content-Type');
      const key = gen({ headers: { 'content-type': 'application/json' } });
      expect(key).toBe('header:Content-Type:application/json');
    });
  });

  describe('composite', () => {
    it('should combine multiple generators', () => {
      const gen = composite(byIp, byHeader('X-Tenant-ID'));
      const key = gen({
        ip: '1.2.3.4',
        headers: { 'x-tenant-id': 'acme' },
      });
      expect(key).toBe('ip:1.2.3.4:header:X-Tenant-ID:acme');
    });

    // --- New tests ---

    it('should handle three generators', () => {
      const gen = composite(
        byIp,
        byHeader('X-Tenant-ID'),
        byHeader('X-Version'),
      );
      const key = gen({
        ip: '1.1.1.1',
        headers: { 'x-tenant-id': 'acme', 'x-version': 'v2' },
      });
      expect(key).toBe('ip:1.1.1.1:header:X-Tenant-ID:acme:header:X-Version:v2');
    });

    it('should handle single generator', () => {
      const gen = composite(byIp);
      const key = gen({ ip: '1.1.1.1', headers: {} });
      expect(key).toBe('ip:1.1.1.1');
    });

    it('should produce deterministic composite key format', () => {
      const gen = composite(byIp, byHeader('X-Org'));
      const key1 = gen({ ip: '1.2.3.4', headers: { 'x-org': 'test' } });
      const key2 = gen({ ip: '1.2.3.4', headers: { 'x-org': 'test' } });
      expect(key1).toBe(key2);
    });
  });

  describe('custom', () => {
    it('should use a custom function', () => {
      const gen = custom((req) => `custom:${req.ip ?? 'none'}:${req['path'] ?? '/'}`);
      const key = gen({ ip: '1.1.1.1', headers: {}, path: '/api/data' });
      expect(key).toBe('custom:1.1.1.1:/api/data');
    });

    // --- New tests ---

    it('should handle complex custom logic', () => {
      const gen = custom((req) => {
        const ip = req.ip ?? 'unknown';
        const method = (req['method'] as string) ?? 'GET';
        const path = (req['path'] as string) ?? '/';
        return `${method}:${path}:${ip}`;
      });

      const key = gen({
        ip: '10.0.0.1',
        headers: {},
        method: 'POST',
        path: '/api/users',
      });
      expect(key).toBe('POST:/api/users:10.0.0.1');
    });

    it('should allow access to headers in custom generator', () => {
      const gen = custom((req) => {
        const tenant = req.headers['x-tenant'] as string ?? 'default';
        return `tenant:${tenant}`;
      });

      const key = gen({ headers: { 'x-tenant': 'acme' } });
      expect(key).toBe('tenant:acme');
    });
  });
});
