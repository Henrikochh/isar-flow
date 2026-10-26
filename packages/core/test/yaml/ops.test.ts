import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyWorkflowOps,
  createDefaultStep,
  minimalTextEdit,
  newWorkflowText,
  nextStepId,
  parseWorkflowText,
  type WorkflowOp,
} from '../../src/yaml';
import type { Workflow } from '../../src/schema';

const fixture = (name: string) => readFileSync(join(__dirname, '../fixtures', name), 'utf8');

function apply(text: string, ...ops: WorkflowOp[]): string {
  const result = applyWorkflowOps(text, ops);
  if (result.error) throw new Error(result.error);
  return result.text;
}

function ids(text: string): unknown {
  const wf = parseWorkflowText(text).workflow as Workflow;
  const shape = (steps: Workflow['steps']): unknown =>
    steps.map((s) =>
      s.type === 'loop' ? { [s.id]: shape(s.steps) } : s.type === 'if' ? { [s.id]: { then: shape(s.then), else: shape(s.else ?? []) } } : s.id,
    );
  return shape(wf.steps);
}

const base = fixture('commented.workflow.yaml');

describe('insertStep', () => {
  it('inserts at the root, keeping comments', () => {
    const out = apply(base, {
      op: 'insertStep',
      target: { parentId: null, slot: 'steps', index: 2 },
      step: { id: 'done', type: 'stop', outcome: 'success' },
    });
    expect(ids(out)).toEqual(['implement', { review_loop: ['tests', 'review'] }, 'done']);
    expect(out).toContain('# Review loop used by the team.');
    expect(out).toContain('name: Review until approved # shown in the sidebar');
    expect(out).toContain('# First, let the coder implement the task.');
    expect(out).toContain('maxIterations: 5 # keep this low, tokens are expensive');
    expect(parseWorkflowText(out).valid).toBe(true);
  });

  it('inserts into a loop body', () => {
    const out = apply(base, {
      op: 'insertStep',
      target: { parentId: 'review_loop', slot: 'steps', index: 0 },
      step: { id: 'lint', type: 'console', run: 'npm run lint' },
    });
    expect(ids(out)).toEqual(['implement', { review_loop: ['lint', 'tests', 'review'] }]);
  });

  it('creates then/else lists on demand', () => {
    let out = apply(base, {
      op: 'insertStep',
      target: { parentId: 'review_loop', slot: 'steps', index: 2 },
      step: { id: 'check', type: 'if', condition: '${{ true }}', then: [] },
    });
    out = apply(out, {
      op: 'insertStep',
      target: { parentId: 'check', slot: 'else', index: 0 },
      step: { id: 'leave', type: 'break' },
    });
    expect(ids(out)).toEqual(['implement', { review_loop: ['tests', 'review', { check: { then: [], else: ['leave'] } }] }]);
  });

  it('turns an empty flow sequence into a block sequence', () => {
    const out = apply(newWorkflowText('Fresh'), {
      op: 'insertStep',
      target: { parentId: null, slot: 'steps', index: 0 },
      step: { id: 'hello', type: 'console', run: 'echo hi' },
    });
    expect(out).toContain('steps:\n  - id: hello\n    type: console\n    run: echo hi\n');
  });

  it('writes multi-line prompts as block scalars and conditions compactly', () => {
    const out = apply(newWorkflowText('Fresh'), {
      op: 'insertStep',
      target: { parentId: null, slot: 'steps', index: 0 },
      step: {
        id: 'gate',
        type: 'loop',
        maxIterations: 3,
        until: { all: [{ value: '${{ steps.t.exitCode }}', op: 'eq', to: 0 }] },
        steps: [{ id: 'ask', type: 'agent', agent: 'coder', prompt: 'Line one\nLine two' }],
      },
    });
    expect(out).toContain('        prompt: |-\n          Line one\n          Line two');
    expect(out).toContain('- { value: "${{ steps.t.exitCode }}", op: eq, to: 0 }');
  });

  it('rejects duplicate ids and unknown parents', () => {
    expect(
      applyWorkflowOps(base, [
        { op: 'insertStep', target: { parentId: null, slot: 'steps', index: 0 }, step: { id: 'tests', type: 'break' } },
      ]).error,
    ).toMatch(/already exists/);
    expect(
      applyWorkflowOps(base, [
        { op: 'insertStep', target: { parentId: 'nope', slot: 'steps', index: 0 }, step: { id: 'x', type: 'break' } },
      ]).error,
    ).toMatch(/not found/);
  });

  it('clamps out-of-range indexes', () => {
    const out = apply(base, {
      op: 'insertStep',
      target: { parentId: null, slot: 'steps', index: 99 },
      step: { id: 'last', type: 'break' },
    });
    expect(ids(out)).toEqual(['implement', { review_loop: ['tests', 'review'] }, 'last']);
  });
});

describe('moveStep', () => {
  it('moves within the same list using pre-move insertion indexes', () => {
    const out = apply(base, { op: 'moveStep', stepId: 'implement', target: { parentId: null, slot: 'steps', index: 2 } });
    expect(ids(out)).toEqual([{ review_loop: ['tests', 'review'] }, 'implement']);
    expect(out).toContain('# First, let the coder implement the task.');
  });

  it('moves between containers', () => {
    const out = apply(base, { op: 'moveStep', stepId: 'tests', target: { parentId: null, slot: 'steps', index: 0 } });
    expect(ids(out)).toEqual(['tests', 'implement', { review_loop: ['review'] }]);
  });

  it('refuses to move a block into itself', () => {
    const result = applyWorkflowOps(base, [
      { op: 'moveStep', stepId: 'review_loop', target: { parentId: 'review_loop', slot: 'steps', index: 0 } },
    ]);
    expect(result.error).toMatch(/into itself/);
  });
});

