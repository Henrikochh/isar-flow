export interface InterruptOptions {
  /** Cancels the run (the engine stops, console process trees are killed). */
  abort(): void;
  write(text: string): void;
  exit(code: number): void;
}

/** Ctrl+C or SIGTERM: the first cancels the run, the second ends the process at once with 130. */
export function createInterruptHandler({ abort, write, exit }: InterruptOptions): () => void {
  let interrupts = 0;
  return () => {
    interrupts++;
    if (interrupts > 1) {
      exit(130);
      return;
    }
    write('\nCancelling… Press Ctrl+C again to stop immediately.\n');
    abort();
  };
}
