# ADR-005: Failure Modes — Fail Open vs. Fail Closed

## Status

Accepted

## Date

2025-10-20

## Context

Redis is a network service. It can become unavailable due to:

- Network partitions between the application and Redis
- Redis server crashes or restarts
- Memory exhaustion causing Redis to reject writes
- Managed Redis maintenance windows (ElastiCache, Upstash)
- DNS resolution failures

When Redis is unavailable, the rate limiter cannot check or update state. The library must decide what to do with incoming requests: allow them (fail open) or deny them (fail closed).

This is not an edge case. Any service running long enough will experience Redis unavailability. The failure mode is a critical design decision that affects both availability and security.

## Decision

Default to **fail-open** with configurable behavior via a `failMode: "open" | "closed"` option on the Redis store.

### Fail Open (Default)

When Redis is unavailable, **allow all requests** and emit an error event. The application continues to serve traffic, but rate limits are not enforced during the outage.

```typescript
const store = new RedisStore({
  url: 'redis://localhost:6379',
  failMode: 'open', // default
});
```

When an EVAL call fails due to a connection error, the store returns a permissive result (allowed: true, remaining: high number) instead of throwing.

### Fail Closed

When Redis is unavailable, **deny all requests** by re-throwing the connection error. The middleware catches this and returns a 503 (Service Unavailable) or lets the application's error handler decide.

```typescript
const store = new RedisStore({
  url: 'redis://localhost:6379',
  failMode: 'closed',
});
```

### Event Emission

Regardless of fail mode, the store emits events for monitoring:

- `error` — Emitted when a Redis operation fails. Includes the original error.
- `reconnect` — Emitted when ioredis begins a reconnection attempt.

Applications should subscribe to these events and alert operators:

```typescript
store.on('error', (err) => {
  logger.error('Rate limiter Redis error', err);
  metrics.increment('ratelimit.redis.error');
});
```

## Trade-offs

### Fail Open

**Benefits:**
- Application remains available during Redis outages. Users experience no downtime.
- For most APIs, a brief period of traffic above the configured limit is less damaging than total downtime.
- Aligns with the principle that rate limiting is a protective measure, not a correctness requirement.

**Costs:**
- During outage, all rate limits are effectively disabled. A malicious actor could exploit this window.
- If the outage is prolonged, the lack of rate limiting could cascade into downstream service overload.

### Fail Closed

**Benefits:**
- No traffic exceeds the limit, even during outages. Strong security guarantee.
- Forces fast detection and resolution of Redis issues (because the impact is immediate and visible).

**Costs:**
- Redis outage becomes an application outage. A rate limiter meant to protect the system now causes downtime.
- Effectively a self-imposed denial-of-service if Redis goes down.
- Requires extremely high Redis availability (which is expensive and operationally complex).

## Why Fail Open is the Default

For most web APIs, the cost of briefly allowing extra traffic is low: endpoints are designed to handle some degree of overload, backend services have their own protection mechanisms, and the burst during a Redis blip is short-lived.

In contrast, failing closed means that a Redis restart (which could be a routine maintenance event) blocks all API traffic. This is disproportionate to the risk.

Applications with strict security requirements (e.g., authentication endpoints, payment processing) should explicitly opt into `failMode: "closed"` and invest in Redis high availability (Sentinel or Cluster).

## Consequences

1. The `RedisStore` catches connection errors during `eval()` and checks `failMode` to decide behavior.
2. Fail-open returns `[1, 999, 0, 0]` (allowed, high remaining, no retry, no reset) — a permissive default.
3. Fail-closed re-throws the error, leaving it to the middleware or application error handler.
4. Events are emitted regardless of fail mode, enabling monitoring and alerting.
5. The `MemoryStore` never fails (it is in-process), so fail mode only applies to `RedisStore`.
6. Documentation recommends fail-open as the default and explains when fail-closed is appropriate.
