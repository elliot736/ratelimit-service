// TODO: add connection pooling
import type { Store } from './store.js';

type FailMode = 'open' | 'closed';
type EventHandler = (...args: unknown[]) => void;

export interface RedisStoreOptions {
  /** Redis connection URL (e.g., redis://localhost:6379). */
  url?: string;
  /** Redis host (default: 127.0.0.1). */
  host?: string;
  /** Redis port (default: 6379). */
  port?: number;
  /** Redis password. */
  password?: string;
  /** Redis database index (default: 0). */
  db?: number;
  /** Prefix for all keys. */
  keyPrefix?: string;
  /** Behavior when Redis is unavailable: 'open' allows requests, 'closed' denies them. */
  failMode?: FailMode;
  /** Existing ioredis client instance. If provided, connection options are ignored. */
  client?: RedisClient;
}

/** Minimal ioredis client interface to avoid a hard dependency. */
interface RedisClient {
  eval(
    script: string,
    numkeys: number,
    ...args: (string | number)[]
  ): Promise<unknown>;
  quit(): Promise<string>;
  on(event: string, handler: (...args: unknown[]) => void): void;
  status?: string;
}

/**
 * Redis-backed store using ioredis.
 *
 * Executes Lua scripts atomically via EVAL. Supports fail-open and fail-closed
 * modes when Redis is unavailable. Emits events for monitoring.
 */
export class RedisStore implements Store {
  private client: RedisClient;
  private readonly failMode: FailMode;
  private readonly ownsClient: boolean;
  private eventHandlers = new Map<string, EventHandler[]>();

  constructor(options: RedisStoreOptions) {
    this.failMode = options.failMode ?? 'open';

    if (options.client) {
      this.client = options.client;
      this.ownsClient = false;
    } else {
      // Dynamic import to keep ioredis as an optional peer dependency.
      // In real usage, the caller would pass a client or ensure ioredis is installed.
      const Redis = RedisStore.requireIoredis();
      const redisOptions: Record<string, unknown> = {};
      if (options.host) redisOptions['host'] = options.host;
      if (options.port) redisOptions['port'] = options.port;
      if (options.password) redisOptions['password'] = options.password;
      if (options.db !== undefined) redisOptions['db'] = options.db;
      if (options.keyPrefix) redisOptions['keyPrefix'] = options.keyPrefix;

      this.client = options.url
        ? new Redis(options.url)
        : new Redis(redisOptions);
      this.ownsClient = true;
    }

    // Forward Redis events
    this.client.on('error', (err: unknown) => {
      this.emit('error', err);
    });
    this.client.on('reconnecting', () => {
      this.emit('reconnect');
    });
  }

  private static requireIoredis(): new (...args: unknown[]) => RedisClient {
    try {
      // Dynamic require for ioredis — must use require for synchronous loading
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('ioredis') as new (...args: unknown[]) => RedisClient;
      return mod;
    } catch {
      throw new Error(
        'ioredis is required for RedisStore. Install it with: npm install ioredis',
      );
    }
  }

  async eval(
    script: string,
    keys: string[],
    args: (string | number)[],
  ): Promise<unknown> {
    try {
      return await this.client.eval(
        script,
        keys.length,
        ...keys,
        ...args,
      );
    } catch (err) {
      this.emit('error', err);

      if (this.failMode === 'open') {
        // Fail open: return a permissive result
        // Return [1 (allowed), 999 (remaining), 0 (retry_after), 0 (reset_ms)]
        return [1, 999, 0, 0];
      }

      // Fail closed: re-throw to deny the request
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    if (this.ownsClient) {
      await this.client.quit();
    }
  }

  /** Subscribe to store events. */
  on(event: 'error' | 'reconnect', handler: EventHandler): void {
    const handlers = this.eventHandlers.get(event) ?? [];
    handlers.push(handler);
    this.eventHandlers.set(event, handlers);
  }

  private emit(event: string, ...args: unknown[]): void {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      for (const handler of handlers) {
        handler(...args);
      }
    }
  }
}
