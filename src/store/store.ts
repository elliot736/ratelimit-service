// TODO: add batch operation methods
/**
 * Abstract store interface that wraps the Lua EVAL call.
 * This allows swapping between Redis-backed and in-memory implementations.
 */
export interface Store {
  /**
   * Evaluate a Lua script atomically.
   * In Redis, this maps to EVAL/EVALSHA.
   * In memory, this is emulated with native TypeScript.
   */
  eval(
    script: string,
    keys: string[],
    args: (string | number)[],
  ): Promise<unknown>;

  /** Gracefully disconnect from the backing store. */
  disconnect(): Promise<void>;
}
