/**
 * Sliding window log algorithm implemented as a Redis Lua script.
 * Uses a sorted set where each member is a unique request ID and the score is the timestamp.
 *
 * KEYS[1] — the rate limit key
 * ARGV[1] — limit (max requests in window)
 * ARGV[2] — window size in milliseconds
 * ARGV[3] — current time in milliseconds
 * ARGV[4] — unique request ID (to avoid dedup in sorted set)
 *
 * Returns: {allowed (0|1), remaining, retry_after_ms, reset_ms}
 */
export const SLIDING_WINDOW_SCRIPT = `
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local request_id = ARGV[4]

local window_start = now - window_ms

-- Remove entries outside the window
redis.call('ZREMRANGEBYSCORE', key, '-inf', window_start)

-- Count entries in the current window
local count = redis.call('ZCARD', key)

local allowed = 0
local remaining = math.max(0, limit - count)
local retry_after = 0

if count < limit then
  -- Add the current request
  redis.call('ZADD', key, now, request_id)
  allowed = 1
  remaining = limit - count - 1
else
  -- Find the oldest entry to calculate retry time
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  if #oldest >= 2 then
    local oldest_time = tonumber(oldest[2])
    retry_after = math.max(0, math.ceil(oldest_time + window_ms - now))
  end
end

-- Set TTL slightly beyond the window
redis.call('PEXPIRE', key, window_ms + 1000)

local reset_ms = window_ms

return {allowed, remaining, retry_after, reset_ms}
`;
