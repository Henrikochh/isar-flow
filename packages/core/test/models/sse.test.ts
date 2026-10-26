import { describe, expect, it } from 'vitest';
import { parseSSE } from '../../src/models/sse';

const encoder = new TextEncoder();

function streamOf(...chunks: (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(typeof c === 'string' ? encoder.encode(c) : c);
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>, signal?: AbortSignal): Promise<string[]> {
  const out: string[] = [];
  for await (const data of parseSSE(stream, signal)) out.push(data);
  return out;
}

describe('parseSSE', () => {
  it('yields the data payload of each event', async () => {
    expect(await collect(streamOf('data: {"a":1}\n\ndata: [DONE]\n\n'))).toEqual(['{"a":1}', '[DONE]']);
  });

  it('accepts CRLF, CR and LF line endings', async () => {
    expect(await collect(streamOf('data: one\r\n\r\ndata: two\r\rdata: three\n\n'))).toEqual([
      'one',
      'two',
      'three',
    ]);
  });

  it('ignores comments and fields other than data', async () => {
    const text = ': keep-alive\n\nevent: message\nid: 7\nretry: 1000\ndata: x\n\n:ping\n\n';
    expect(await collect(streamOf(text))).toEqual(['x']);
  });

  it('joins multi-line data with newlines', async () => {
    expect(await collect(streamOf('data: first\ndata: second\n\n'))).toEqual(['first\nsecond']);
  });

  it('strips exactly one leading space after the colon', async () => {
    expect(await collect(streamOf('data:x\n\ndata:  y\n\ndata\n\n'))).toEqual(['x', ' y', '']);
  });

  it('reassembles events split across chunks, including a CRLF split in half', async () => {
    const stream = streamOf('da', 'ta: hel', 'lo\r', '\n\r', '\ndata: wor', 'ld\n', '\n');
    expect(await collect(stream)).toEqual(['hello', 'world']);
    // A CRLF split after the CR must not end the event early.
    expect(await collect(streamOf('data: a\r', '\ndata: b\r\n\r\n'))).toEqual(['a\nb']);
  });

  it('yields every event of a chunk that holds several', async () => {
    expect(await collect(streamOf('data: 1\n\ndata: 2\n\ndata: 3\n\n'))).toEqual(['1', '2', '3']);
  });

  it('decodes multi-byte characters split across chunks', async () => {
    const bytes = encoder.encode('data: Grüße 🌊\n\n');
    const pieces = Array.from(bytes, (b) => Uint8Array.of(b));
    expect(await collect(streamOf(...pieces))).toEqual(['Grüße 🌊']);
  });

  it('dispatches a final event that lacks the trailing blank line', async () => {
    expect(await collect(streamOf('data: a\n\ndata: last'))).toEqual(['a', 'last']);
    expect(await collect(streamOf('data: cr-terminated\r'))).toEqual(['cr-terminated']);
  });

  it('yields nothing for an empty stream', async () => {
    expect(await collect(streamOf())).toEqual([]);
  });

  it('stops promptly when the signal aborts and cancels the stream', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: first\n\n'));
      },
      cancel() {
        cancelled = true;
      },
    });
    const controller = new AbortController();
    const iterator = parseSSE(stream, controller.signal)[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({ done: false, value: 'first' });
    const pending = iterator.next();
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(cancelled).toBe(true);
  });

  it('yields nothing more after an abort, even from the chunk already read', async () => {
    const controller = new AbortController();
    const received: string[] = [];
    const run = (async () => {
      for await (const data of parseSSE(streamOf('data: 1\n\ndata: 2\n\ndata: 3\n\n'), controller.signal)) {
        received.push(data);
        controller.abort();
      }
    })();
    await expect(run).rejects.toThrow();
    expect(received).toEqual(['1']);
  });

  it('throws right away when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(collect(streamOf('data: x\n\n'), controller.signal)).rejects.toThrow();
  });

  it('cancels the stream when the consumer stops early', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: one\n\ndata: two\n\n'));
      },
      cancel() {
        cancelled = true;
      },
    });
    for await (const data of parseSSE(stream)) {
      expect(data).toBe('one');
      break;
    }
    expect(cancelled).toBe(true);
  });
});
