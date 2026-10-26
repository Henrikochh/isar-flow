import { describe, expect, it } from 'vitest';
import { STEP_TYPES, WorkflowSchema, type Workflow } from '../../src/schema';
import {
  applyWorkflowOps,
  collectStepIds,
  createDefaultStep,
  minimalTextEdit,
  nextStepId,
  parseWorkflowText,
} from '../../src/yaml';

const nested: Workflow = {
  version: 1,
  name: 'n',
  steps: [
    { id: 'console_1', type: 'console', run: 'echo' },
    {
      id: 'loop_1',
      type: 'loop',
      maxIterations: 2,
      steps: [
        {
          id: 'if_1',
          type: 'if',
          condition: 'true',
          then: [{ id: 'console_2', type: 'console', run: 'echo' }],
          else: [{ id: 'console_4', type: 'console', run: 'echo' }],
        },
      ],
    },
  ],
};

describe('collectStepIds', () => {
  it('lists every block id in document order, including nested blocks', () => {
    expect(collectStepIds(nested)).toEqual(['console_1', 'loop_1', 'if_1', 'console_2', 'console_4']);
  });

  it('skips blocks without ids in lenient models', () => {
    const wf = parseWorkflowText(
      'version: 1\nname: x\nsteps:\n  - type: break\n  - id: b\n    type: break\n',
    ).workflow;
    expect(collectStepIds(wf)).toEqual(['b']);
    expect(collectStepIds(null)).toEqual([]);
  });
});

describe('nextStepId', () => {
  it('looks at nested blocks and fills gaps', () => {
    expect(nextStepId(nested, 'console')).toBe('console_3');
    expect(nextStepId(nested, 'if')).toBe('if_2');
    expect(nextStepId(nested, 'approval')).toBe('approval_1');
    expect(nextStepId(null, 'agent')).toBe('agent_1');
  });

  it('suggests ids that the edit operations accept while a block type is mistyped', () => {
    const text = [
      'version: 1',
      'name: x',
      'steps:',
      '  - id: outer',
      '    type: lop',
      '    steps:',
      '      - id: agent_1',
      '        type: break',
      '',
    ].join('\n');
    const workflow = parseWorkflowText(text).workflow;
    expect(collectStepIds(workflow)).toEqual(['outer', 'agent_1']);
    const id = nextStepId(workflow, 'agent');
    expect(id).toBe('agent_2');
    const result = applyWorkflowOps(text, [
      {
        op: 'insertStep',
        target: { parentId: null, slot: 'steps', index: 1 },
        step: createDefaultStep('agent', id),
      },
    ]);
    expect(result.error).toBeUndefined();
  });
});

describe('createDefaultStep', () => {
  it.each(STEP_TYPES)('creates a schema-valid %s block', (type) => {
    const step = createDefaultStep(type, `${type}_1`);
    expect(step).toMatchObject({ id: `${type}_1`, type });
    const result = WorkflowSchema.safeParse({ version: 1, name: 'x', steps: [step] });
    expect(result.success).toBe(true);
  });

  it('returns fresh objects each time', () => {
    const a = createDefaultStep('loop', 'l');
    const b = createDefaultStep('loop', 'l');
    expect(a).not.toBe(b);
    expect((a as { steps: unknown[] }).steps).not.toBe((b as { steps: unknown[] }).steps);
  });
});

describe('minimalTextEdit', () => {
  const applyEdit = (text: string, e: { start: number; end: number; text: string }) =>
    text.slice(0, e.start) + e.text + text.slice(e.end);

  it('handles insertions and deletions at both ends', () => {
    expect(minimalTextEdit('', 'abc')).toEqual({ start: 0, end: 0, text: 'abc' });
    expect(minimalTextEdit('abc', '')).toEqual({ start: 0, end: 3, text: '' });
    expect(minimalTextEdit('abc', 'abcd')).toEqual({ start: 3, end: 3, text: 'd' });
    expect(minimalTextEdit('aaa', 'aa')).toEqual({ start: 2, end: 3, text: '' });
  });

  it('never splits surrogate pairs or CRLF line breaks', () => {
    const emoji = minimalTextEdit('a\u{1F600}b', 'a\u{1F603}b');
    expect(emoji).toEqual({ start: 1, end: 3, text: '\u{1F603}' });
    const crlf = minimalTextEdit('a\r\nb', 'a\r\r\nb');
    expect(crlf.start === 2 && 'a\r\nb'[crlf.start - 1] === '\r').toBe(false);
    expect(applyEdit('a\r\nb', crlf)).toBe('a\r\r\nb');
    expect(minimalTextEdit('a\r\n', 'a\n')).toEqual({ start: 1, end: 3, text: '\n' });
  });

  it('always reproduces the new text', () => {
    const alphabet = ['a', 'b', '\r', '\n', '\u{1F600}', ' '];
    let seed = 7;
    const rand = (n: number) => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return (seed >>> 8) % n;
    };
    const randomText = () => Array.from({ length: rand(12) }, () => alphabet[rand(alphabet.length)]).join('');
    for (let i = 0; i < 500; i++) {
      const a = randomText();
      const b = randomText();
      expect(applyEdit(a, minimalTextEdit(a, b))).toBe(b);
    }
  });
});
