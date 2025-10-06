# ADR-002: Algorithm Selection — Four Strategies

## Status

Accepted

## Date

2025-10-06

## Context

Different rate limiting algorithms make fundamentally different trade-offs between accuracy, memory usage, burst handling, and implementation complexity. There is no single "best" algorithm — the right choice depends on the use case.

We surveyed the algorithms commonly used in production rate limiters (Cloudflare, Stripe, GitHub, AWS API Gateway) and identified four that cover the full spectrum of needs.

## Decision

Ship four algorithms, each implemented as both a Redis Lua script and a TypeScript equivalent for in-memory use:

### 1. Fixed Window Counter

- **How it works:** Divide time into fixed windows (e.g., 1-minute intervals). Maintain a single counter per window. Increment on each request, deny if counter exceeds limit. Counter resets at the window boundary.
- **Accuracy:** Low. Allows up to 2x the configured limit at window boundaries (e.g., 100 requests at 0:59 and 100 more at 1:00 = 200 in 2 seconds against a 100/minute limit).
- **Memory:** O(1) per key — one counter plus a TTL.
- **When to use:** Internal services where approximate limiting is acceptable and simplicity matters. Good for monitoring/alerting rather than hard enforcement.

### 2. Sliding Window Log

- **How it works:** Store every request timestamp in a Redis sorted set (ZSET). On each request, remove timestamps outside the window (ZREMRANGEBYSCORE), count remaining entries (ZCARD), and allow if under limit.
- **Accuracy:** Perfect. Every request is tracked individually; there are no boundary effects.
- **Memory:** O(n) per key, where n is the number of requests in the window. For a 1000 req/hour limit, each key stores up to 1000 entries.
- **When to use:** When accuracy is critical and the rate limit is low enough that O(n) memory is acceptable. Good for expensive operations (payments, SMS sends) where even one extra request has real cost.

### 3. Sliding Window Counter (Hybrid)

- **How it works:** Maintain counters for the current and previous fixed windows. Estimate the sliding count by weighting the previous window's count by the proportion of overlap: `weighted = prev_count * (1 - elapsed_ratio) + curr_count`. This interpolates between the two windows for near-accurate results.
- **Accuracy:** Very good. The maximum error is bounded by the proportion of the previous window's traffic that falls in the non-overlapping region. In practice, the error is negligible for most traffic patterns.
- **Memory:** O(1) per key — two counters and a TTL. Same as fixed window.
- **When to use:** The best default for most APIs. Combines the memory efficiency of fixed window with the accuracy approaching sliding window log.

### 4. Token Bucket

- **How it works:** Each key has a bucket with a maximum capacity and a refill rate. Tokens are consumed on each request. Tokens refill at a steady rate over time, capped at capacity. Requests are allowed if sufficient tokens are available.
- **Accuracy:** Exact for burst control. The bucket capacity determines the maximum burst size, and the refill rate determines the sustained throughput.
- **Memory:** O(1) per key — two values (token count, last refill timestamp).
- **When to use:** APIs that want to allow controlled bursts while enforcing a steady average rate. The distinction between "capacity" (burst) and "refillRate" (sustained) is intuitive for API designers.

## Comparison Table

| Algorithm              | Accuracy | Memory   | Burst Handling      | Complexity |
|------------------------|----------|----------|---------------------|------------|
| Fixed Window           | Low      | O(1)     | 2x burst at edges   | Trivial    |
| Sliding Window Log     | Perfect  | O(n)     | No burst allowed    | Low        |
| Sliding Window Counter | High     | O(1)     | Slight edge effect  | Medium     |
| Token Bucket           | Exact    | O(1)     | Controlled bursts   | Medium     |

## Consequences

1. Users choose their algorithm based on their specific requirements. The library does not impose a default but recommends sliding window counter as the best general-purpose choice.
2. All algorithms implement the same `RateLimitResult` return type, making them interchangeable from the middleware's perspective.
3. The token bucket uses a different configuration shape (`TokenBucketConfig` with `capacity` and `refillRate`) than the window-based algorithms (`RateLimiterConfig` with `limit` and `windowMs`). Type guards distinguish them at runtime.
4. The `CompositePolicy` allows combining algorithms — e.g., token bucket for burst control with fixed window for a hard daily cap.
