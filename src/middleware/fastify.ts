// TODO: handle Fastify lifecycle hooks
import type { MiddlewareConfig } from './shared.js';
import { generateHeaders, handleRateLimit } from './shared.js';
import type { KeyGeneratorRequest } from '../keys/key-generator.js';

/** Minimal Fastify request interface. */
interface FastifyRequest {
  ip: string;
  headers: Record<string, string | string[] | undefined>;
  [key: string]: unknown;
}

/** Minimal Fastify reply interface. */
interface FastifyReply {
  code(statusCode: number): FastifyReply;
  headers(values: Record<string, string>): FastifyReply;
  send(payload?: unknown): FastifyReply;
}

/** Minimal Fastify instance interface for plugin registration. */
interface FastifyInstance {
  addHook(
    name: 'onRequest',
    handler: (
      request: FastifyRequest,
      reply: FastifyReply,
      done: (err?: Error) => void,
    ) => void | Promise<void>,
  ): void;
}

type FastifyPluginAsync = (
  fastify: FastifyInstance,
  opts: Record<string, unknown>,
) => Promise<void>;

/**
 * Create a Fastify plugin for rate limiting.
 *
 * @example
 * ```ts
 * import { fastifyRateLimit } from 'ratelimit-service/middleware/fastify';
 *
 * app.register(fastifyRateLimit({
 *   limiter,
 *   policy: { name: 'api', algorithm: 'sliding-window-counter', config: { limit: 100, windowMs: 60000 }, keyGenerator: byIp },
 * }));
 * ```
 */
export function fastifyRateLimit(
  config: MiddlewareConfig,
): FastifyPluginAsync {
  return async (fastify) => {
    fastify.addHook('onRequest', async (request, reply) => {
      const keyReq: KeyGeneratorRequest = {
        ip: request.ip,
        headers: request.headers as Record<string, string | string[] | undefined>,
        userId: request['userId'] as string | undefined,
      };

      const { result, response } = await handleRateLimit(config, keyReq);

      // Set rate limit headers
      const headers = generateHeaders(result);
      reply.headers(headers);

      // Attach result to request if configured
      if (config.requestPropertyName) {
        (request as Record<string, unknown>)[config.requestPropertyName] = result;
      }

      if (response) {
        reply.code(response.status).send(response.body);
        return;
      }
    });
  };
}
