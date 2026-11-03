import { describe, expect, it } from 'vitest';
import { lineStats } from '../../../src/safety/lineStats';

const bytes = (text: string) => new TextEncoder().encode(text);

describe('lineStats', () => {
  it('counts added and removed lines like git', () => {
    expect(lineStats(bytes('a\nb\nc\n'), bytes('a\nB\nc\nd\n'))).toEqual({ additions: 2, deletions: 1 });
    expect(lineStats(null, bytes('one\ntwo'))).toEqual({ additions: 2, deletions: 0 });
    expect(lineStats(bytes('gone\n'), null)).toEqual({ additions: 0, deletions: 1 });
    expect(lineStats(bytes('same\n'), bytes('same\n'))).toEqual({ additions: 0, deletions: 0 });
    expect(lineStats(bytes('x\ny\nz\n'), bytes('y\nz\nx\n'))).toEqual({ additions: 1, deletions: 1 });
  });

  it('reports binary content', () => {
    expect(lineStats(bytes('text'), new Uint8Array([0, 1]))).toEqual({ binary: true });
  });

  it('estimates very different large files instead of diffing them', () => {
    const before = Array.from({ length: 5000 }, (_, i) => `old ${i}`).join('\n');
    const after = Array.from({ length: 5000 }, (_, i) => `new ${i}`).join('\n');
    expect(lineStats(bytes(before), bytes(after))).toEqual({ additions: 5000, deletions: 5000 });
  });
});
