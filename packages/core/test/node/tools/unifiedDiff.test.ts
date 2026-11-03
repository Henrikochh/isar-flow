import { describe, expect, it } from 'vitest';
import { parseUnifiedDiff } from '../../../src/node/tools/unifiedDiff';

const lines = (...texts: string[]) => texts.join('\n');

describe('parseUnifiedDiff', () => {
  it('reads a git diff with index lines, a/ b/ prefixes and a section heading', () => {
    const patch = lines(
      'diff --git a/src/app.ts b/src/app.ts',
      'index 3b18e51..a9c2f04 100644',
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -1,3 +1,3 @@ function main() {',
      ' const a = 1;',
      '-const b = 2;',
      '+const b = 3;',
      ' const c = 3;',
      '',
    );
    expect(parseUnifiedDiff(patch)).toEqual([
      {
        oldPath: 'src/app.ts',
        newPath: 'src/app.ts',
        hunks: [
          {
            header: '@@ -1,3 +1,3 @@',
            oldStart: 1,
            oldCount: 3,
            newStart: 1,
            newCount: 3,
            noNewlineAtEnd: false,
            lines: [
              { kind: ' ', text: 'const a = 1;' },
              { kind: '-', text: 'const b = 2;' },
              { kind: '+', text: 'const b = 3;' },
              { kind: ' ', text: 'const c = 3;' },
            ],
          },
        ],
      },
    ]);
  });

  it('reads several files and several hunks per file', () => {
    const patch = lines(
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1,2 +1,2 @@',
      '-one',
      '+uno',
      ' two',
      '@@ -10,2 +10,3 @@',
      ' ten',
      '+ten and a half',
      ' eleven',
      '--- a/b.ts',
      '+++ b/b.ts',
      '@@ -5 +5 @@',
      '-x',
      '+y',
    );
    const files = parseUnifiedDiff(patch);
    expect(files.map((f) => [f.oldPath, f.hunks.length])).toEqual([
      ['a.ts', 2],
      ['b.ts', 1],
    ]);
    expect(files[0].hunks[1].lines).toHaveLength(3);
    expect(files[1].hunks[0]).toMatchObject({ header: '@@ -5 +5 @@', oldStart: 5, newStart: 5 });
    expect(files[1].hunks[0].oldCount).toBeUndefined();
  });

  it('reads created and deleted files', () => {
    const patch = lines(
      'diff --git a/src/new.ts b/src/new.ts',
      'new file mode 100644',
      'index 0000000..e69de29',
      '--- /dev/null',
      '+++ b/src/new.ts',
      '@@ -0,0 +1,2 @@',
      '+export const x = 1;',
      '+export const y = 2;',
      'diff --git a/src/old.ts b/src/old.ts',
      'deleted file mode 100644',
      '--- a/src/old.ts',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-gone',
    );
    const [created, deleted] = parseUnifiedDiff(patch);
    expect(created).toMatchObject({ oldPath: null, newPath: 'src/new.ts' });
    expect(deleted).toMatchObject({ oldPath: 'src/old.ts', newPath: null });
    expect(deleted.hunks[0].lines).toEqual([{ kind: '-', text: 'gone' }]);
  });

  it('reads git headers of empty files without hunks', () => {
    const patch = lines(
      'diff --git a/empty.txt b/empty.txt',
      'new file mode 100644',
      'index 0000000..e69de29',
      'diff --git a/gone.txt b/gone.txt',
      'deleted file mode 100644',
      'index e69de29..0000000',
      'diff --git a/script.sh b/script.sh',
      'old mode 100644',
      'new mode 100755',
    );
    expect(parseUnifiedDiff(patch)).toEqual([
      { oldPath: null, newPath: 'empty.txt', hunks: [] },
      { oldPath: 'gone.txt', newPath: null, hunks: [] },
    ]);
  });

  it('reads the no-newline marker of the new side', () => {
    const patch = lines(
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1 +1 @@',
      '-old',
      '\\ No newline at end of file',
      '+new',
      '\\ No newline at end of file',
    );
    const [file] = parseUnifiedDiff(patch);
    expect(file.hunks[0].lines).toEqual([
      { kind: '-', text: 'old' },
      { kind: '+', text: 'new' },
    ]);
    expect(file.hunks[0].noNewlineAtEnd).toBe(true);
    const onlyOld = parseUnifiedDiff(lines('--- a/a', '+++ b/a', '@@ -1 +1 @@', '-x', '\\ No newline', '+y'));
    expect(onlyOld[0].hunks[0].noNewlineAtEnd).toBe(false);
  });

  it('reads CRLF patch text', () => {
    const patch = '--- a/a.txt\r\n+++ b/a.txt\r\n@@ -1,2 +1,2 @@\r\n-x\r\n+y\r\n z\r\n';
    expect(parseUnifiedDiff(patch)[0].hunks[0].lines).toEqual([
      { kind: '-', text: 'x' },
      { kind: '+', text: 'y' },
      { kind: ' ', text: 'z' },
    ]);
  });

  it('ignores prose and code fences around the diff', () => {
    const patch = lines(
      'Here is the fix:',
      '',
      '```diff',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1,2 +1,2 @@',
      ' keep',
      '-x',
      '+y',
      '```',
      '',
      '- This bullet is prose.',
      'That changes x to y.',
    );
    const [file] = parseUnifiedDiff(patch);
    expect(file.hunks[0].lines).toEqual([
      { kind: ' ', text: 'keep' },
      { kind: '-', text: 'x' },
      { kind: '+', text: 'y' },
    ]);
  });

  it('keeps hunks of a file that are separated by prose', () => {
    const patch = lines(
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1,1 +1,1 @@',
      '-x',
      '+y',
      '',
      'And further down:',
      '@@ -20,1 +20,1 @@',
      '-z',
      '+w',
    );
    expect(parseUnifiedDiff(patch)[0].hunks.map((hunk) => hunk.header)).toEqual([
      '@@ -1,1 +1,1 @@',
      '@@ -20,1 +20,1 @@',
    ]);
  });

  it('reads hunks without counts and without line numbers', () => {
    const patch = lines('--- a.txt', '+++ a.txt', '@@ @@', ' a', '-b', '+c', '@@ -12 +12 @@', '-d', '+e');
    const [file] = parseUnifiedDiff(patch);
    expect(file.oldPath).toBe('a.txt');
    expect(file.hunks[0]).toMatchObject({ header: '@@ @@', lines: expect.any(Array) });
    expect(file.hunks[0].oldStart).toBeUndefined();
    expect(file.hunks[1]).toMatchObject({ oldStart: 12, newStart: 12 });
  });

  it('reads tab-separated timestamps and quoted paths', () => {
    const patch = lines(
      '--- "a/docs/caf\\303\\251 notes.md"\t2026-11-01 10:00:00.000000000 +0100',
      '+++ "b/docs/caf\\303\\251 notes.md"\t2026-11-02 10:00:00.000000000 +0100',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      '--- old name.txt\t2026-11-01 10:00:00',
      '+++ old name.txt\t2026-11-02 10:00:00',
      '@@ -1 +1 @@',
      '-a',
      '+b',
    );
    expect(parseUnifiedDiff(patch).map((f) => f.newPath)).toEqual(['docs/café notes.md', 'old name.txt']);
  });

  it('strips timestamps separated by spaces', () => {
    const patch = lines(
      '--- a.txt 2026-11-01 10:00:00 +0100',
      '+++ a.txt 2026-11-02 10:00',
      '@@ -1 +1 @@',
      '-a',
      '+b',
    );
    expect(parseUnifiedDiff(patch)[0].newPath).toBe('a.txt');
  });

  it('accepts paths with a prefix on one side only', () => {
    const patch = lines('--- a/src/x.ts', '+++ src/x.ts', '@@ -1 +1 @@', '-a', '+b');
    expect(parseUnifiedDiff(patch)[0]).toMatchObject({ oldPath: 'src/x.ts', newPath: 'src/x.ts' });
    const other = lines('--- src/x.ts', '+++ b/src/x.ts', '@@ -1 +1 @@', '-a', '+b');
    expect(parseUnifiedDiff(other)[0]).toMatchObject({ oldPath: 'src/x.ts', newPath: 'src/x.ts' });
  });

  it('reads blank context lines that lost their space and drops blank lines after a hunk', () => {
    const patch = lines('--- a/a.txt', '+++ b/a.txt', '@@ -1,4 +1,4 @@', ' a', '', '-b', '+c', ' d', '', '');
    expect(parseUnifiedDiff(patch)[0].hunks[0].lines).toEqual([
      { kind: ' ', text: 'a' },
      { kind: ' ', text: '' },
      { kind: '-', text: 'b' },
      { kind: '+', text: 'c' },
      { kind: ' ', text: 'd' },
    ]);
  });

  it('reads removed lines that look like file headers while the counts say the hunk goes on', () => {
    const patch = lines('--- a/a.md', '+++ b/a.md', '@@ -1,2 +1,2 @@', '--- a', '+++ b', '+c');
    expect(parseUnifiedDiff(patch)[0].hunks[0].lines).toEqual([
      { kind: '-', text: '-- a' },
      { kind: '+', text: '++ b' },
      { kind: '+', text: 'c' },
    ]);
  });

  it('keeps reading when the counts are too small', () => {
    const patch = lines('--- a/a.txt', '+++ b/a.txt', '@@ -1,1 +1,1 @@', '-a', '+b', '+c', ' d');
    expect(parseUnifiedDiff(patch)[0].hunks[0].lines).toHaveLength(4);
  });

  describe('refuses', () => {
    const refuse = (patch: string) => {
      try {
        parseUnifiedDiff(patch);
      } catch (error) {
        return (error as Error).message;
      }
      throw new Error('The patch was accepted.');
    };

    it('text without a diff', () => {
      expect(refuse('Please change line 3 to say hello.')).toMatch(
        /^The patch has no file changes\. Write a unified diff/,
      );
      expect(refuse('@@ -1 +1 @@\n-a\n+b')).toMatch(/^The patch has no file changes/);
    });

    it('renames, copies and binary files', () => {
      expect(
        refuse(
          lines('diff --git a/a.ts b/b.ts', 'similarity index 100%', 'rename from a.ts', 'rename to b.ts'),
        ),
      ).toMatch(/^applyPatch cannot rename or copy files \(a\.ts to b\.ts\)\./);
      expect(
        refuse(lines('diff --git a/a.ts b/c.ts', 'similarity index 90%', 'copy from a.ts', 'copy to c.ts')),
      ).toMatch(/cannot rename or copy files \(a\.ts to c\.ts\)/);
      expect(
        refuse(
          lines(
            'diff --git a/logo.png b/logo.png',
            'index 1..2 100644',
            'Binary files a/logo.png and b/logo.png differ',
          ),
        ),
      ).toBe('applyPatch cannot change binary files (logo.png). Leave binary files out of the patch.');
      expect(refuse(lines('diff --git a/x.bin b/x.bin', 'GIT binary patch', 'literal 5'))).toMatch(
        /cannot change binary files \(x\.bin\)/,
      );
    });

    it('different old and new paths', () => {
      expect(refuse(lines('--- a/one.ts', '+++ b/two.ts', '@@ -1 +1 @@', '-a', '+b'))).toMatch(
        /cannot rename or copy files \(one\.ts to two\.ts\)/,
      );
    });

    it('the same file twice, also when it is deleted and created again', () => {
      const twice = lines(
        '--- a/a',
        '+++ b/a',
        '@@ -1 +1 @@',
        '-x',
        '+y',
        '--- a/a',
        '+++ b/a',
        '@@ -3 +3 @@',
        '-z',
        '+w',
      );
      expect(refuse(twice)).toBe(
        'The patch changes a more than once. Put all changes to a file into one section.',
      );
      const recreate = lines(
        '--- a/a',
        '+++ /dev/null',
        '@@ -1 +0,0 @@',
        '-x',
        '--- /dev/null',
        '+++ b/a',
        '@@ -0,0 +1 @@',
        '+y',
      );
      expect(refuse(recreate)).toMatch(/^The patch changes a more than once/);
    });

    it('files without hunks and empty hunks', () => {
      expect(refuse(lines('--- a/a', '+++ b/a'))).toBe(
        'The patch for a has no hunks. Add the changes as hunks that start with "@@".',
      );
      expect(refuse(lines('--- a/a', '+++ b/a', '@@ -1 +1 @@', '@@ -2 +2 @@', '-x', '+y'))).toBe(
        'Hunk 1 of a (@@ -1 +1 @@) has no lines. Add the lines to remove ("-"), add ("+") and keep (" ").',
      );
    });

    it('created files with old lines and deleted files with new lines', () => {
      expect(refuse(lines('--- /dev/null', '+++ b/n.ts', '@@ -0,0 +1,2 @@', ' a', '+b'))).toBe(
        'The patch creates n.ts ("--- /dev/null"), so its hunks can only add lines ("+").',
      );
      expect(refuse(lines('--- a/o.ts', '+++ /dev/null', '@@ -1,2 +0,0 @@', '-a', '+b'))).toBe(
        'The patch deletes o.ts ("+++ /dev/null"), so its hunks cannot add lines ("+").',
      );
      expect(refuse(lines('--- /dev/null', '+++ /dev/null', '@@ -0,0 +1 @@', '+b'))).toMatch(
        /^The patch has "\/dev\/null" on both sides/,
      );
    });
  });
});
