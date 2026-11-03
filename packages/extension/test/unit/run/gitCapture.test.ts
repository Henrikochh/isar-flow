import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GitContext } from '@isar-flow/core';
import type { CodeContextCapture } from '../../../src/contracts';
import { captureRunGit } from '../../../src/run/gitCapture';

const GIT: GitContext = { branch: 'main', changedFiles: ['a.ts'], diff: '+x' };

function capture(git: CodeContextCapture['git']): CodeContextCapture {
  return { editor: () => undefined, git, dispose: () => undefined };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('captureRunGit', () => {
  it('returns the captured git state', async () => {
    const git = vi.fn(async () => GIT);
    const warn = vi.fn();
    expect(await captureRunGit(capture(git), '/ws', new AbortController().signal, warn)).toEqual(GIT);
    expect(git).toHaveBeenCalledWith('/ws', expect.any(AbortSignal));
    expect(warn).not.toHaveBeenCalled();
  });

  it('gives up after the overall limit, aborts the capture and logs why', async () => {
    vi.useFakeTimers();
    let seen: AbortSignal | undefined;
    const git = vi.fn((_root: string, signal?: AbortSignal) => {
      seen = signal;
      return new Promise<GitContext>(() => undefined);
    });
    const warn = vi.fn();
    const result = captureRunGit(capture(git), '/ws', new AbortController().signal, warn, 10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await result).toBeUndefined();
    expect(seen?.aborted).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('within 10 s'));
  });

  it('aborts the capture when the run is cancelled', async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const git = vi.fn(
      (_root: string, signal?: AbortSignal) =>
        new Promise<GitContext>((resolve) => {
          seen = signal;
          signal?.addEventListener('abort', () => resolve({ branch: '', changedFiles: [], diff: '' }));
        }),
    );
    const result = captureRunGit(capture(git), '/ws', controller.signal, vi.fn());
    controller.abort();
    expect(await result).toEqual({ branch: '', changedFiles: [], diff: '' });
    expect(seen?.aborted).toBe(true);
  });

  it('treats a rejecting capture as not captured', async () => {
    const warn = vi.fn();
    const git = vi.fn(async () => Promise.reject(new Error('boom')));
    expect(await captureRunGit(capture(git), '/ws', new AbortController().signal, warn)).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('boom'));
  });
});
