/** Collects `data:` lines into events, following the WHATWG event-stream format. */
class EventStreamDecoder {
  private buffer = '';
  private data: string[] = [];

  /** Feeds decoded text and returns the data of every event completed by it. */
  feed(text: string, final = false): string[] {
    this.buffer += text;
    const events: string[] = [];
    let start = 0;
    for (const match of this.buffer.matchAll(/\r\n|\r|\n/g)) {
      // A CR at the very end may be the first half of a CRLF whose LF is in the next chunk.
      if (!final && match[0] === '\r' && match.index === this.buffer.length - 1) break;
      this.line(this.buffer.slice(start, match.index), events);
      start = match.index + match[0].length;
    }
    this.buffer = this.buffer.slice(start);
    if (final) {
      // Lenient: servers sometimes close the stream without the blank line that ends the last event.
      if (this.buffer) this.line(this.buffer, events);
      this.buffer = '';
      this.line('', events);
    }
    return events;
  }

  private line(line: string, events: string[]): void {
    if (line === '') {
      if (this.data.length > 0) events.push(this.data.join('\n'));
      this.data = [];
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    if (field !== 'data') return;
    const value = colon === -1 ? '' : line.slice(colon + 1);
    this.data.push(value.startsWith(' ') ? value.slice(1) : value);
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error('The operation was aborted.');
}

/**
 * Reads a Server-Sent Events stream and yields the data payload of each event.
 * Comments and fields other than `data` are skipped. Stopping the iteration or aborting the
 * signal cancels the underlying stream.
 */
export async function* parseSSE(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<string, void, undefined> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const events = new EventStreamDecoder();
  const onAbort = () => {
    reader.cancel(signal?.reason).catch(() => undefined);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  let finished = false;
  try {
    for (;;) {
      if (signal?.aborted) throw abortReason(signal);
      const { done, value } = await reader.read();
      if (signal?.aborted) throw abortReason(signal);
      if (done) break;
      // One chunk can hold many events: check before each, so nothing is handed out after an abort.
      for (const data of events.feed(decoder.decode(value, { stream: true }))) {
        if (signal?.aborted) throw abortReason(signal);
        yield data;
      }
    }
    finished = true;
    for (const data of events.feed(decoder.decode(), true)) {
      if (signal?.aborted) throw abortReason(signal);
      yield data;
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (!finished) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
