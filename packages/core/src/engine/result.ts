/** Control transfer a block asks for, independent of its own status. */
export type Control =
  | { kind: 'break' }
  /** Ends the run; not caught by continueOnError and never retried. */
  | { kind: 'stop'; outcome: 'success' | 'failure'; error?: string }
  /** The block was cut short by cancellation (or an enclosing block's timeout). */
  | { kind: 'abort' };

/** What one attempt of a block produced. */
export interface BlockResult {
  status: 'success' | 'failure' | 'cancelled';
  /** Outputs without `status` and `durationMs`, which the engine adds. */
  output: Record<string, unknown>;
  error?: string;
  /** Message for the run when this failure ends it; defaults to "Block '<id>' failed: <error>". */
  runError?: string;
  /** False when retrying cannot help (bad template, unknown agent, …). */
  retryable?: boolean;
  control?: Control;
}

/** How execution continues after a block. */
export type Flow =
  | { kind: 'next' }
  | { kind: 'break' }
  | { kind: 'fail'; error: string }
  | { kind: 'stop'; outcome: 'success' | 'failure'; error?: string }
  | { kind: 'abort' };