describe('deleteStep and duplicateStep', () => {
  it('deletes nested blocks', () => {
    const out = apply(base, { op: 'deleteStep', stepId: 'tests' });
    expect(ids(out)).toEqual(['implement', { review_loop: ['review'] }]);
  });

  it('removes an empty else list', () => {
    let out = apply(base, {
      op: 'insertStep',
      target: { parentId: null, slot: 'steps', index: 2 },
      step: { id: 'gate', type: 'if', condition: 'true', then: [], else: [{ id: 'quit', type: 'stop' }] },
    });
    out = apply(out, { op: 'deleteStep', stepId: 'quit' });
    expect(out).not.toContain('else:');
  });

  it('duplicates with fresh ids for the block and its children', () => {
    const out = apply(base, { op: 'duplicateStep', stepId: 'review_loop' });
    expect(ids(out)).toEqual([
      'implement',
      { review_loop: ['tests', 'review'] },
      { review_loop_2: ['tests_2', 'review_2'] },
    ]);
    expect(parseWorkflowText(out).valid).toBe(true);
  });
});

describe('updateStep, renameStep, updateWorkflow', () => {
  it('updates scalars in place, preserving their comments and style', () => {
    const out = apply(base, { op: 'updateStep', stepId: 'review_loop', set: { maxIterations: 8 } });
    expect(out).toContain('maxIterations: 8 # keep this low, tokens are expensive');
  });

  it('keeps block-literal style when editing a prompt', () => {
    const out = apply(base, {
      op: 'updateStep',
      stepId: 'implement',
      set: { prompt: 'Implement carefully:\n${{ inputs.task }}\n' },
    });
    expect(out).toContain('prompt: |\n      Implement carefully:\n      ${{ inputs.task }}\n');
  });

  it('inserts new keys in canonical order and removes unset keys', () => {
    const out = apply(base, {
      op: 'updateStep',
      stepId: 'tests',
      set: { name: 'Unit tests', timeout: 300 },
      unset: ['continueOnError'],
    });
    expect(out).toContain('- id: tests\n        name: Unit tests\n        type: console\n        run: npm test\n        timeout: 300\n');
    expect(out).not.toContain('continueOnError');
  });

  it('refuses to change ids through updateStep', () => {
    expect(applyWorkflowOps(base, [{ op: 'updateStep', stepId: 'tests', set: { id: 'x' } }]).error).toMatch(/renameStep/);
  });

  it('renames and rewrites references', () => {
    const out = apply(base, { op: 'renameStep', stepId: 'tests', newId: 'unit-tests' });
    expect(out).toContain('- id: unit-tests');
    expect(out).toContain('Tests exited with ${{ steps.unit-tests.exitCode }}.');
    expect(apply(base, { op: 'renameStep', stepId: 'review', newId: 'critique' })).toContain(
      'until: "${{ steps.critique.json.approved }}"',
    );
  });

  it('validates new ids on rename', () => {
    expect(applyWorkflowOps(base, [{ op: 'renameStep', stepId: 'tests', newId: 'review' }]).error).toMatch(/already exists/);
    expect(applyWorkflowOps(base, [{ op: 'renameStep', stepId: 'tests', newId: '9x' }]).error).toMatch(/start with/);
  });

  it('updates workflow fields', () => {
    const out = apply(base, { op: 'updateWorkflow', set: { name: 'Renamed', description: 'Does things' } });
    expect(out).toContain('name: Renamed # shown in the sidebar\ndescription: Does things\n');
  });

  it('applies several ops atomically', () => {
    const result = applyWorkflowOps(base, [
      { op: 'deleteStep', stepId: 'tests' },
      { op: 'deleteStep', stepId: 'missing' },
    ]);
    expect(result.error).toMatch(/not found/);
    expect(result.text).toBe(base);
  });
});

describe('helpers', () => {
  it('nextStepId picks the smallest free number', () => {
    const wf = parseWorkflowText(base).workflow as Workflow;
    expect(nextStepId(wf, 'agent')).toBe('agent_1');
    expect(nextStepId({ ...wf, steps: [...wf.steps, { id: 'agent_1', type: 'break' }] }, 'agent')).toBe('agent_2');
  });

  it('createDefaultStep produces schema-shaped blocks', () => {
    expect(createDefaultStep('loop', 'loop_1')).toEqual({ id: 'loop_1', type: 'loop', maxIterations: 5, steps: [] });
    expect(createDefaultStep('if', 'if_1')).toMatchObject({ type: 'if', then: [], else: [] });
  });

  it('minimalTextEdit returns the smallest replaced range', () => {
    expect(minimalTextEdit('hello world', 'hello brave world')).toEqual({ start: 6, end: 6, text: 'brave ' });
    expect(minimalTextEdit('abc', 'abc')).toEqual({ start: 3, end: 3, text: '' });
    expect(minimalTextEdit('aXc', 'aYc')).toEqual({ start: 1, end: 2, text: 'Y' });
    for (let i = 0; i < 200; i++) {
      const a = Math.random().toString(36).repeat(3);
      const b = a.slice(0, i % a.length) + 'zz' + a.slice((i * 7) % a.length);
      const e = minimalTextEdit(a, b);
      expect(a.slice(0, e.start) + e.text + a.slice(e.end)).toBe(b);
    }
  });

  it('newWorkflowText produces a valid empty workflow', () => {
    const result = parseWorkflowText(newWorkflowText('My flow'));
    expect(result.valid).toBe(true);
    expect(result.workflow?.name).toBe('My flow');
  });
});
