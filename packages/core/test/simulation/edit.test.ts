import { describe, expect, it } from 'vitest';
import {
  newSimulationText,
  parseSimulationText,
  renameSimulationBlock,
  setSimulationResults,
} from '../../src/simulation';

const lines = (...text: string[]) => `${text.join('\n')}\n`;

const commented = lines(
  '# Mocks for the review loop',
  'version: 1',
  'approvals: reject # nobody approves in tests',
  'blocks:',
  '  # the test command',
  '  tests:',
  '    - exitCode: 1 # first round fails',
  '      output: 1 failed',
  '    - exitCode: 0',
  '  review:',
  '    - json: { approved: true, issues: [] }',
);

describe('newSimulationText', () => {
  it('explains the format and parses to an empty file', () => {
    const text = newSimulationText('Review loop');
    expect(text).toMatch(/^# /);
    expect(text).toContain('"Review loop"');
    expect(text.endsWith('version: 1\nblocks: {}\n')).toBe(true);
    expect(parseSimulationText(text)).toEqual({
      file: { version: 1, blocks: {} },
      diagnostics: [],
      blockRanges: {},
    });
  });

  it('has a commented example for each block type that parses once uncommented', () => {
    const text = newSimulationText('x');
    const example = text
      .split('\n')
      .filter((line) => line.startsWith('#   ') || line === '# blocks:')
      .map((line) => line.slice(2))
      .join('\n');
    const parsed = parseSimulationText(example);
    expect(parsed.diagnostics).toEqual([]);
    const blocks = parsed.file?.blocks ?? {};
    expect(blocks.tests).toEqual([{ exitCode: 1, output: '1 failed' }, { exitCode: 0 }]);
    expect(Object.values(blocks).some((list) => list.some((r) => r.text !== undefined))).toBe(true);
    expect(Object.values(blocks).some((list) => list.some((r) => r.json !== undefined))).toBe(true);
    expect(Object.values(blocks).some((list) => list.some((r) => r.approved !== undefined))).toBe(true);
    expect(Object.values(blocks).some((list) => list.some((r) => r.error !== undefined))).toBe(true);
  });

  it('keeps odd workflow names on one comment line', () => {
    const text = newSimulationText('Two\nlines  and   spaces');
    expect(text).toContain('"Two lines and spaces"');
    expect(parseSimulationText(text).diagnostics).toEqual([]);
    expect(newSimulationText('  ')).toContain('this workflow');
  });
});

describe('setSimulationResults', () => {
  it('starts from the new-file text when the file is empty', () => {
    const text = setSimulationResults('', 'tests', [{ exitCode: 1, output: '1 failed' }]);
    expect(text.startsWith('# ')).toBe(true);
    expect(
      text.endsWith(
        lines('version: 1', 'blocks:', '  tests:', '    - exitCode: 1', '      output: 1 failed'),
      ),
    ).toBe(true);
    expect(parseSimulationText(text).file).toEqual({
      version: 1,
      blocks: { tests: [{ exitCode: 1, output: '1 failed' }] },
    });
    expect(setSimulationResults('  \n', 'tests', [{ exitCode: 0 }])).toContain('blocks:\n  tests:\n');
  });

  it('adds version and blocks when they are missing', () => {
    expect(setSimulationResults('# my mocks\napprovals: reject\n', 'ship', [{ approved: true }])).toBe(
      lines('# my mocks', 'version: 1', 'approvals: reject', 'blocks:', '  ship:', '    - approved: true'),
    );
    expect(setSimulationResults('version: 1\nblocks:\n', 'ship', [{ approved: false }])).toBe(
      lines('version: 1', 'blocks:', '  ship:', '    - approved: false'),
    );
    expect(setSimulationResults('# only comments\n', 'ship', [{ approved: false }])).toBe(
      lines('# only comments', '', 'version: 1', 'blocks:', '  ship:', '    - approved: false'),
    );
  });

  it('replaces a block list and keeps everything else', () => {
    const text = setSimulationResults(commented, 'tests', [{ exitCode: 0, output: 'all passed' }]);
    expect(text).toBe(
      lines(
        '# Mocks for the review loop',
        'version: 1',
        'approvals: reject # nobody approves in tests',
        'blocks:',
        '  # the test command',
        '  tests:',
        '    - exitCode: 0 # first round fails',
        '      output: all passed',
        '  review:',
        '    - json: { approved: true, issues: [] }',
      ),
    );
  });

  it('adds new blocks after the existing ones', () => {
    const text = setSimulationResults(commented, 'implement', [{ text: 'Done' }, { error: 'Model down' }]);
    expect(text).toBe(`${commented}  implement:\n    - text: Done\n    - error: Model down\n`);
  });

  it('removes a block for null or an empty list', () => {
    const withoutTests = lines(
      '# Mocks for the review loop',
      'version: 1',
      'approvals: reject # nobody approves in tests',
      'blocks:',
      '  review:',
      '    - json: { approved: true, issues: [] }',
    );
    expect(setSimulationResults(commented, 'tests', null)).toBe(withoutTests);
    expect(setSimulationResults(commented, 'tests', [])).toBe(withoutTests);
    expect(setSimulationResults(withoutTests, 'review', null)).toBe(
      lines(
        '# Mocks for the review loop',
        'version: 1',
        'approvals: reject # nobody approves in tests',
        'blocks: {}',
      ),
    );
    expect(setSimulationResults(commented, 'unknown', null)).toBe(commented);
    expect(setSimulationResults('', 'tests', null)).toBe('');
  });

  it('keeps comments that describe the whole block list', () => {
    const text = lines('blocks:', '  # all mocks below', '', '  tests:', '    - exitCode: 0');
    const result = setSimulationResults(text, 'tests', null);
    expect(result).toContain('# all mocks below');
    expect(parseSimulationText(result).file).toEqual({ version: 1, blocks: {} });
    const second = lines('blocks:', '  # first', '  tests: []', '  # second', '  lint: []');
    expect(setSimulationResults(second, 'lint', null)).toBe(
      lines('version: 1', 'blocks:', '  # first', '  tests: []'),
    );
  });

  it('writes result keys in a fixed order and drops unknown or undefined ones', () => {
    const text = setSimulationResults('version: 1\nblocks: {}\n', 'any', [
      {
        error: 'e',
        comment: 'c',
        approved: true,
        json: { b: [1, 'two'], a: {} },
        text: 't',
        output: 'o',
        exitCode: 2,
        ...({ extra: 1, missing: undefined } as object),
      },
    ]);
    expect(text).toBe(
      lines(
        'version: 1',
        'blocks:',
        '  any:',
        '    - exitCode: 2',
        '      output: o',
        '      text: t',
        '      json:',
        '        b:',
        '          - 1',
        '          - two',
        '        a: {}',
        '      approved: true',
        '      comment: c',
        '      error: e',
      ),
    );
  });

  it('writes multi-line text as block scalars', () => {
    const text = setSimulationResults('version: 1\nblocks: {}\n', 'tests', [
      { exitCode: 1, output: 'FAIL a.test.ts\r\nFAIL b.test.ts\n' },
      { output: 'no newline\nat the end' },
    ]);
    expect(text).toBe(
      lines(
        'version: 1',
        'blocks:',
        '  tests:',
        '    - exitCode: 1',
        '      output: |',
        '        FAIL a.test.ts',
        '        FAIL b.test.ts',
        '    - output: |-',
        '        no newline',
        '        at the end',
      ),
    );
    expect(parseSimulationText(text).file?.blocks?.tests[0].output).toBe('FAIL a.test.ts\nFAIL b.test.ts\n');
  });

  it('turns flow-style blocks into block style when adding', () => {
    expect(setSimulationResults('blocks: { a: [{ exitCode: 1 }] }\n', 'b', [{ exitCode: 0 }])).toBe(
      lines('version: 1', 'blocks:', '  a: [{ exitCode: 1 }]', '  b:', '    - exitCode: 0'),
    );
  });

  it('keeps line endings and the byte order mark', () => {
    const text = setSimulationResults('\uFEFFversion: 1\r\nblocks:\r\n  a:\r\n    - exitCode: 1\r\n', 'a', [
      { exitCode: 3 },
    ]);
    expect(text).toBe('\uFEFFversion: 1\r\nblocks:\r\n  a:\r\n    - exitCode: 3\r\n');
  });

  it('refuses to edit files it cannot read', () => {
    expect(() => setSimulationResults('blocks:\n\ttests: []\n', 'tests', [{ exitCode: 0 }])).toThrow(
      "The simulation file can't be read: Tabs are not allowed for indentation in YAML. Use spaces instead (line 2). " +
        'Fix it in the file first.',
    );
    expect(() => setSimulationResults('blocks: [\n', 'tests', null)).toThrow(
      /^The simulation file can't be read: YAML/,
    );
    expect(() => setSimulationResults('- a\n', 'tests', null)).toThrow(
      "The simulation file can't be read: it must be a mapping with version and blocks at the top level. " +
        'Fix it in the file first.',
    );
    expect(() => setSimulationResults('blocks: []\n', 'tests', [{ exitCode: 0 }])).toThrow(
      'The simulation file can\'t be read: "blocks" must be a mapping of block ids to lists of results. ' +
        'Fix it in the file first.',
    );
    expect(() => setSimulationResults('version: 1\n', '1st', [{ exitCode: 0 }])).toThrow(
      '"1st" isn\'t a valid block id. Block ids start with a letter or _ and contain only letters, digits, _ and -.',
    );
  });
});

describe('renameSimulationBlock', () => {
  it('renames the key in place', () => {
    expect(renameSimulationBlock(commented, 'tests', 'unit_tests')).toBe(
      commented.replace('  tests:', '  unit_tests:'),
    );
    const quoted = 'blocks:\n  "tests": [] # keep\n  other: []\n';
    expect(renameSimulationBlock(quoted, 'tests', 'unit')).toBe('blocks:\n  unit: [] # keep\n  other: []\n');
    expect(renameSimulationBlock('\uFEFFblocks: { a: [] }\n', 'a', 'b')).toBe('\uFEFFblocks: { b: [] }\n');
  });

  it('leaves the text unchanged when there is nothing to rename', () => {
    expect(renameSimulationBlock(commented, 'lint', 'checks')).toBe(commented);
    expect(renameSimulationBlock(commented, 'tests', 'review')).toBe(commented);
    expect(renameSimulationBlock(commented, 'tests', 'tests')).toBe(commented);
    expect(renameSimulationBlock(commented, 'tests', '1bad')).toBe(commented);
    expect(renameSimulationBlock('blocks: [\n', 'tests', 'x')).toBe('blocks: [\n');
    expect(renameSimulationBlock('- a\n', 'a', 'b')).toBe('- a\n');
    expect(renameSimulationBlock('version: 1\n', 'a', 'b')).toBe('version: 1\n');
    expect(renameSimulationBlock('', 'a', 'b')).toBe('');
  });
});
