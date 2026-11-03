import { describe, expect, it } from 'vitest';
import { globMatcher } from '../../../src/tools/glob';

describe('globMatcher', () => {
  const table: [glob: string, matches: string[], misses: string[]][] = [
    ['**/*.ts', ['a.ts', 'src/a.ts', 'src/x/y/a.ts', '.hidden.ts'], ['a.tsx', 'a.ts/b', 'src/a.js']],
    ['src/*.ts', ['src/a.ts'], ['src/x/a.ts', 'a.ts', 'lib/src/a.ts']],
    ['*.{ts,js}', ['a.ts', 'b.js'], ['a.css', 'src/a.ts']],
    ['file?.txt', ['file1.txt', 'fileA.txt'], ['file.txt', 'file12.txt', 'file/.txt']],
    ['[abc].md', ['a.md', 'c.md'], ['d.md', 'ab.md']],
    ['[!abc].md', ['d.md'], ['a.md', '/.md']],
    ['[^a-c].md', ['d.md'], ['b.md']],
    ['[a-c]x', ['bx'], ['dx']],
    ['**', ['a', 'a/b/c.txt'], []],
    ['src/**', ['src/a', 'src/a/b.ts'], ['lib/a', 'srcx/a']],
    ['**/test/**', ['test/a.ts', 'a/test/b/c.ts'], ['tests/a.ts', 'a/btest/c.ts']],
    ['a+b(1).txt', ['a+b(1).txt'], ['aab1.txt']],
    ['{a,{b,c}}.ts', ['a.ts', 'b.ts', 'c.ts'], ['d.ts']],
    ['{src,lib}/**/*.ts', ['src/a.ts', 'lib/x/b.ts'], ['test/a.ts']],
    ['a**b', ['ab', 'axxb'], ['a/b']],
    ['[unclosed', ['[unclosed'], ['u']],
    ['{unclosed', ['{unclosed'], ['unclosed']],
    ['notes.txt', ['notes.txt'], ['notes.txt.bak', 'x/notes.txt']],
    ['{}x', ['x'], ['{}x']],
  ];

  for (const [glob, matches, misses] of table) {
    it(glob, () => {
      const match = globMatcher(glob);
      for (const path of matches) expect(match(path), `${glob} should match ${path}`).toBe(true);
      for (const path of misses) expect(match(path), `${glob} should not match ${path}`).toBe(false);
    });
  }

  it('ignores case when asked', () => {
    expect(globMatcher('src/*.TS', { ignoreCase: true })('SRC/a.ts')).toBe(true);
    expect(globMatcher('src/*.TS')('SRC/a.ts')).toBe(false);
  });
});
