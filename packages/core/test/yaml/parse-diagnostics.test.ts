import { describe, expect, it } from 'vitest';
import { parseAgentText, parseWorkflowText } from '../../src/yaml';

const workflow = (...stepLines: string[]) =>
  ['version: 1', 'name: x', 'steps:', ...stepLines].join('\n') + '\n';
const lineOf = (text: string, needle: string) => text.split('\n').findIndex((l) => l.includes(needle));
const columnOf = (text: string, needle: string) => text.split('\n')[lineOf(text, needle)].indexOf(needle);

const OPS =
  'eq, neq, gt, gte, lt, lte, contains, notContains, matches, notMatches, startsWith, endsWith, isEmpty, isNotEmpty, isTrue, isFalse';

describe('workflow schema diagnostics', () => {
  it('attributes diagnostics in nested blocks to the innermost block', () => {
    const text = workflow(
      '  - id: outer',
      '    type: loop',
      '    maxIterations: 3',
      '    steps:',
      '      - id: gate',
      '        type: if',
      '        condition: "${{ true }}"',
      '        then:',
      '          - id: inner',
      '            type: console',
      '            run: echo hi',
      '            colour: red',
    );
    const result = parseWorkflowText(text);
    expect(result.valid).toBe(false);
    expect(result.diagnostics).toEqual([
      {
        severity: 'error',
        code: 'unknown-property',
        message: "Unknown property 'colour'",
        path: ['steps', 0, 'steps', 0, 'then', 0, 'colour'],
        range: { start: { line: 14, character: 12 }, end: { line: 14, character: 18 } },
        stepId: 'inner',
      },
    ]);
    expect(Object.keys(result.stepRanges)).toEqual(['outer', 'gate', 'inner']);
    expect(result.stepRanges.inner).toEqual({
      start: { line: 11, character: 12 },
      end: { line: 14, character: 23 },
    });
    expect(result.stepRanges.outer.start).toEqual({ line: 3, character: 4 });
  });

  it('reports a single clear message for an invalid comparison operator', () => {
    const text = workflow(
      '  - id: retry',
      '    type: loop',
      '    maxIterations: 3',
      '    until: { value: "${{ steps.t.exitCode }}", op: equals, to: 0 }',
      '    steps: []',
    );
    const { diagnostics } = parseWorkflowText(text);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      code: 'invalid-value',
      message: `Invalid value 'equals' for 'op'. Use one of: ${OPS}.`,
      path: ['steps', 0, 'until', 'op'],
      stepId: 'retry',
      range: { start: { line: 6, character: columnOf(text, 'equals') } },
    });
  });

  it('explains conditions of the wrong type', () => {
    const text = workflow(
      '  - id: l',
      '    type: loop',
      '    maxIterations: 3',
      '    until: 5',
      '    steps: []',
    );
    const { diagnostics } = parseWorkflowText(text);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].code).toBe('invalid-value');
    expect(diagnostics[0].message).toMatch(/^'until' must be a condition/);
    expect(diagnostics[0].range?.start).toEqual({ line: 6, character: 11 });
  });

  it('reports unknown keys inside nested condition groups once', () => {
    const text = workflow(
      '  - id: gate',
      '    type: if',
      '    condition:',
      '      any:',
      '        - { value: a, op: eq, too: 1 }',
      '        - "${{ true }}"',
      '    then: []',
    );
    const { diagnostics } = parseWorkflowText(text);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      code: 'unknown-property',
      message: "Unknown property 'too'",
      stepId: 'gate',
      range: { start: { line: 7, character: columnOf(text, 'too') } },
    });
  });

  it('reports missing comparison operators', () => {
    const text = workflow('  - id: gate', '    type: if', '    condition: { value: a }', '    then: []');
    const { diagnostics } = parseWorkflowText(text);
    expect(diagnostics.map((d) => d.message)).toEqual(["Missing required property 'op'"]);
  });

  it('reports empty expressions', () => {
    const text = workflow('  - id: gate', '    type: if', '    condition: ""', '    then: []');
    expect(parseWorkflowText(text).diagnostics.map((d) => d.message)).toEqual([
      "'condition' must not be empty",
    ]);
  });

  it('describes out-of-range numbers and invalid ids', () => {
    const text = workflow('  - id: 9lives', '    type: loop', '    maxIterations: 200', '    steps: []');
    const { diagnostics } = parseWorkflowText(text);
    expect(diagnostics.map((d) => [d.message, d.stepId])).toEqual([
      [
        "Invalid value '9lives' for 'id'. Block ids start with a letter or _ and contain only letters, digits, _ and -.",
        '9lives',
      ],
      ["'maxIterations' must be at most 100 (found 200)", '9lives'],
    ]);
    expect(diagnostics[1].range).toEqual({
      start: { line: 5, character: 19 },
      end: { line: 5, character: 22 },
    });
  });

  it('describes wrong value types', () => {
    const text = workflow(
      '  - id: t',
      '    type: console',
      '    run: npm test',
      '    continueOnError: maybe',
      '    timeout: 0',
      '    retry: { max: 2.5 }',
    );
    expect(parseWorkflowText(text).diagnostics.map((d) => d.message)).toEqual([
      "'continueOnError' must be true or false (found 'maybe')",
      "'timeout' must be greater than 0 (found 0)",
      "'max' must be a whole number (found 2.5)",
    ]);
  });

  it('reports a missing block type with the list of types', () => {
    const text = workflow('  - id: a', '    name: no type');
    const { diagnostics } = parseWorkflowText(text);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      code: 'missing-property',
      message:
        "Missing required property 'type'. Use one of: agent, console, loop, if, break, stop, approval.",
      stepId: 'a',
      range: { start: { line: 3, character: 4 }, end: { line: 3, character: 9 } },
    });
  });

  it('points at the key when a value is left empty', () => {
    const text = workflow('  - id: a', '    type: agent', '    prompt:');
    expect(parseWorkflowText(text).diagnostics).toEqual([
      expect.objectContaining({
        message: "'prompt' must be text (found an empty value)",
        range: { start: { line: 5, character: 4 }, end: { line: 5, character: 10 } },
        stepId: 'a',
      }),
    ]);
    const agent = parseAgentText('name: A\nmodel:\n');
    expect(agent.diagnostics[0].range).toEqual({
      start: { line: 1, character: 0 },
      end: { line: 1, character: 5 },
    });
  });

  it('explains an empty block type', () => {
    const text = workflow('  - id: a', '    type:');
    const { diagnostics } = parseWorkflowText(text);
    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: 'unknown-block-type',
        message: "'type' must not be empty. Use one of: agent, console, loop, if, break, stop, approval.",
        range: { start: { line: 4, character: 4 }, end: { line: 4, character: 8 } },
        stepId: 'a',
      }),
    ]);
  });

  it('reports the loop refinement for until and while together', () => {
    const text = workflow(
      '  - id: l',
      '    type: loop',
      '    maxIterations: 2',
      '    until: "${{ true }}"',
      '    while: "${{ true }}"',
      '    steps: []',
    );
    const { diagnostics } = parseWorkflowText(text);
    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: 'invalid-value',
        message: 'Use either "until" or "while", not both',
        stepId: 'l',
      }),
    ]);
    expect(diagnostics[0].range?.start.line).toBe(7);
  });

  it('omits stepId for blocks without a string id', () => {
    const text = workflow('  - type: console', '    run: echo', '    extra: 1');
    const result = parseWorkflowText(text);
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.diagnostics.every((d) => d.stepId === undefined)).toBe(true);
    expect(result.stepRanges).toEqual({});
  });

  it('drops non-mapping list items from the lenient model', () => {
    const text = workflow('  - just text', '  - id: b', '    type: break');
    const result = parseWorkflowText(text);
    expect(result.workflow?.steps.map((s) => s.id)).toEqual(['b']);
    expect(result.diagnostics.map((d) => d.message)).toEqual([
      "Item 1 of 'steps' must be a mapping (found 'just text')",
    ]);
  });

  it('normalizes missing and invalid block lists in the lenient model', () => {
    const text = workflow(
      '  - id: l',
      '    type: loop',
      '    maxIterations: 2',
      '  - id: i',
      '    type: if',
      '    condition: x',
      '    then: nope',
    );
    const result = parseWorkflowText(text);
    const [loop, branch] = result.workflow?.steps ?? [];
    expect(loop).toMatchObject({ id: 'l', steps: [] });
    expect(branch).toMatchObject({ id: 'i', then: [] });
    expect(result.diagnostics.map((d) => d.message)).toEqual([
      "Missing required property 'steps'",
      "'then' must be a list (found 'nope')",
    ]);
  });

  it('treats a non-list steps value as no steps', () => {
    const result = parseWorkflowText('version: 1\nname: x\nsteps: nope\n');
    expect(result.workflow?.steps).toEqual([]);
    expect(result.diagnostics[0]).toMatchObject({
      code: 'invalid-value',
      message: "'steps' must be a list (found 'nope')",
    });
  });

  it('lists the accepted kinds of value for other unions', () => {
    const text = workflow('  - id: a', '    type: agent', '    prompt: p', '    agent: 5');
    expect(parseWorkflowText(text).diagnostics.map((d) => d.message)).toEqual([
      "'agent' must be text or a mapping (found 5)",
    ]);
  });

  it('explains empty structured conditions', () => {
    const text = workflow('  - id: gate', '    type: if', '    condition: {}', '    then: []');
    const { diagnostics } = parseWorkflowText(text);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toMatch(/^'condition' must be a condition \(found a mapping\)/);
  });

  it('refuses alias bombs instead of expanding them', () => {
    const bomb = [
      'a: &a [x, x, x, x, x, x, x, x, x, x]',
      'b: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]',
      'c: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]',
      'd: [*c, *c, *c, *c, *c, *c, *c, *c, *c, *c]',
    ].join('\n');
    const result = parseWorkflowText(bomb);
    expect(result.workflow).toBeNull();
    expect(result.diagnostics[0].code).toBe('yaml-syntax');
    expect(result.diagnostics[0].message).toMatch(/^The YAML could not be read/);
    expect(result.diagnostics[0].message).not.toMatch(/attack/);
    expect(result.diagnostics[0].range?.start).toEqual({ line: 1, character: 7 });
  });

  it('points at aliases whose anchor does not exist', () => {
    const text = 'version: 1\nname: *title\nsteps: []\n';
    const result = parseWorkflowText(text);
    expect(result.workflow).toBeNull();
    expect(result.diagnostics).toEqual([
      {
        severity: 'error',
        code: 'yaml-syntax',
        message: "Unknown alias '*title'. Mark the value to reuse with '&title' above this line.",
        range: { start: { line: 1, character: 6 }, end: { line: 1, character: 12 } },
      },
    ]);
  });

  it('reports invalid root values and input names at their keys', () => {
    const text = 'version: 2\nname: ""\ninputs:\n  9bad: { type: string }\nsteps: []\n';
    const { diagnostics } = parseWorkflowText(text);
    expect(diagnostics.map((d) => d.message)).toEqual([
      "'version' must be 1 (found 2)",
      "'name' must not be empty",
      "Invalid name '9bad' in 'inputs'. Input names start with a letter or _.",
    ]);
    expect(diagnostics[2].range).toEqual({
      start: { line: 3, character: 2 },
      end: { line: 3, character: 6 },
    });
  });

  it('maps positions in CRLF files', () => {
    const text = 'version: 1\r\nname: x\r\nsteps:\r\n  - id: a\r\n    type: break\r\n    oops: 1\r\n';
    const { diagnostics } = parseWorkflowText(text);
    expect(diagnostics[0].range).toEqual({
      start: { line: 5, character: 4 },
      end: { line: 5, character: 8 },
    });
  });

  it('returns the validated model for valid workflows', () => {
    const result = parseWorkflowText(workflow('  - id: a', '    type: stop', '    outcome: success'));
    expect(result.valid).toBe(true);
    expect(result.workflow).toEqual({
      version: 1,
      name: 'x',
      steps: [{ id: 'a', type: 'stop', outcome: 'success' }],
    });
  });
});

