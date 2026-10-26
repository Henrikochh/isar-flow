import { describe, expect, it } from 'vitest';
import { applyWorkflowOps, parseWorkflowText, type WorkflowOp } from '../../src/yaml';

const lines = (...l: string[]) => l.join('\n') + '\n';

function apply(text: string, ...ops: WorkflowOp[]): string {
  const result = applyWorkflowOps(text, ops);
  if (result.error) throw new Error(result.error);
  return result.text;
}

const assign: WorkflowOp = { op: 'assignMissingIds' };

describe('assignMissingIds', () => {
  it('gives blocks without an id a fresh <type>_<n> id as their first key, keeping comments', () => {
    const text = lines(
      'version: 1',
      'name: ids',
      'steps:',
      '  # Build first',
      '  - type: console # the build',
      '    run: npm run build',
      '',
      '  - id: tests',
      '    type: console',
      '    run: npm test',
      '',
      '  - name: Review # shown on the canvas',
      '    type: agent',
      '    # the prompt',
      '    prompt: Review',
    );
    expect(apply(text, assign)).toBe(
      lines(
        'version: 1',
        'name: ids',
        'steps:',
        '  # Build first',
        '  - id: console_1',
        '    type: console # the build',
        '    run: npm run build',
        '',
        '  - id: tests',
        '    type: console',
        '    run: npm test',
        '',
        '  - id: agent_1',
        '    name: Review # shown on the canvas',
        '    type: agent',
        '    # the prompt',
        '    prompt: Review',
      ),
    );
  });

  it('covers nested blocks, unknown types and empty mappings, with ids unique across the document', () => {
    const text = lines(
      'version: 1',
      'name: nested',
      'steps:',
      '  - type: loop',
      '    maxIterations: 2',
      '    steps:',
      '      - type: console',
      '        run: x',
      '      - type: mystery',
      '      - type: if',
      '        condition: "true"',
      '        then:',
      '          - type: console',
      '            run: y',
      '        else:',
      '          - {}',
      '  - id: console_1',
      '    type: console',
      '    run: z',
      '  - type: 5',
    );
    expect(apply(text, assign)).toBe(
      lines(
        'version: 1',
        'name: nested',
        'steps:',
        '  - id: loop_1',
        '    type: loop',
        '    maxIterations: 2',
        '    steps:',
        '      - id: console_2',
        '        type: console',
        '        run: x',
        '      - id: block_1',
        '        type: mystery',
        '      - id: if_1',
        '        type: if',
        '        condition: "true"',
        '        then:',
        '          - id: console_3',
        '            type: console',
        '            run: y',
        '        else:',
        '          - { id: block_2 }',
        '  - id: console_1',
        '    type: console',
        '    run: z',
        '  - id: block_3',
        '    type: 5',
      ),
    );
  });

  it('replaces ids that are empty, not strings or not valid in place', () => {
    const text = lines(
      'version: 1',
      'name: bad ids',
      'steps:',
      '  - type: break',
      '    id: ""',
      '  - id: 42',
      '    type: stop',
      '  - id: my block # needs a new id',
      '    type: console',
      '    run: x',
      '  - id:',
      '    type: approval',
      '    message: ok?',
    );
    expect(apply(text, assign)).toBe(
      lines(
        'version: 1',
        'name: bad ids',
        'steps:',
        '  - type: break',
        '    id: break_1',
        '  - id: stop_1',
        '    type: stop',
        '  - id: console_1 # needs a new id',
        '    type: console',
        '    run: x',
        '  - id: approval_1',
        '    type: approval',
        '    message: ok?',
      ),
    );
  });

  it('handles flow-style blocks', () => {
    const text = lines('version: 1', 'name: flow', 'steps:', '  - { type: console, run: x }');
    expect(apply(text, assign)).toBe(
      lines('version: 1', 'name: flow', 'steps:', '  - { id: console_1, type: console, run: x }'),
    );
  });

  it('keeps a comment above the first key of a flow-style block above the new id', () => {
    const text = lines('version: 1', 'name: f', 'steps:', '  - {', '    # c', '    type: break }');
    expect(apply(text, assign)).toBe(
      lines(
        'version: 1',
        'name: f',
        'steps:',
        '  - {',
        '      # c',
        '      id: break_1,',
        '      type: break',
        '    }',
      ),
    );
  });

  it('leaves the text unchanged when every block has a valid id', () => {
    const text = lines(
      'version: 1',
      'name: fine',
      'steps:',
      '  - id: a # first',
      '    type: console',
      '    run: "quoted"',
      '  - id: b',
      '    type: break',
    );
    expect(apply(text, assign)).toBe(text);
    const empty = lines('version: 1', 'name: empty', 'steps: []');
    expect(apply(empty, assign)).toBe(empty);
  });

  it('keeps CRLF line endings', () => {
    const text = 'version: 1\r\nname: crlf\r\nsteps:\r\n  - type: console\r\n    run: x\r\n';
    expect(apply(text, assign)).toBe(
      'version: 1\r\nname: crlf\r\nsteps:\r\n  - id: console_1\r\n    type: console\r\n    run: x\r\n',
    );
  });

  it('produces a schema-valid workflow that later ops in the same batch can address', () => {
    const text = lines(
      'version: 1',
      'name: batch',
      'steps:',
      '  - type: console',
      '    run: x',
      '  - type: agent',
      '    prompt: p',
      '    model: litellm/x',
    );
    const result = apply(text, assign, { op: 'updateStep', stepId: 'agent_1', set: { prompt: 'Review' } });
    const parsed = parseWorkflowText(result);
    expect(parsed.valid).toBe(true);
    expect(parsed.workflow?.steps.map((s) => [s.id, s.type])).toEqual([
      ['console_1', 'console'],
      ['agent_1', 'agent'],
    ]);
    expect(result).toContain('prompt: Review');
  });
});
