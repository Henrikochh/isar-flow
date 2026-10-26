import { describe, expect, it } from 'vitest';
import { CappedText } from '../../../src/runner/capture';

describe('CappedText', () => {
  it('keeps everything below the limit', () => {
    const text = new CappedText(20);
    text.append('hello ');
    text.append('world');
    expect(text.toString()).toBe('hello world');
    expect(text.truncated).toBe(false);
  });

  it('keeps head and tail with a marker counting the omitted bytes', () => {
    const text = new CappedText(10);
    text.append('0123456789');
    text.append('abcdefghij');
    expect(text.truncated).toBe(true);
    expect(text.toString()).toBe('01234\n… 10 bytes omitted …\nfghij');
  });

  it('counts omitted bytes as UTF-8', () => {
    const text = new CappedText(4);
    text.append('ab');
    text.append('ü€');
    text.append('xyz');
    // head 'ab', tail 'yz', omitted 'ü€x' = 2 + 3 + 1 bytes
    expect(text.toString()).toBe('ab\n… 6 bytes omitted …\nyz');
  });

  it('does not split surrogate pairs', () => {
    const text = new CappedText(4);
    text.append('a😀b😀c😀');
    const result = text.toString();
    expect(result).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(result).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });

  it('stays bounded with many small chunks', () => {
    const text = new CappedText(1000);
    for (let i = 0; i < 100_000; i++) text.append('line\n');
    const result = text.toString();
    expect(result.length).toBeLessThan(1100);
    expect(result).toContain('bytes omitted');
    expect(result.endsWith('line\n')).toBe(true);
  });

  it('puts the marker on its own line after a head ending in a newline', () => {
    const text = new CappedText(8);
    text.append('abc\n');
    text.append('x'.repeat(20));
    expect(text.toString()).toBe('abc\n… 16 bytes omitted …\nxxxx');
  });
});
