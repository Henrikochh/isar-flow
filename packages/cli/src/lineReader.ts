import readline from 'node:readline';
import type { CliInput, CliOutput } from './io';

export interface LineReader {
  /**
   * Writes `prompt` and resolves with the next line typed (also one typed ahead). Rejects with the signal's reason
   * when it aborts, and when the input ended or the reader was closed.
   */
  read(prompt: string, signal?: AbortSignal): Promise<string>;
  /** Stops reading the input; waiting reads reject. */
  close(): void;
}

const INPUT_ENDED = 'The input ended before an answer was typed.';

interface Waiter {
  resolve(line: string): void;
  reject(error: Error): void;
}

function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error('The run was cancelled.');
}

/**
 * Reads answers line by line. The terminal stays in its normal line mode (it echoes what is typed, and Ctrl+C
 * reaches the process as SIGINT). The input is only touched once something is asked.
 */
export function createLineReader(input: CliInput, output: CliOutput): LineReader {
  let rl: readline.Interface | undefined;
  let ended = false;
  const typedAhead: string[] = [];
  const waiters: Waiter[] = [];

  const endAll = () => {
    ended = true;
    for (const waiter of waiters.splice(0)) waiter.reject(new Error(INPUT_ENDED));
  };

  const start = () => {
    if (rl || ended) return;
    rl = readline.createInterface({ input, terminal: false, crlfDelay: Infinity });
    rl.on('line', (line) => {
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(line);
      else typedAhead.push(line);
    });
    rl.on('close', endAll);
  };

  return {
    read(prompt, signal) {
      if (signal?.aborted) return Promise.reject(abortReason(signal));
      start();
      output.write(prompt);
      const line = typedAhead.shift();
      if (line !== undefined) return Promise.resolve(line);
      if (ended) {
        output.write('\n');
        return Promise.reject(new Error(INPUT_ENDED));
      }
      return new Promise<string>((resolve, reject) => {
        const onAbort = () => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          output.write('\n');
          reject(abortReason(signal as AbortSignal));
        };
        const waiter: Waiter = {
          resolve: (text) => {
            signal?.removeEventListener('abort', onAbort);
            resolve(text);
          },
          reject: (error) => {
            signal?.removeEventListener('abort', onAbort);
            output.write('\n');
            reject(error);
          },
        };
        waiters.push(waiter);
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    },
    close() {
      const open = rl;
      rl = undefined;
      endAll();
      open?.close();
    },
  };
}
