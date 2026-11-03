import { describe, expect, it } from 'vitest';
import { planFile } from '../../../src/tools/patchApply';
import { parseUnifiedDiff } from '../../../src/tools/unifiedDiff';

const lines = (...texts: string[]) => texts.join('\n');
const numbered = (count: number, from = 1) =>
  Array.from({ length: count }, (_, i) => `line ${i + from}`).join('\n') + '\n';

function plan(current: string | undefined, ...patch: string[]) {
  const [file] = parseUnifiedDiff(lines(...patch));
  return planFile(file, file.newPath ?? file.oldPath ?? '', current);
}

const modify = (...hunks: string[]) => ['--- a/f.txt', '+++ b/f.txt', ...hunks];

describe('planFile', () => {
  it('applies a hunk at its stated line and counts the lines', () => {
    expect(plan('a\nb\nc\n', ...modify('@@ -1,3 +1,3 @@', ' a', '-b', '+B', '+B2', ' c'))).toEqual({
      ok: true,
      content: 'a\nB\nB2\nc\n',
      added: 2,
      removed: 1,
      notes: [],
    });
  });

  it('finds a hunk whose line number drifted and says where it matched', () => {
    const text = `header 1\nheader 2\n${numbered(20)}`;
    const result = plan(text, ...modify('@@ -5,3 +5,3 @@', ' line 5', '-line 6', '+line six', ' line 7'));
    expect(result).toMatchObject({ ok: true, notes: ['f.txt hunk 1 matched at line 7 instead of line 5.'] });
    expect(result.ok && result.content).toContain('line 5\nline six\nline 7\n');
  });

  it('shifts later hunks by the drift of earlier ones', () => {
    const text = `extra\n${numbered(30)}`;
    const result = plan(
      text,
      ...modify('@@ -2,1 +2,1 @@', '-line 2', '+two', '@@ -20,1 +20,1 @@', '-line 20', '+twenty'),
    );
    expect(result.ok && result.content).toContain('line 1\ntwo\nline 3');
    expect(result.ok && result.content).toContain('line 19\ntwenty\nline 21');
  });

  it('prefers the match nearest to the stated line when the context repeats', () => {
    const text = lines('x', 'dup', 'y', ...Array.from({ length: 10 }, (_, i) => `f${i}`), 'dup', 'z', '');
    const result = plan(text, ...modify('@@ -13,1 +13,1 @@', '-dup', '+DUP'));
    expect(result.ok && result.content).toBe(
      lines('x', 'dup', 'y', ...Array.from({ length: 10 }, (_, i) => `f${i}`), 'DUP', 'z', ''),
    );
  });

  it('searches the whole file when the hunk is far away or has no line number', () => {
    const text = `${numbered(500)}target\n`;
    const far = plan(text, ...modify('@@ -2,1 +2,1 @@', '-target', '+found'));
    expect(far).toMatchObject({ ok: true, notes: ['f.txt hunk 1 matched at line 501 instead of line 2.'] });
    const unnumbered = plan('a\nb\nc\n', ...modify('@@ @@', ' b', '-c', '+C'));
    expect(unnumbered).toMatchObject({ ok: true, content: 'a\nb\nC\n', notes: [] });
  });

  it('refuses context that matches several places without a line number', () => {
    expect(plan('a\nx\na\nx\n', ...modify('@@ @@', ' a', '-x', '+y'))).toEqual({
      ok: false,
      failures: [
        'f.txt hunk 1 (@@ @@): the context matches 2 places. Add more context lines so it matches once.',
      ],
    });
  });

  it('matches ignoring trailing whitespace without a note and keeps the file lines', () => {
    const result = plan('a  \nb\t\nc\n', ...modify('@@ -1,3 +1,3 @@', ' a', '-b', '+B', ' c'));
    expect(result).toEqual({ ok: true, content: 'a  \nB\nc\n', added: 1, removed: 1, notes: [] });
  });

  it('matches ignoring indentation and re-indents added lines from the file', () => {
    const text = 'function f() {\n\tif (x) {\n\t\treturn 1;\n\t}\n}\n';
    const result = plan(
      text,
      ...modify('@@ -2,3 +2,4 @@', '   if (x) {', '-    return 1;', '+    log(x);', '+    return 2;', '   }'),
    );
    expect(result).toEqual({
      ok: true,
      content: 'function f() {\n\tif (x) {\n\t\tlog(x);\n\t\treturn 2;\n\t}\n}\n',
      added: 2,
      removed: 1,
      notes: ['f.txt hunk 1 matched ignoring whitespace; the indentation was taken from the file.'],
    });
  });

  it('keeps CRLF line endings of the file for an LF patch', () => {
    const result = plan('a\r\nb\r\nc\r\n', ...modify('@@ -1,3 +1,4 @@', ' a', '-b', '+B', '+B2', ' c'));
    expect(result.ok && result.content).toBe('a\r\nB\r\nB2\r\nc\r\n');
  });

  it('keeps a missing final newline when a hunk adds lines at the end', () => {
    const result = plan(
      'a\nb',
      ...modify(
        '@@ -1,2 +1,3 @@',
        ' a',
        ' b',
        '\\ No newline at end of file',
        '+c',
        '\\ No newline at end of file',
      ),
    );
    expect(result.ok && result.content).toBe('a\nb\nc');
    const removed = plan('a\nb', ...modify('@@ -1,2 +1,1 @@', ' a', '-b'));
    expect(removed.ok && removed.content).toBe('a');
    const kept = plan('a\nb\n', ...modify('@@ -2,1 +2,2 @@', ' b', '+c'));
    expect(kept.ok && kept.content).toBe('a\nb\nc\n');
  });

  it('inserts at the start of a file and into an empty file', () => {
    expect(plan('a\n', ...modify('@@ -0,0 +1,1 @@', '+first'))).toMatchObject({ content: 'first\na\n' });
    expect(plan('', ...modify('@@ -0,0 +1,2 @@', '+one', '+two'))).toMatchObject({ content: 'one\ntwo\n' });
    expect(plan('a\nb\n', ...modify('@@ -1,0 +2,1 @@', '+after a'))).toMatchObject({
      content: 'a\nafter a\nb\n',
    });
  });

  it('refuses an insertion without context or line number in a non-empty file', () => {
    expect(plan('a\n', ...modify('@@ @@', '+x'))).toEqual({
      ok: false,
      failures: [
        'f.txt hunk 1 (@@ @@): the hunk has no context lines and no line number, so its place is unknown. ' +
          'Add a few unchanged lines around the change.',
      ],
    });
  });

  it('reports every failing hunk with the first differing line', () => {
    const text = 'one\ntwo\nthree\nfour\nfive\nsix\n';
    const result = plan(
      text,
      ...modify(
        '@@ -1,2 +1,2 @@',
        ' one',
        '-TWO',
        '+2',
        '@@ -4,2 +4,2 @@',
        ' four',
        '-five',
        '+5',
        '@@ -6,1 +6,1 @@',
        '-seven',
        '+7',
      ),
    );
    expect(result).toEqual({
      ok: false,
      failures: [
        'f.txt hunk 1 (@@ -1,2 +1,2 @@): the context was not found near line 1; ' +
          'first differing line: "TWO" (line 2 of the file: "two").',
        'f.txt hunk 3 (@@ -6,1 +6,1 @@): the context was not found near line 6; ' +
          'first differing line: "seven" (line 6 of the file: "six").',
      ],
    });
  });

  it('says when the file ends before the context', () => {
    const result = plan('a\n', ...modify('@@ -1,2 +1,2 @@', ' a', '-b', '+c'));
    expect(result).toEqual({
      ok: false,
      failures: [
        'f.txt hunk 1 (@@ -1,2 +1,2 @@): the context was not found near line 1; ' +
          'first differing line: "b" (the file has only 1 line).',
      ],
    });
  });

  it('names a line that is missing from the file when the hunk has no line number', () => {
    const result = plan('a\nb\n', ...modify('@@ @@', ' a', '-zzz', '+y'));
    expect(result).toEqual({
      ok: false,
      failures: ['f.txt hunk 1 (@@ @@): the context was not found; "zzz" is not in the file.'],
    });
    const order = plan('a\nb\n', ...modify('@@ @@', ' b', '-a', '+y'));
    expect(order).toEqual({
      ok: false,
      failures: [
        'f.txt hunk 1 (@@ @@): the context was not found; its lines are in the file, but not in this order.',
      ],
    });
  });

  it('refuses hunks that overlap or go backwards', () => {
    const result = plan(
      'a\nb\nc\nd\n',
      ...modify('@@ -2,2 +2,2 @@', ' b', '-c', '+C', '@@ -1,2 +1,2 @@', ' a', '-b', '+B'),
    );
    expect(result).toEqual({
      ok: false,
      failures: [
        'f.txt hunk 2 (@@ -1,2 +1,2 @@): it overlaps an earlier hunk or comes before it. ' +
          'Hunks must be in file order and must not overlap.',
      ],
    });
  });

  it('refuses a patch for a missing file', () => {
    expect(plan(undefined, ...modify('@@ -1 +1 @@', '-a', '+b'))).toEqual({
      ok: false,
      failures: [
        'f.txt does not exist. To create it, start its section with "--- /dev/null" and "+++ b/f.txt".',
      ],
    });
  });

  describe('created files', () => {
    const create = ['--- /dev/null', '+++ b/new.txt', '@@ -0,0 +1,2 @@', '+one', '+two'];

    it('builds the content from the added lines', () => {
      expect(plan(undefined, ...create)).toEqual({
        ok: true,
        content: 'one\ntwo\n',
        added: 2,
        removed: 0,
        notes: [],
      });
      expect(plan(undefined, ...create, '\\ No newline at end of file')).toMatchObject({
        content: 'one\ntwo',
      });
    });

    it('creates an empty file from a git header without hunks', () => {
      const [file] = parseUnifiedDiff(lines('diff --git a/e.txt b/e.txt', 'new file mode 100644'));
      expect(planFile(file, 'e.txt', undefined)).toEqual({
        ok: true,
        content: '',
        added: 0,
        removed: 0,
        notes: [],
      });
    });

    it('refuses to create a file that exists', () => {
      expect(plan('old\n', ...create)).toEqual({
        ok: false,
        failures: [
          'new.txt already exists, so the patch cannot create it. Read it and make a patch that changes it.',
        ],
      });
    });
  });

  describe('deleted files', () => {
    const remove = ['--- a/old.txt', '+++ /dev/null', '@@ -1,2 +0,0 @@', '-one', '-two'];

    it('deletes a file whose content matches the removed lines', () => {
      expect(plan('one\ntwo\n', ...remove)).toEqual({
        ok: true,
        content: null,
        added: 0,
        removed: 2,
        notes: [],
      });
      expect(plan('one  \r\ntwo\r\n\r\n', ...remove)).toMatchObject({ ok: true, content: null });
    });

    it('refuses when the content differs or the file is missing', () => {
      expect(plan('one\ntwo\nthree\n', ...remove)).toEqual({
        ok: false,
        failures: [
          'old.txt does not match the lines the patch removes, so it was not deleted (line 3 of the file: "three").',
        ],
      });
      expect(plan('one\nTWO\n', ...remove)).toMatchObject({
        failures: [expect.stringContaining('(line 2 of the file: "TWO")')],
      });
      expect(plan(undefined, ...remove)).toEqual({
        ok: false,
        failures: ['old.txt does not exist, so the patch cannot delete it.'],
      });
    });

    it('deletes an empty file from a git header without hunks', () => {
      const [file] = parseUnifiedDiff(lines('diff --git a/e.txt b/e.txt', 'deleted file mode 100644'));
      expect(planFile(file, 'e.txt', '')).toMatchObject({ ok: true, content: null });
      expect(planFile(file, 'e.txt', 'text\n')).toMatchObject({ ok: false });
    });
  });
});
