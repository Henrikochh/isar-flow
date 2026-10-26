import { ModelError } from './types';

export interface RetryOptions {
  /** Total number of attempts including the first one (default 3). */
  attempts?: number;
  /** Wait before the first retry; doubles with every further retry (default 500 ms). */
  baseDelayMs?: number;
  signal?: AbortSignal;
  /** Called before waiting for the next attempt; `attempt` is the 1-based attempt that failed. */
  onRetry?: (error: ModelError, attempt: number, delayMs: number) => void;
}

const MAX_DELAY_MS = 30_000;
/** setTimeout fires after 1 ms for anything longer than this (signed 32-bit), so longer waits are capped. */
const MAX_TIMER_MS = 2_147_483_647;

/** Resolves after `ms` milliseconds; rejects with the abort reason as soon as the signal aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const done = () => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    const timer = setTimeout(done, Number.isNaN(ms) ? 0 : Math.min(Math.max(0, ms), MAX_TIMER_MS));
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

const cancelled = () => new ModelError('The request was cancelled.', 'aborted');

function retryDelay(error: ModelError, attempt: number, baseDelayMs: number): number {
  // Errors built from an HTTP response carry the server's Retry-After hint as `retryAfterMs`.
  const hint: unknown = (error as { retryAfterMs?: unknown }).retryAfterMs;
  const delay =
    typeof hint === 'number' && Number.isFinite(hint) && hint >= 0 ? hint : baseDelayMs * 2 ** (attempt - 1);
  return Math.min(delay, MAX_DELAY_MS);
}

/**
 * Runs `fn` and retries it when it fails with a retryable {@link ModelError} (rate limit, server or
 * network errors), waiting with exponential backoff in between. Other errors are thrown immediately.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const attempts = Number.isFinite(options.attempts) ? Math.max(1, Math.floor(options.attempts ?? 1)) : 3;
  const baseDelayMs = Number.isFinite(options.baseDelayMs) ? Math.max(0, options.baseDelayMs ?? 0) : 500;
  const { signal } = options;
  for (let attempt = 1; ; attempt++) {
    if (signal?.aborted) throw cancelled();
    try {
      return await fn(attempt);
    } catch (error) {
      const retry = error instanceof ModelError && error.retryable && attempt < attempts && !signal?.aborted;
      if (!retry) throw error;
      const delayMs = retryDelay(error, attempt, baseDelayMs);
      options.onRetry?.(error, attempt, delayMs);
      try {
        await sleep(delayMs, signal);
      } catch {
        throw cancelled();
      }
    }
  }
}
