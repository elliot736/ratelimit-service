/**
 * Fixed window counter algorithm implemented as a Redis Lua script.
 *
 * KEYS[1] — the rate limit key
 * ARGV[1] — limit (max requests in window)
 * ARGV[2] — window size in milliseconds
 * ARGV[3] — current time in milliseconds
 *
 * Returns: {allowed (0|1), remaining, retry_after_ms, reset_ms}
 */
export const FIXED_WINDOW_SCRIPT = `
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2])
local now = tonumber(ARGV[3])

-- Compute window boundary
local current_window = math.floor(now / window_ms)
local window_key = key .. ':' .. tostring(current_window)
local window_end = (current_window + 1) * window_ms

-- Get current count
local count = tonumber(redis.call('GET', window_key)) or 0

local allowed = 0
local remaining = math.max(0, limit - count)
local retry_after = 0
local reset_ms = window_end - now

if count < limit then
  redis.call('INCR', window_key)
  redis.call('PEXPIRE', window_key, reset_ms + 1000)
  allowed = 1
  remaining = limit - count - 1
else
  retry_after = reset_ms
end

return {allowed, remaining, retry_after, math.ceil(reset_ms)}
`;
