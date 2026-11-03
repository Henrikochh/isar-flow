import { describe, expect, it } from 'vitest';
import type { Diagnostic } from '../../src/diagnostics';
import { parseSimulationText } from '../../src/simulation';

const lines = (...text: string[]) => `${text.join('\n')}\n`;
const at = (line: number, start: number, end: number) => ({
  start: { line, character: start },
  end: { line, character: end },
});

describe('parseSimulationText', () => {
  it('reads mocks and the range of each block key', () => {
    const text = lines(
      '# mocks',
      'version: 1',
      'approvals: reject',
      'blocks:',
      '  tests:',
      '    - exitCode: 1',
      '      output: 1 failed',
      '    - exitCode: 0',
      '  "review":',
      '    - json: { approved: false, issues: [x] }',
    );
    expect(parseSimulationText(text)).toEqual({
      file: {
        version: 1,
        approvals: 'reject',
        blocks: {
          tests: [{ exitCode: 1, output: '1 failed' }, { exitCode: 0 }],
          review: [{ json: { approved: false, issues: ['x'] } }],
        },
      },
      diagnostics: [],
      blockRanges: { tests: at(4, 2, 7), review: at(8, 2, 10) },
    });
  });

  it('reads empty documents and empty blocks as no mocks', () => {
    expect(parseSimulationText('')).toEqual({ file: {}, diagnostics: [], blockRanges: {} });
    expect(parseSimulationText('# only a comment\n')).toEqual({ file: {}, diagnostics: [], blockRanges: {} });
    expect(parseSimulationText('version: 1\nblocks:\n')).toEqual({
      file: { version: 1, blocks: {} },
      diagnostics: [],
      blockRanges: {},
    });
    expect(parseSimulationText('blocks: {}\n').file).toEqual({ blocks: {} });
    expect(parseSimulationText('blocks:\n  tests: []\n').file).toEqual({ blocks: { tests: [] } });
  });

  it('reports YAML syntax errors like workflow files', () => {
    const result = parseSimulationText('blocks:\n  tests: [\n');
    expect(result.file).toBeNull();
    expect(result.diagnostics[0]).toMatchObject({ severity: 'error', code: 'yaml-syntax' });
    expect(result.diagnostics[0].message).toMatch(/^YAML syntax error: /);
    expect(result.diagnostics[0].range).toBeDefined();
    expect(result.blockRanges).toEqual({});
  });

  it('reports tabs and duplicate keys', () => {
    const tabs = parseSimulationText('blocks:\n\ttests: []\n');
    expect(tabs.file).toBeNull();
    expect(tabs.diagnostics.map((d) => d.message)).toContain(
      'Tabs are not allowed for indentation in YAML. Use spaces instead.',
    );
    const duplicate = parseSimulationText('blocks:\n  tests: []\n  tests: []\n');
    expect(duplicate.diagnostics[0]).toMatchObject({
      message: "Duplicate key 'tests'. Each key may appear only once in a mapping.",
      range: at(2, 2, 7),
    });
  });

  it('wants a mapping at the top level', () => {
    expect(parseSimulationText('- tests\n- review\n')).toEqual({
      file: null,
      diagnostics: [
        {
          severity: 'error',
          code: 'not-a-mapping',
          message:
            'A simulation file must be a YAML mapping with version and blocks, but this file contains a list.',
          range: at(0, 0, 7),
        },
      ],
      blockRanges: {},
    });
    expect(parseSimulationText('just text\n').diagnostics[0].message).toBe(
      'A simulation file must be a YAML mapping with version and blocks, but this file contains a single value.',
    );
  });

  it('reports unknown keys with ranges and block ids', () => {
    const text = lines('version: 1', 'colour: red', 'blocks:', '  tests:', '    - exitcode: 1');
    const result = parseSimulationText(text);
    expect(result.file).toBeNull();
    expect(result.diagnostics).toEqual<Diagnostic[]>([
      {
        severity: 'error',
        code: 'unknown-property',
        message: "Unknown property 'colour'. The top level has version, approvals and blocks.",
        path: ['colour'],
        range: at(1, 0, 6),
      },
      {
        severity: 'error',
        code: 'unknown-property',
        message: "Unknown property 'exitcode'. Did you mean 'exitCode'?",
        path: ['blocks', 'tests', 0, 'exitcode'],
        range: at(4, 6, 14),
        stepId: 'tests',
      },
    ]);
    expect(result.blockRanges).toEqual({ tests: at(3, 2, 7) });
  });

  it('says where mocks go when a block id is at the top level', () => {
    const text = lines('version: 1', 'tests:', '  - exitCode: 1', 'review: []');
    expect(parseSimulationText(text).diagnostics.map((d) => d.message)).toEqual([
      "Unknown property 'tests'. Put the mocks of block tests under blocks:, indented one level.",
      "Unknown property 'review'. Put the mocks of block review under blocks:, indented one level.",
    ]);
  });

  it('lists the fields of a result for a property it does not know', () => {
    const text = lines('blocks:', '  tests:', '    - stdout: ok', '      exit_code: 1');
    expect(parseSimulationText(text).diagnostics.map((d) => d.message)).toEqual([
      "Unknown property 'stdout'. A result has exitCode, output, text, json, approved, comment or error.",
      "Unknown property 'exit_code'. Did you mean 'exitCode'?",
    ]);
  });

  it('asks for a list when a block has a single result', () => {
    const text = lines('blocks:', '  tests:', '    exitCode: 1', '  review: { text: ok }');
    const result = parseSimulationText(text);
    expect(result.file).toBeNull();
    expect(result.diagnostics).toEqual<Diagnostic[]>([
      {
        severity: 'error',
        code: 'invalid-value',
        message: 'Use a list of results for "tests", e.g. "- exitCode: 0".',
        path: ['blocks', 'tests'],
        range: at(1, 2, 7),
        stepId: 'tests',
      },
      {
        severity: 'error',
        code: 'invalid-value',
        message: 'Use a list of results for "review", e.g. "- exitCode: 0".',
        path: ['blocks', 'review'],
        range: at(3, 2, 8),
        stepId: 'review',
      },
    ]);
  });

  it('reports other schema errors', () => {
    const messages = (text: string) => parseSimulationText(text).diagnostics.map((d) => d.message);
    expect(messages('blocks: []\n')).toEqual(["'blocks' must be a mapping (found a list)"]);
    expect(messages('version: 2\n')).toEqual(["'version' must be 1 (found 2)"]);
    expect(messages('approvals: yes\n')).toEqual([
      "Invalid value 'yes' for 'approvals'. Use one of: approve, reject.",
    ]);
    expect(messages('blocks:\n  tests: 3\n')).toEqual(["'tests' must be a list (found 3)"]);
    expect(messages('blocks:\n  tests:\n')).toEqual(["'tests' must be a list (found an empty value)"]);
    expect(messages('blocks:\n  tests:\n    - exitCode: 1.5\n')).toEqual([
      "'exitCode' must be a whole number (found 1.5)",
    ]);
    expect(messages("blocks:\n  tests:\n    - error: ''\n")).toEqual(["'error' must not be empty"]);
    const badId = parseSimulationText('blocks:\n  1tests: []\n');
    expect(badId.file).toBeNull();
    expect(badId.diagnostics[0]).toMatchObject({ code: 'invalid-value', range: at(1, 2, 8) });
    expect(badId.diagnostics[0].message).toContain("'1tests'");
  });

  it('reports unknown aliases and alias bombs', () => {
    const unknown = parseSimulationText('blocks:\n  tests: *missing\n');
    expect(unknown.file).toBeNull();
    expect(unknown.diagnostics[0].code).toBe('yaml-syntax');
    const bomb = [
      'a: &a [x, x, x, x, x, x, x, x, x, x]',
      'b: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]',
      'c: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]',
      'd: &d [*c, *c, *c, *c, *c, *c, *c, *c, *c, *c]',
      'e: [*d, *d, *d, *d, *d, *d, *d, *d, *d, *d]',
    ].join('\n');
    const result = parseSimulationText(bomb);
    expect(result.file).toBeNull();
    expect(result.diagnostics[0].message).toMatch(/aliases/);
  });
});
