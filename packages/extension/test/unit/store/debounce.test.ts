import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { debounce } from '../../../src/store/debounce';

describe('debounce', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('calls once after the quiet period', () => {
    const fn = vi.fn();
    const d = debounce(fn, 100);
    d.trigger();
    vi.advanceTimersByTime(60);
    d.trigger();
    vi.advanceTimersByTime(60);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(40);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not call after dispose', () => {
    const fn = vi.fn();
    const d = debounce(fn, 100);
    d.trigger();
    d.dispose();
    d.trigger();
    vi.advanceTimersByTime(500);
    expect(fn).not.toHaveBeenCalled();
  });
});
