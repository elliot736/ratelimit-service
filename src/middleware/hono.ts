import type { MiddlewareConfig } from './shared.js';
import { generateHeaders, handleRateLimit } from './shared.js';
import type { KeyGeneratorRequest } from '../keys/key-generator.js';

/** Minimal Hono context interface. */
interface HonoContext {
  req: {
    header(name: string): string | undefined;
    raw: { headers: Headers };
  };
  header(name: string, value: string): void;
  json(body: unknown, status?: number): Response;
  set(key: string, value: unknown): void;
  get(key: string): unknown;
}

type NextFunction = () => Promise<void>;

type MiddlewareHandler = (
  c: HonoContext,
  next: NextFunction,
) => Promise<Response | void>;

/**
 * Create a Hono middleware for rate limiting.
 *
 * @example
 * ```ts
 * import { honoRateLimit } from 'ratelimit-service/middleware/hono';
 *
 * app.use('*', honoRateLimit({
 *   limiter,
 *   policy: { name: 'api', algorithm: 'sliding-window-counter', config: { limit: 100, windowMs: 60000 }, keyGenerator: byIp },
 * }));
 * ```
 */
export function honoRateLimit(config: MiddlewareConfig): MiddlewareHandler {
  return async (c, next) => {
    // Build a generic request object from Hono's context
    const headers: Record<string, string | undefined> = {};

    // Extract headers from the raw request
    if (c.req.raw?.headers) {
      c.req.raw.headers.forEach((value, key) => {
        headers[key] = value;
      });
    }

    const ip =
      c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
      c.req.header('x-real-ip') ??
      'unknown';

    const keyReq: KeyGeneratorRequest = {
      ip,
      headers,
      userId: c.get('userId') as string | undefined,
    };

    const { result, response } = await handleRateLimit(config, keyReq);

    // Set rate limit headers
    const rateLimitHeaders = generateHeaders(result);
    for (const [key, value] of Object.entries(rateLimitHeaders)) {
      c.header(key, value);
    }

    // Attach result to context if configured
    if (config.requestPropertyName) {
      c.set(config.requestPropertyName, result);
    }

    if (response) {
      return c.json(response.body, response.status);
    }

    await next();
  };
}
