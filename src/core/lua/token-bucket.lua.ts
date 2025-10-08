/**
 * Token bucket algorithm implemented as a Redis Lua script.
 *
 * KEYS[1] — the rate limit key
 * ARGV[1] — capacity (max tokens / burst size)
 * ARGV[2] — refill rate (tokens per second)
 * ARGV[3] — current time in seconds (floating point)
 * ARGV[4] — cost (tokens to consume, typically 1)
 *
 * Returns: {allowed (0|1), remaining tokens (floor), retry_after_ms}
 */
export const TOKEN_BUCKET_SCRIPT = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_rate = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])

local data = redis.call('HMGET', key, 'tokens', 'last_refill')
local tokens = tonumber(data[1])
local last_refill = tonumber(data[2])

if tokens == nil then
  tokens = capacity
  last_refill = now
end

local elapsed = math.max(0, now - last_refill)
tokens = math.min(capacity, tokens + elapsed * refill_rate)

local allowed = 0
local retry_after = 0

if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  retry_after = math.ceil((cost - tokens) / refill_rate * 1000)
end

redis.call('HMSET', key, 'tokens', tokens, 'last_refill', now)
redis.call('PEXPIRE', key, math.ceil(capacity / refill_rate * 1000) + 1000)

return {allowed, math.floor(tokens), retry_after}
`;
