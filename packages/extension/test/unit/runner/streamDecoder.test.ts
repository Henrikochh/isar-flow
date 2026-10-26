import { describe, expect, it } from 'vitest';
import { StreamDecoder } from '../../../src/runner/streamDecoder';

describe('StreamDecoder', () => {
  it('keeps multibyte characters that are split across chunks', () => {
    const bytes = Buffer.from('Grüße ✓', 'utf8');
    const decoder = new StreamDecoder();
    let text = '';
    for (const byte of bytes) text += decoder.write(Uint8Array.of(byte));
    text += decoder.end();
    expect(text).toBe('Grüße ✓');
  });

  it('turns CRLF into LF, also across chunk boundaries', () => {
    const decoder = new StreamDecoder();
    const parts = [decoder.write(Buffer.from('a\r')), decoder.write(Buffer.from('\nb\r\nc')), decoder.end()];
    expect(parts.join('')).toBe('a\nb\nc');
    expect(parts[0]).toBe('a');
  });

  it('keeps a lone carriage return', () => {
    const decoder = new StreamDecoder();
    const text =
      decoder.write(Buffer.from('10%\r20%\r')) + decoder.write(Buffer.from('done')) + decoder.end();
    expect(text).toBe('10%\r20%\rdone');
  });

  it('flushes a trailing carriage return at the end', () => {
    const decoder = new StreamDecoder();
    expect(decoder.write(Buffer.from('x\r')) + decoder.end()).toBe('x\r');
  });

  it('drops a UTF-8 byte order mark', () => {
    const decoder = new StreamDecoder();
    expect(decoder.write(Buffer.from([0xef, 0xbb, 0xbf, 0x68, 0x69])) + decoder.end()).toBe('hi');
  });
});
