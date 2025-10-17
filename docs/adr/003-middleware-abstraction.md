# ADR-003: Middleware Abstraction

## Status

Accepted

## Date

2025-10-17

## Context

The library needs to support Express, Fastify, and Hono — three frameworks with different request/response models, middleware conventions, and plugin systems:

- **Express:** Middleware signature `(req, res, next) => void`. Headers set via `res.set()`. Responses via `res.status().json()`.
- **Fastify:** Plugin-based. Rate limiting hooks into `onRequest`. Headers via `reply.headers()`. Responses via `reply.code().send()`.
- **Hono:** Middleware returns `Response | void`. Headers via `c.header()`. JSON responses via `c.json()`.

Duplicating the rate limit logic (key extraction, limit checking, header generation, response formatting) in each adapter would create maintenance burden and divergent behavior.

## Decision

Extract all shared logic into a framework-agnostic module (`src/middleware/shared.ts`):

1. **`handleRateLimit(config, req)`** — The core check. Takes a normalized request object and returns the rate limit result plus an optional formatted response. This function handles key generation, policy resolution (simple, tiered, or composite), and the actual rate limit consume call.

2. **`generateHeaders(result)`** — Converts a `RateLimitResult` into IETF-compliant HTTP headers (`X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, `Retry-After`).

3. **`formatRateLimitResponse(result)`** — Produces a standard 429 response body with the appropriate status code, JSON body, and headers.

Each framework adapter is a thin wrapper (under 50 lines) that:
1. Extracts a `KeyGeneratorRequest` from the framework-specific request type
2. Calls `handleRateLimit`
3. Maps the result back to the framework's response API

The `KeyGeneratorRequest` interface is the normalized request shape:
```typescript
interface KeyGeneratorRequest {
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
  userId?: string;
  [key: string]: unknown;
}
```

## Trade-offs

**Benefits:**
- Core logic is implemented and tested once. Framework adapters are so thin they barely need testing beyond integration smoke tests.
- Adding support for a new framework (Koa, h3, etc.) requires only a new adapter file with ~30 lines of mapping code.
- Header format and response body are guaranteed consistent across frameworks.

**Costs:**
- The `KeyGeneratorRequest` abstraction loses some framework-specific information. For example, Express has `req.route`, Fastify has `request.routerPath`. Custom key generators that need this must cast `req` to the framework-specific type.
- The `[key: string]: unknown` index signature on `KeyGeneratorRequest` provides escape-hatch access but sacrifices type safety. This is deliberate — it allows custom key generators to access framework-specific properties without requiring generic type parameters that would complicate the API.

## Consequences

1. All three framework adapters (`express.ts`, `fastify.ts`, `hono.ts`) are under 50 lines and follow the same pattern.
2. The shared module is tested independently with mock requests and responses. Framework-specific tests are minimal integration checks.
3. New framework support is a low-effort task: create a new adapter that maps the framework's request/response types to `KeyGeneratorRequest` and calls `handleRateLimit`.
4. The IETF rate limit header format is defined in exactly one place, ensuring consistency.