describe('workflow YAML errors', () => {
  it('explains duplicate keys and points at the key', () => {
    const result = parseWorkflowText('version: 1\nname: a\nname: b\nsteps: []\n');
    expect(result.diagnostics[0]).toMatchObject({
      code: 'yaml-syntax',
      severity: 'error',
      message: "Duplicate key 'name'. Each key may appear only once in a mapping.",
      range: { start: { line: 2, character: 0 }, end: { line: 2, character: 4 } },
    });
  });

  it('reports multiple documents', () => {
    const result = parseWorkflowText('version: 1\n---\nname: b\n');
    expect(result.workflow).toBeNull();
    expect(result.diagnostics[0].code).toBe('yaml-syntax');
    expect(result.diagnostics[0].message).toMatch(/more than one YAML document/);
  });

  it('strips position details from parser messages', () => {
    const result = parseWorkflowText('version: 1\nname: "unterminated\n');
    expect(result.diagnostics[0].code).toBe('yaml-syntax');
    expect(result.diagnostics[0].message).not.toMatch(/at line \d+/);
  });

  it('distinguishes empty files, comment-only files and other roots', () => {
    expect(parseWorkflowText('# nothing yet\n').diagnostics[0]).toMatchObject({
      code: 'empty-document',
      message: 'The file is empty. Add version, name and steps.',
    });
    expect(parseWorkflowText('just text\n').diagnostics[0].code).toBe('not-a-mapping');
    expect(parseWorkflowText('- a\n').workflow).toBeNull();
  });
});

