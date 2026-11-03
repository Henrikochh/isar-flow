import { describe, expect, it } from 'vitest';
import { capDiff, GIT_CHANGED_FILES_MAX, GIT_DIFF_MAX_BYTES } from '../../../src/node/git';
import { parseStatusZ } from '../../../src/node/git/status';

const bytes = (text: string) => new TextEncoder().encode(text).length;

describe('git capture limits', () => {
  it('caps the diff at 100 KB and the changed files at 1,000', () => {
    expect(GIT_DIFF_MAX_BYTES).toBe(102400);
    expect(GIT_CHANGED_FILES_MAX).toBe(1000);
  });
});

describe('capDiff', () => {
  const diff = Array.from({ length: 50 }, (_, i) => `+line ${String(i).padStart(2, '0')}`).join('\n') + '\n';

  it('keeps a diff that fits', () => {
    expect(capDiff(diff, 10_000)).toBe(diff);
    expect(capDiff('', 10)).toBe('');
    expect(capDiff(diff, bytes(diff))).toBe(diff);
  });

  it('cuts at a line boundary and says how much was left out', () => {
    const result = capDiff(diff, 200, '1 file changed, 50 insertions(+)');
    const kept = Array.from({ length: 13 }, (_, i) => `+line ${String(i).padStart(2, '0')}`).join('\n');
    expect(result).toBe(`${kept}\n… The diff was shortened to 200 bytes (1 file changed, 50 insertions(+)).`);
    expect(bytes(result)).toBeLessThanOrEqual(200);
  });

  it('names the cap in KB and works without a total', () => {
    const big = '+'.repeat(80).concat('\n').repeat(3000);
    const result = capDiff(big, GIT_DIFF_MAX_BYTES);
    expect(result.endsWith('\n… The diff was shortened to 100 KB.')).toBe(true);
    expect(bytes(result)).toBeLessThanOrEqual(GIT_DIFF_MAX_BYTES);
    expect(
      result
        .split('\n')
        .slice(0, -1)
        .every((line) => line === '+'.repeat(80)),
    ).toBe(true);
    expect(capDiff(big, 1536)).toMatch(/shortened to 1\.5 KB\.$/);
  });

  it('drops the carriage return of CRLF lines at the cut', () => {
    const crlf = '+a\r\n+b\r\n+c\r\n'.repeat(20);
    expect(capDiff(crlf, 70)).toBe(
      '+a\r\n+b\r\n+c\r\n+a\r\n+b\r\n+c\r\n+a\n… The diff was shortened to 70 bytes.',
    );
  });

  it('cuts one long line at a character boundary', () => {
    const result = capDiff(`+${'é'.repeat(500)}`, 100);
    expect(result).toMatch(/^\+é+\n… The diff was shortened to 100 bytes\.$/);
    expect(bytes(result)).toBeLessThanOrEqual(100);
    expect(result).not.toContain('�');
  });

  it('removes a broken character at the end of a cut stream', () => {
    const stream = `+ok\n+${'x'.repeat(300)}�`;
    expect(capDiff(stream, 120)).toBe('+ok\n… The diff was shortened to 120 bytes.');
  });

  it('is only the note when nothing else fits', () => {
    expect(capDiff(diff, 30)).toBe('… The diff was shortened to 30 bytes.');
  });
});

describe('parseStatusZ', () => {
  it('lists changed, untracked, deleted and renamed (new path) files sorted and unique', () => {
    const output = [
      ' M src/b.ts',
      '?? new file.txt',
      ' D old.ts',
      'R  src/renamed.ts',
      'src/original.ts',
      'MM src/b.ts',
      'A  ä ö.md',
      '',
    ].join('\0');
    expect(parseStatusZ(output, '')).toEqual([
      'new file.txt',
      'old.ts',
      'src/b.ts',
      'src/renamed.ts',
      'ä ö.md',
    ]);
  });

  it('reads copies and renames in the work tree', () => {
    expect(parseStatusZ(['C  b.ts', 'a.ts', ' R c.ts', 'd.ts', ''].join('\0'), '')).toEqual(['b.ts', 'c.ts']);
  });

  it('makes paths relative to a subfolder and drops files outside it', () => {
    const output = [
      ' M packages/app/src/a.ts',
      ' M packages/other/b.ts',
      '?? Packages/App/c.ts',
      'R  packages/app/x.ts',
      'y.ts',
      '',
    ].join('\0');
    expect(parseStatusZ(output, 'packages/app/')).toEqual(['c.ts', 'src/a.ts', 'x.ts']);
  });

  it('ignores an unfinished last entry and short garbage', () => {
    expect(parseStatusZ(' M a.ts\0?? b', '')).toEqual(['a.ts']);
    expect(parseStatusZ('x\0\0', '')).toEqual([]);
  });

  it('keeps at most 1,000 paths', () => {
    const output = Array.from({ length: 1200 }, (_, i) => `?? f${String(i).padStart(4, '0')}.txt\0`).join('');
    const files = parseStatusZ(output, '');
    expect(files).toHaveLength(1000);
    expect(files[0]).toBe('f0000.txt');
    expect(files[999]).toBe('f0999.txt');
  });
});
