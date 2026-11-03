import { describe, expect, it } from 'vitest';
import { replaceOnce } from '../../../src/node/tools/tolerantMatch';
import {
  dominantEol,
  joinTextLines,
  reindent,
  indentMap,
  splitTextLines,
} from '../../../src/node/tools/lines';

describe('replaceOnce', () => {
  const cases: {
    name: string;
    text: string;
    oldText: string;
    newText: string;
    mode: 'exact' | 'lineEndings' | 'whitespace';
    content: string;
  }[] = [
    {
      name: 'exact text inside a line',
      text: 'const a = 1;\nconst b = 2;\n',
      oldText: 'b = 2',
      newText: 'b = 3',
      mode: 'exact',
      content: 'const a = 1;\nconst b = 3;\n',
    },
    {
      name: 'LF text in a CRLF file (counts as exact, keeps CRLF)',
      text: 'one\r\ntwo\r\nthree\r\n',
      oldText: 'one\ntwo',
      newText: 'uno\ndos',
      mode: 'exact',
      content: 'uno\r\ndos\r\nthree\r\n',
    },
    {
      name: 'CRLF text in an LF file',
      text: 'one\ntwo\nthree\n',
      oldText: 'one\r\ntwo\r\n',
      newText: 'uno\r\ndos\r\n',
      mode: 'lineEndings',
      content: 'uno\ndos\nthree\n',
    },
    {
      name: 'LF text in a file with mixed line endings (new lines take the most common ending)',
      text: 'a\r\nb\nc\r\nd\r\n',
      oldText: 'a\nb\nc\n',
      newText: 'x\ny\n',
      mode: 'lineEndings',
      content: 'x\r\ny\r\nd\r\n',
    },
    {
      name: 'different indentation, re-indented from the file',
      text: 'function f() {\n\tif (x) {\n\t\treturn 1;\n\t}\n}\n',
      oldText: '    if (x) {\n        return 1;\n    }',
      newText: '    if (x) {\n        log(x);\n        return 2;\n    }',
      mode: 'whitespace',
      content: 'function f() {\n\tif (x) {\n\t\tlog(x);\n\t\treturn 2;\n\t}\n}\n',
    },
    {
      name: 'missing indentation, relative indentation kept',
      text: 'class A {\n    run() {\n        go();\n    }\n}\n',
      oldText: 'run() {\n    go();\n}',
      newText: 'run() {\n    if (ok) {\n        go();\n    }\n}',
      mode: 'whitespace',
      content: 'class A {\n    run() {\n        if (ok) {\n            go();\n        }\n    }\n}\n',
    },
    {
      name: 'collapsed inner whitespace and trailing spaces',
      text: 'let  total =   a +  b;   \nreturn total;\n',
      oldText: 'let total = a + b;\nreturn total;',
      newText: 'let total = a + b + c;\nreturn total;',
      mode: 'whitespace',
      content: 'let total = a + b + c;\nreturn total;\n',
    },
    {
      name: 'blank lines around oldText and newText are ignored',
      text: 'a\n  b\nc\n',
      oldText: '\n\nb\n\n',
      newText: '\n\nB\n\n',
      mode: 'whitespace',
      content: 'a\n  B\nc\n',
    },
    {
      name: 'whitespace mode keeps CRLF and a missing final newline',
      text: 'x\r\n  y\r\n  z',
      oldText: 'y\nz',
      newText: 'y\nz\nw',
      mode: 'whitespace',
      content: 'x\r\n  y\r\n  z\r\n  w',
    },
    {
      name: 'deleting the last lines keeps a missing final newline missing',
      text: 'keep\n  drop',
      oldText: 'drop  ',
      newText: '',
      mode: 'whitespace',
      content: 'keep',
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(replaceOnce(c.text, c.oldText, c.newText)).toEqual({
        kind: 'replaced',
        mode: c.mode,
        content: c.content,
      });
    });
  }

  it('reports ambiguity in the first mode that matches more than once', () => {
    expect(replaceOnce('a\na\n', 'a', 'b')).toEqual({ kind: 'ambiguous', mode: 'exact', count: 2 });
    expect(replaceOnce('x\ny\nx\ny\n', 'x\r\ny', 'z')).toEqual({
      kind: 'ambiguous',
      mode: 'lineEndings',
      count: 2,
    });
    expect(replaceOnce('  f(a,  b);\n\tf(a, b);\n f(a,\tb);\n', 'f(a,   b);', 'g();')).toEqual({
      kind: 'ambiguous',
      mode: 'whitespace',
      count: 3,
    });
  });

  it('counts places with either line ending in a file with mixed line endings', () => {
    expect(replaceOnce('a\r\nb\r\na\nb\n', 'a\nb', 'x')).toEqual({
      kind: 'ambiguous',
      mode: 'exact',
      count: 2,
    });
    expect(replaceOnce('a\r\nb\r\na\nb\n', 'a\r\nb', 'x')).toEqual({
      kind: 'ambiguous',
      mode: 'exact',
      count: 2,
    });
  });

  it('does not fall through to a looser mode after an ambiguous one', () => {
    expect(replaceOnce('ab ab', 'ab', 'x')).toMatchObject({ kind: 'ambiguous', mode: 'exact' });
  });

  it('counts overlapping exact matches', () => {
    expect(replaceOnce('aaa', 'aa', 'b')).toEqual({ kind: 'ambiguous', mode: 'exact', count: 2 });
  });

  it('reports not found when no mode matches', () => {
    expect(replaceOnce('a\nb\n', 'c', 'd')).toEqual({ kind: 'notFound' });
    expect(replaceOnce('a\nb\n', '\n  \n', 'd')).toEqual({ kind: 'notFound' });
    expect(replaceOnce('', 'a', 'b')).toEqual({ kind: 'notFound' });
  });

  it('does not match part of a line in whitespace mode', () => {
    expect(replaceOnce('  const total = 1;\n', 'total  = 1;', 'x')).toEqual({ kind: 'notFound' });
  });
});

describe('line helpers', () => {
  it('splits text into lines with their line breaks and joins them back', () => {
    const text = 'a\r\nb\nc\rd';
    expect(splitTextLines(text)).toEqual([
      { text: 'a', eol: '\r\n' },
      { text: 'b', eol: '\n' },
      { text: 'c', eol: '\r' },
      { text: 'd', eol: '' },
    ]);
    expect(joinTextLines(splitTextLines(text))).toBe(text);
    expect(splitTextLines('')).toEqual([]);
    expect(splitTextLines('\n')).toEqual([{ text: '', eol: '\n' }]);
  });

  it('finds the most common line break', () => {
    expect(dominantEol(splitTextLines('a\r\nb\r\nc\n'))).toBe('\r\n');
    expect(dominantEol(splitTextLines('a\nb\r\nc\n'))).toBe('\n');
    expect(dominantEol(splitTextLines('one line'))).toBe('\n');
    expect(dominantEol([])).toBe('\n');
  });

  it('re-indents lines with the closest known indentation', () => {
    const map = indentMap([
      ['  a', '\ta'],
      ['    b', '\t\tb'],
      ['', ''],
    ]);
    expect(reindent('  x', map)).toBe('\tx');
    expect(reindent('    y', map)).toBe('\t\ty');
    expect(reindent('      z', map)).toBe('\t\t  z');
    expect(reindent('w', map)).toBe('w');
    expect(reindent('   ', map)).toBe('   ');
  });

  it('maps column 0 to the file indentation on every line', () => {
    const map = indentMap([['a', '    a']]);
    expect(reindent('b', map)).toBe('    b');
    expect(reindent('  c', map)).toBe('      c');
  });
});