describe('agent diagnostics', () => {
  it('reports invalid tool names at the list item', () => {
    const text = 'name: R\nmodel: litellm/gpt-4.1\ntools: [readFile, fly]\n';
    const { diagnostics, valid } = parseAgentText(text);
    expect(valid).toBe(false);
    expect(diagnostics).toEqual([
      {
        severity: 'error',
        code: 'invalid-value',
        message:
          "Invalid value 'fly' in 'tools'. Use one of: readFile, listFiles, searchText, gitDiff, editFile, applyPatch, writeFile, runCommand.",
        path: ['tools', 1],
        range: { start: { line: 2, character: 18 }, end: { line: 2, character: 21 } },
      },
    ]);
  });

  it('keeps a lenient agent model when values are invalid', () => {
    const result = parseAgentText('name: R\nmodel: litellm/x\ntemperature: 5\n');
    expect(result.valid).toBe(false);
    expect(result.agent?.temperature).toBe(5);
    expect(result.diagnostics.map((d) => d.message)).toEqual(["'temperature' must be at most 2 (found 5)"]);
  });

  it('explains model reference format errors', () => {
    const result = parseAgentText('name: R\nmodel: gpt4\n');
    expect(result.diagnostics[0].message).toBe(
      'Invalid value \'gpt4\' for \'model\'. Model must look like "<provider>/<model>", e.g. "litellm/gpt-4.1".',
    );
  });

  it('reports empty agent files', () => {
    const result = parseAgentText('   \n');
    expect(result.agent).toBeNull();
    expect(result.diagnostics[0]).toMatchObject({
      code: 'empty-document',
      message: 'The file is empty. Add name and model.',
    });
  });

  it('reports non-mapping agent files', () => {
    const result = parseAgentText('- name: R\n');
    expect(result.agent).toBeNull();
    expect(result.diagnostics[0].code).toBe('not-a-mapping');
  });
});
