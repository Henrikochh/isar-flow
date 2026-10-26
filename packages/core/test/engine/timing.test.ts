import { describe, expect, it } from 'vitest';
import { EventQueue } from '../../src/engine/queue';
import { AbortScope, MAX_TIMER_MS, onAbort, settle, sleep, stepTimeoutMs } from '../../src/engine/timing';

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;

describe('stepTimeoutMs', () => {
  it('converts seconds to milliseconds and ignores missing, zero, negative and invalid values', () => {
    expect(stepTimeoutMs(1.5)).toBe(1500);
    expect(stepTimeoutMs(undefined)).toBeUndefined();
    expect(stepTimeoutMs(0)).toBeUndefined();
    expect(stepTimeoutMs(-1)).toBeUndefined();
    expect(stepTimeoutMs(Number.NaN)).toBeUndefined();
  });

  it('caps long timeouts at the platform timer limit', () => {
    expect(MAX_TIMER_MS).toBe(2_147_483_647);
    expect(stepTimeoutMs(thirtyDaysMs / 1000)).toBe(MAX_TIMER_MS);
    expect(stepTimeoutMs(Number.POSITIVE_INFINITY)).toBe(MAX_TIMER_MS);
  });
});

describe('sleep', () => {
  it('resolves true after the delay', async () => {
    expect(await sleep(5)).toBe(true);
    expect(await sleep(0)).toBe(true);
  });

  it('resolves false as soon as the signal aborts', async () => {
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 5);
    expect(await sleep(10_000, controller.signal)).toBe(false);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(await sleep(10, AbortSignal.abort())).toBe(false);
  });

  it('does not end early for delays beyond the platform timer limit', async () => {
    const controller = new AbortController();
    const slept = sleep(thirtyDaysMs, controller.signal);
    const first = await Promise.race([slept, pause(30).then(() => 'still sleeping')]);
    controller.abort();
    expect(first).toBe('still sleeping');
    expect(await slept).toBe(false);
  });
});

describe('onAbort', () => {
  it('calls the listener once on abort and can be removed', () => {
    const controller = new AbortController();
    const calls: string[] = [];
    onAbort(controller.signal, () => calls.push('a'));
    const remove = onAbort(controller.signal, () => calls.push('b'));
    remove();
    controller.abort();
    controller.abort();
    expect(calls).toEqual(['a']);
  });

  it('calls the listener right away for an aborted signal', () => {
    let called = false;
    onAbort(AbortSignal.abort(), () => (called = true));
    expect(called).toBe(true);
  });
});

describe('settle', () => {
  const never = new Promise<number>(() => undefined);

  it('reports values and errors', async () => {
    const signal = new AbortController().signal;
    expect(await settle(Promise.resolve(1), signal, 10)).toEqual({ kind: 'value', value: 1 });
    const error = new Error('x');
    expect(await settle(Promise.reject(error), signal, 10)).toEqual({ kind: 'error', error });
  });

  it('waits a grace period after abort, then abandons the promise', async () => {
    const controller = new AbortController();
    const pending = settle(never, controller.signal, 20);
    controller.abort();
    expect(await pending).toEqual({ kind: 'abandoned' });
  });

  it('still takes a result that arrives during the grace period', async () => {
    const controller = new AbortController();
    const late = new Promise<string>((resolve) => setTimeout(() => resolve('partial'), 5));
    controller.abort();
    expect(await settle(late, controller.signal, 1_000)).toEqual({ kind: 'value', value: 'partial' });
  });
});

describe('AbortScope', () => {
  it('aborts on timeout and records it', async () => {
    const scope = new AbortScope(new AbortController().signal, 5);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(scope.signal.aborted).toBe(true);
    expect(scope.timedOut).toBe(true);
    scope.dispose();
  });

  it('does not fire right away for timeouts beyond the platform timer limit', async () => {
    const scope = new AbortScope(new AbortController().signal, thirtyDaysMs);
    await pause(30);
    expect(scope.signal.aborted).toBe(false);
    expect(scope.timedOut).toBe(false);
    scope.dispose();
  });

  it('follows the parent signal without recording a timeout', () => {
    const parent = new AbortController();
    const scope = new AbortScope(parent.signal, 10_000);
    parent.abort();
    expect(scope.signal.aborted).toBe(true);
    expect(scope.timedOut).toBe(false);
    scope.dispose();
  });

  it('starts aborted under an aborted parent and stops listening after dispose', () => {
    expect(new AbortScope(AbortSignal.abort()).signal.aborted).toBe(true);
    const parent = new AbortController();
    const scope = new AbortScope(parent.signal);
    scope.dispose();
    parent.abort();
    expect(scope.signal.aborted).toBe(false);
  });
});

describe('EventQueue', () => {
  it('delivers pushed items in order, then ends after close', async () => {
    const queue = new EventQueue<number>();
    queue.push(1);
    const next = queue.next();
    queue.push(2);
    queue.close();
    queue.push(3);
    expect(await next).toEqual({ done: false, value: 1 });
    expect(await queue.next()).toEqual({ done: false, value: 2 });
    expect(await queue.next()).toEqual({ done: true, value: undefined });
  });

  it('wakes a waiting consumer', async () => {
    const queue = new EventQueue<string>();
    const waiting = queue.next();
    setTimeout(() => queue.push('late'), 1);
    expect(await waiting).toEqual({ done: false, value: 'late' });
  });
});
