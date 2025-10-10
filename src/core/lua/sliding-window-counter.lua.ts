/**
 * Sliding window counter (hybrid) algorithm implemented as a Redis Lua script.
 * Uses two fixed windows with weighted interpolation for near-accurate counting with O(1) memory.
 *
 * KEYS[1] — the rate limit key (hash with window counts)
 * ARGV[1] — limit (max requests in window)
 * ARGV[2] — window size in milliseconds
 * ARGV[3] — current time in milliseconds
 *
 * Returns: {allowed (0|1), remaining, retry_after_ms, reset_ms}
 */
export const SLIDING_WINDOW_COUNTER_SCRIPT = `
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2])
local now = tonumber(ARGV[3])

-- Calculate current and previous window boundaries
local current_window = math.floor(now / window_ms)
local current_window_start = current_window * window_ms
local elapsed_in_window = now - current_window_start
local elapsed_ratio = elapsed_in_window / window_ms

local prev_window = current_window - 1
local curr_key = tostring(current_window)
local prev_key = tostring(prev_window)

-- Get counts for both windows
local data = redis.call('HMGET', key, curr_key, prev_key)
local curr_count = tonumber(data[1]) or 0
local prev_count = tonumber(data[2]) or 0

-- Weighted count: previous window contribution decreases as we move through current window
local weighted = prev_count * (1 - elapsed_ratio) + curr_count

local allowed = 0
local remaining = math.max(0, math.floor(limit - weighted))
local retry_after = 0

if weighted < limit then
  -- Increment current window counter
  redis.call('HINCRBY', key, curr_key, 1)
  allowed = 1
  remaining = math.max(0, remaining - 1)

  -- Clean up old windows (keep only current and previous)
  local all_fields = redis.call('HKEYS', key)
  for _, field in ipairs(all_fields) do
    local field_num = tonumber(field)
    if field_num ~= nil and field_num < prev_window then
      redis.call('HDEL', key, field)
    end
  end
else
  -- Calculate retry after: estimate when weighted count drops below limit
  -- The weighted count from prev_window decreases linearly over the current window
  -- We need: prev_count * (1 - new_ratio) + curr_count < limit
  -- new_ratio = (elapsed_in_window + retry_ms) / window_ms
  -- Solve: prev_count - prev_count * new_ratio + curr_count < limit
  -- prev_count * new_ratio > prev_count + curr_count - limit
  -- new_ratio > (prev_count + curr_count - limit) / prev_count
  if prev_count > 0 then
    local needed_ratio = (prev_count + curr_count - limit) / prev_count
    if needed_ratio < 1 then
      local needed_elapsed = needed_ratio * window_ms
      retry_after = math.max(0, math.ceil(needed_elapsed - elapsed_in_window))
    else
      -- Must wait for next window entirely
      retry_after = math.ceil(window_ms - elapsed_in_window)
    end
  else
    retry_after = math.ceil(window_ms - elapsed_in_window)
  end
end

-- TTL: two full windows to keep previous window data
redis.call('PEXPIRE', key, window_ms * 2 + 1000)

local reset_ms = math.ceil(window_ms - elapsed_in_window)

return {allowed, remaining, retry_after, reset_ms}
`;
