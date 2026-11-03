import { spawn } from 'node:child_process';

export interface CappedRunOptions {
  cwd: string;
  /** The whole environment of the process (default: this process's). */
  env?: NodeJS.ProcessEnv;
  /** The process is stopped after this time. */
  timeoutMs: number;
  signal?: AbortSignal;
  /** Most stdout bytes kept; when more arrive the process is stopped and the result is `truncated`. */
  maxBytes: number;
}

export interface CappedRunResult {
  /** Exit code 0, or stopped on purpose because the output reached `maxBytes`. */
  ok: boolean;
  exitCode: number | null;
  stdout: Buffer;
  /** stdout had more than `maxBytes`; `stdout` holds the first `maxBytes`. */
  truncated: boolean;
  /** Why the process did not finish by itself: not found, too slow, aborted, or another start error. */
  failure?: 'missing' | 'timeout' | 'aborted' | 'error';
}

/**
 * Runs a program without a shell (argument list), reads stdout as a stream and never keeps more than `maxBytes`
 * of it. Never rejects.
 */
export function runCapped(file: string, args: string[], options: CappedRunOptions): Promise<CappedRunResult> {
  const { signal } = options;
  if (signal?.aborted) {
    return Promise.resolve({
      ok: false,
      exitCode: null,
      stdout: Buffer.alloc(0),
      truncated: false,
      failure: 'aborted',
    });
  }

  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    let failure: CappedRunResult['failure'];
    let settled = false;

    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });

    const stop = (reason?: CappedRunResult['failure']) => {
      if (!truncated && failure === undefined) failure = reason;
      child.stdout?.destroy();
      child.kill();
    };
    const timer = setTimeout(() => stop('timeout'), Math.max(1, options.timeoutMs));
    const onAbort = () => stop('aborted');
    signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      const stdout = Buffer.concat(chunks, size);
      const ok = failure === undefined && (truncated || exitCode === 0);
      resolve({ ok, exitCode, stdout, truncated, ...(failure !== undefined && { failure }) });
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      if (truncated || failure !== undefined) return;
      const room = options.maxBytes - size;
      if (chunk.length > room) {
        if (room > 0) chunks.push(chunk.subarray(0, room));
        size = options.maxBytes;
        truncated = true;
        stop();
        return;
      }
      chunks.push(chunk);
      size += chunk.length;
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (failure === undefined && !truncated) failure = error.code === 'ENOENT' ? 'missing' : 'error';
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });
}
