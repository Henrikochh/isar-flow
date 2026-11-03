import { describe, expect, it, vi } from 'vitest';
import { createInterruptHandler } from '../src/signals';

describe('createInterruptHandler', () => {
  it('cancels the run on the first interrupt and exits with 130 on the second', () => {
    const abort = vi.fn();
    const exit = vi.fn();
    let text = '';
    const interrupt = createInterruptHandler({ abort, exit, write: (chunk) => (text += chunk) });

    interrupt();
    expect(abort).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
    expect(text).toBe('\nCancelling… Press Ctrl+C again to stop immediately.\n');

    interrupt();
    expect(abort).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(130);
  });
});
