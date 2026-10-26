/** Longest delay setTimeout supports; larger values overflow and fire after 1 ms instead. */
export const MAX_TIMER_MS = 2_147_483_647;

function timerDelay(ms: number): number {
  return Math.min(Math.max(ms, 0), MAX_TIMER_MS);
}

/** A block's `timeout` (seconds) in milliseconds, capped to what timers support; undefined means no timeout. */
export function stepTimeoutMs(seconds: number | undefined): number | undefined {
  if (seconds === undefined || !(seconds > 0)) return undefined;
  return timerDelay(seconds * 1000);
}

/** Calls `listener` once when the signal aborts (right away if it already has). Returns a remover. */
export function onAbort(signal: AbortSignal, listener: () => void): () => void {
  if (signal.aborted) {
    listener();
    return () => undefined;
  }
  signal.addEventListener('abort', listener, { once: true });
  return () => signal.removeEventListener('abort', listener);
}

/** Waits `ms` milliseconds. Resolves true when the time elapsed, false when the signal aborted first. */
export function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(false);
    let removeAbort = (): void => undefined;
    const timer = setTimeout(() => {
      removeAbort();
      resolve(true);
    }, timerDelay(ms));
    if (signal) {
      removeAbort = onAbort(signal, () => {
        clearTimeout(timer);
        resolve(false);
      });
    }
  });
}

export type Settled<T> =
  { kind: 'value'; value: T } | { kind: 'error'; error: unknown } | { kind: 'abandoned' };

/**
 * Waits for a promise without ever rejecting. After the signal aborts, the promise gets `graceMs` to settle
 * (so partial results of a cancelled host call are kept); after that it is abandoned so a host that ignores
 * cancellation cannot hang the run.
 */
export function settle<T>(promise: Promise<T>, signal: AbortSignal, graceMs: number): Promise<Settled<T>> {
  return new Promise((resolve) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let removeAbort = (): void => undefined;
    const finish = (result: Settled<T>) => {
      if (done) return;
      done = true;
      if (timer !== undefined) clearTimeout(timer);
      removeAbort();
      resolve(result);
    };
    promise.then(
      (value) => finish({ kind: 'value', value }),
      (error: unknown) => finish({ kind: 'error', error }),
    );
    removeAbort = onAbort(signal, () => {
      timer = setTimeout(() => finish({ kind: 'abandoned' }), graceMs);
    });
  });
}

/**
 * A child abort signal that follows its parent and optionally aborts itself after a timeout.
 * `timedOut` tells a block's own timeout apart from cancellation coming from above.
 */
export class AbortScope {
  private readonly controller = new AbortController();
  private readonly removeParent: () => void;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private didTimeOut = false;

  constructor(parent: AbortSignal, timeoutMs?: number) {
    this.removeParent = onAbort(parent, () => {
      this.clearTimer();
      this.controller.abort(parent.reason);
    });
    if (timeoutMs !== undefined && !this.controller.signal.aborted) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        if (this.controller.signal.aborted) return;
        this.didTimeOut = true;
        this.controller.abort(new Error(`Timed out after ${timeoutMs} ms`));
      }, timerDelay(timeoutMs));
    }
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get timedOut(): boolean {
    return this.didTimeOut;
  }

  dispose(): void {
    this.clearTimer();
    this.removeParent();
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
