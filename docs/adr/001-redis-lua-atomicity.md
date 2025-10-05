# ADR-001: Redis Lua Scripts for Atomicity

## Status

Accepted

## Date

2025-10-05

## Context

Rate limiting requires atomic check-and-update operations. A rate limiter must read the current count (or token level), decide whether to allow a request, and update the state — all as a single, indivisible unit of work.

With plain Redis commands issued separately (GET then SET, or GET then INCR), there is a race condition: two concurrent requests can both read the same count, both decide they are within the limit, and both increment — allowing traffic above the configured limit. This is not a theoretical concern; it happens routinely under moderate concurrency.

Redis transactions (MULTI/EXEC) provide atomicity but do not support conditional logic. You cannot read a value and make a decision within a MULTI block because all commands are queued and executed without intermediate results. Optimistic locking with WATCH adds complexity and retries without guaranteeing bounded latency.

## Decision

Use Redis Lua scripts (EVAL/EVALSHA) for all rate limit operations. Lua scripts execute atomically on the Redis server — the Redis event loop processes the entire script without interleaving any other client commands. This gives us both atomicity and conditional logic in a single round trip.

Each algorithm (token bucket, sliding window log, sliding window counter, fixed window) is implemented as a self-contained Lua script. The scripts are stored as TypeScript string constants and passed to Redis via EVAL. In production, EVALSHA with script caching reduces bandwidth.

## Trade-offs

**Benefits:**

- Correctness under concurrency is guaranteed by Redis's single-threaded execution model. No race conditions, no lost updates, no phantom reads.
- Single network round trip per rate limit check — lower latency than multi-command approaches.
- Conditional logic (if tokens >= cost, then deduct) works naturally in Lua.

**Costs:**

- Lua scripts are harder to debug than plain Redis commands. There is no step-through debugger for Redis Lua. Errors surface as opaque EVAL failures.
- Long-running Lua scripts block the entire Redis instance (single-threaded). All scripts must be kept small — O(1) or O(log n) in the common case. The sliding window log script uses ZREMRANGEBYSCORE which is O(log n + m) where m is the number of removed elements, but this is bounded by the rate limit itself.
- Script errors (e.g., from a typo) only appear at runtime, not at compile time. The TypeScript layer provides some safety by keeping scripts as constants with documented interfaces.

**Why not Redis Functions (Redis 7+)?**

Redis Functions provide a more structured alternative to EVAL, but they require Redis 7+ and reduce portability. EVAL works on Redis 5+ and all major managed Redis services (ElastiCache, Upstash, etc.). We can migrate to Functions later without changing the Store interface.

## Consequences

1. All four rate limiting algorithms ship as Lua scripts stored in `src/core/lua/`.
2. Scripts are kept small — the longest script (sliding window counter) is ~40 lines of Lua.
3. The `Store` interface abstracts Lua execution: `eval(script, keys, args) => Promise<unknown>`. This allows the MemoryStore to emulate the same semantics in TypeScript for testing without requiring a Redis instance.
4. Script correctness is validated through unit tests using the MemoryStore, which implements the same algorithm logic in TypeScript. If the TypeScript and Lua implementations agree on all test cases, we have high confidence both are correct.
5. Any new algorithm must be implemented twice: once as a Lua script for Redis, and once as TypeScript for the MemoryStore. This is the tax we pay for testability without Redis.
