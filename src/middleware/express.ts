import type { MiddlewareConfig } from './shared.js';
import { generateHeaders, handleRateLimit } from './shared.js';
import type { KeyGeneratorRequest } from '../keys/key-generator.js';

/** Express request type (minimal). */
interface ExpressRequest {
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
  [key: string]: unknown;
}

/** Express response type (minimal). */
interface ExpressResponse {
  status(code: number): ExpressResponse;
  json(body: unknown): void;
  set(headers: Record<string, string>): void;
  headersSent: boolean;
}

type NextFunction = (err?: unknown) => void;

/**
 * Create an Express middleware for rate limiting.
 *
 * @example
 * ```ts
 * import { expressRateLimit } from 'ratelimit-service/middleware/express';
 *
 * app.use(expressRateLimit({
 *   limiter,
 *   policy: { name: 'api', algorithm: 'sliding-window-counter', config: { limit: 100, windowMs: 60000 }, keyGenerator: byIp },
 * }));
 * ```
 */
export function expressRateLimit(
  config: MiddlewareConfig,
): (req: ExpressRequest, res: ExpressResponse, next: NextFunction) => void {
  return async (req, res, next) => {
    try {
      const keyReq: KeyGeneratorRequest = {
        ip: req.ip,
        headers: req.headers as Record<string, string | string[] | undefined>,
        userId: req['userId'] as string | undefined,
      };

      const { result, response } = await handleRateLimit(config, keyReq);

      // Set rate limit headers on all responses
      const headers = generateHeaders(result);
      if (!res.headersSent) {
        res.set(headers);
      }

      // Attach result to request if configured
      if (config.requestPropertyName) {
        (req as Record<string, unknown>)[config.requestPropertyName] = result;
      }

      if (response) {
        if (!res.headersSent) {
          res.status(response.status).json(response.body);
        }
        return;
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}
