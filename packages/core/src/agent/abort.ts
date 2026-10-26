import { ModelError } from '../models/types';

/** The error to throw for an aborted signal: the caller's reason when it is an Error, so timeouts keep their message. */
export function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  return new ModelError('The agent run was cancelled.', 'aborted');
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal);
}
