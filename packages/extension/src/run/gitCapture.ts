import type { GitContext } from '@isar-flow/core';
import type { CodeContextCapture } from '../contracts';
import { errorMessage } from './format';

/** Overall limit of the `git.*` capture at run start. */
export const GIT_CAPTURE_LIMIT_MS = 10_000;

/**
 * `git.*` of a run's workspace folder, at most `limitMs` overall; cancelling the run aborts it. Undefined (the run
 * sees empty values) when the capture took too long or failed.
 */
export async function captureRunGit(
  capture: CodeContextCapture,
  root: string,
  signal: AbortSignal,
  warn: (message: string) => void,
  limitMs = GIT_CAPTURE_LIMIT_MS,
): Promise<GitContext | undefined> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      warn(`Could not read the git state of ${root} within ${limitMs / 1000} s; git.* is empty in this run.`);
      resolve(undefined);
    }, limitMs);
  });
  const captured = capture.git(root, controller.signal).catch((error: unknown) => {
    warn(`Could not read the git state of ${root}: ${errorMessage(error)}`);
    return undefined;
  });
  try {
    return await Promise.race([captured, limit]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}
