// TODO: add composite key support
/**
 * Minimal request shape for key generation.
 * Framework-specific middleware will map their request types to this.
 */
export interface KeyGeneratorRequest {
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
  userId?: string;
  [key: string]: unknown;
}

/** A function that extracts a rate limit key from a request. */
export type KeyGenerator = (req: KeyGeneratorRequest) => string;

/** Generate a key based on the client's IP address. */
export const byIp: KeyGenerator = (req) => {
  const forwarded = req.headers['x-forwarded-for'];
  const ip =
    (Array.isArray(forwarded) ? forwarded[0] : forwarded) ?? req.ip ?? 'unknown';
  return `ip:${ip}`;
};

/** Generate a key based on a user ID property on the request. */
export const byUserId: KeyGenerator = (req) => {
  if (!req.userId) {
    throw new Error('Request has no userId for rate limit key generation');
  }
  return `user:${req.userId}`;
};

/**
 * Generate a key based on an API key header.
 * @param headerName — the header containing the API key (default: 'x-api-key')
 */
export function byApiKey(headerName: string = 'x-api-key'): KeyGenerator {
  return (req) => {
    const value = req.headers[headerName.toLowerCase()];
    const key = Array.isArray(value) ? value[0] : value;
    if (!key) {
      throw new Error(`Request has no ${headerName} header for rate limit key generation`);
    }
    return `apikey:${key}`;
  };
}

/**
 * Generate a key based on any request header.
 * @param headerName — the header to use as the key
 */
export function byHeader(headerName: string): KeyGenerator {
  return (req) => {
    const value = req.headers[headerName.toLowerCase()];
    const key = Array.isArray(value) ? value[0] : value;
    return `header:${headerName}:${key ?? 'unknown'}`;
  };
}

/**
 * Combine multiple key generators into a single composite key.
 * The resulting key is the concatenation of all generated keys, separated by ':'.
 */
export function composite(...generators: KeyGenerator[]): KeyGenerator {
  return (req) => {
    return generators.map((gen) => gen(req)).join(':');
  };
}

/**
 * Create a key generator from a custom function.
 * Wraps any function to conform to the KeyGenerator type.
 */
export function custom(fn: (req: KeyGeneratorRequest) => string): KeyGenerator {
  return fn;
}
