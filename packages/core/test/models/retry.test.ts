import { describe, expect, it } from 'vitest';
import { sleep, withRetry } from '../../src/models/retry';
import { ModelError } from '../../src/models/types';

/** Returns a function that throws the given errors in order, then resolves with 'ok'. */
function failing(...errors: Error[]) {
  let calls = 0;
  const fn = async (attempt: number) => {
    calls++;
    expect(attempt).toBe(calls);
    const error = errors[calls - 1];
    if (error) throw error;
    return 'ok';
  };
  return { fn, calls: () => calls };
}

describe('withRetry', () => {
  it('returns the first successful result without waiting', async () => {
    const { fn, calls } = failing();
    expect(await withRetry(fn)).toBe('ok');
    expect(calls()).toBe(1);
  });

  it('retries retryable model errors with exponential backoff', async () => {
    const { fn, calls } = failing(new ModelError('busy', 'server', 503), new ModelError('gone', 'network'));
    const delays: number[] = [];
    const result = await withRetry(fn, {
      attempts: 3,
      baseDelayMs: 2,
      onRetry: (error, attempt, delayMs) => delays.push(attempt * 1000 + delayMs),
    });
    expect(result).toBe('ok');
    expect(calls()).toBe(3);
    expect(delays).toEqual([1002, 2004]);
  });

  it.each([
    ['auth', new ModelError('no key', 'auth', 401)],
    ['bad-request', new ModelError('bad', 'bad-request', 400)],
    ['aborted', new ModelError('stop', 'aborted')],
    ['plain error', new Error('boom')],
  ])('does not retry %s errors', async (_name, error) => {
    const { fn, calls } = failing(error);
    await expect(withRetry(fn, { baseDelayMs: 1 })).rejects.toBe(error);
    expect(calls()).toBe(1);
  });

  it('throws the last error once all attempts are used', async () => {
    const last = new ModelError('third', 'rate-limit', 429);
    const { fn, calls } = failing(
      new ModelError('first', 'server', 500),
      new ModelError('second', 'server', 502),
      last,
    );
    await expect(withRetry(fn, { attempts: 3, baseDelayMs: 1 })).rejects.toBe(last);
    expect(calls()).toBe(3);
  });

  it('treats attempts below one as a single attempt', async () => {
    const { fn, calls } = failing(new ModelError('busy', 'server', 503));
    await expect(withRetry(fn, { attempts: 0, baseDelayMs: 1 })).rejects.toThrow('busy');
    expect(calls()).toBe(1);
  });

  it('honours the retry hint carried by the error', async () => {
    const hinted = new ModelError('slow down', 'rate-limit', 429, 3);
    const { fn } = failing(hinted);
    const delays: number[] = [];
    await withRetry(fn, { baseDelayMs: 10_000, onRetry: (_e, _a, delayMs) => delays.push(delayMs) });
    expect(delays).toEqual([3]);
  });

  it('falls back to the backoff for unusable retry hints', async () => {
    const { fn } = failing(
      new ModelError('slow down', 'rate-limit', 429, Number.NaN),
      new ModelError('slow down', 'rate-limit', 429, -5),
    );
    const delays: number[] = [];
    await withRetry(fn, { baseDelayMs: 2, onRetry: (_e, _a, delayMs) => delays.push(delayMs) });
    expect(delays).toEqual([2, 4]);
  });

  it('caps the delay at 30 seconds', async () => {
    const controller = new AbortController();
    const hinted = new ModelError('slow down', 'rate-limit', 429, 120_000);
    const { fn } = failing(hinted);
    const delays: number[] = [];
    const run = withRetry(fn, {
      signal: controller.signal,
      onRetry: (_e, _a, delayMs) => {
        delays.push(delayMs);
        controller.abort();
      },
    });
    await expect(run).rejects.toMatchObject({ kind: 'aborted' });
    expect(delays).toEqual([30_000]);
  });

  it('stops waiting between attempts when aborted', async () => {
    const controller = new AbortController();
    const { fn, calls } = failing(new ModelError('busy', 'server', 503));
    const started = Date.now();
    const run = withRetry(fn, { baseDelayMs: 10_000, signal: controller.signal });
    setTimeout(() => controller.abort(), 5);
    await expect(run).rejects.toMatchObject({ name: 'ModelError', kind: 'aborted' });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(calls()).toBe(1);
  });

  it('does not call the function when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const { fn, calls } = failing();
    await expect(withRetry(fn, { signal: controller.signal })).rejects.toMatchObject({ kind: 'aborted' });
    expect(calls()).toBe(0);
  });
});

describe('sleep', () => {
  it('resolves after the delay', async () => {
    const started = Date.now();
    await sleep(15);
    expect(Date.now() - started).toBeGreaterThanOrEqual(10);
  });

  it('rejects when aborted while waiting', async () => {
    const controller = new AbortController();
    const pending = sleep(10_000, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow();
  });

  it('keeps waiting for delays longer than the 32-bit timer limit', async () => {
    const controller = new AbortController();
    let settled = false;
    const pending = sleep(2 ** 31 + 1000, controller.signal).finally(() => (settled = true));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(settled).toBe(false);
    controller.abort();
    await expect(pending).rejects.toBeDefined();
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('stopped'));
    await expect(sleep(10_000, controller.signal)).rejects.toThrow('stopped');
  });
});
