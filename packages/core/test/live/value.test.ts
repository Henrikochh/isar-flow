import { describe, expect, it } from 'vitest';
import { SECRET_MASK } from '../../src/engine/mask';
import { liveValue } from '../../src/live';
import type { LiveValue } from '../../src/run/types';
import type { Workflow } from '../../src/schema/types';
import { liveCtx } from './helpers';

const context = liveCtx({
  inputs: { task: 'login form', rounds: 3, strict: false, empty: '', tags: ['a', 'b'], nothing: null },
  steps: {
    tests: { status: 'failure', exitCode: 1, output: '1 failed\n', error: 'Command exited with code 1' },
    review: { status: 'success', text: '{"approved":false}', json: { approved: false, issues: ['x'] } },
    fix: { status: 'skipped', durationMs: 0 },
    deploy: { status: 'success', output: `token ${SECRET_MASK} used` },
  },
  loops: { outer: { iteration: 2, index: 1 }, inner: { iteration: 3, index: 2 } },
  env: ['HOME'],
  secrets: ['API_TOKEN'],
});

const value = (text: string, type: string, extra: Partial<LiveValue> = {}): LiveValue =>
  ({ kind: 'value', text, type, truncated: false, masked: false, ...extra }) as LiveValue;

const workflow: Workflow = {
  version: 1,
  name: 'Nested',
  steps: [
    { id: 'setup', type: 'console', run: 'echo ${{ loop.iteration }}' },
    {
      id: 'outer',
      type: 'loop',
      maxIterations: 5,
      until: '${{ loop.iteration == 2 }}',
      steps: [
        { id: 'in_outer', type: 'console', run: 'echo' },
        {
          id: 'inner',
          type: 'loop',
          maxIterations: 3,
          while: '${{ loop.index < 3 }}',
          steps: [
            {
              id: 'gate',
              type: 'if',
              condition: '${{ true }}',
              then: [{ id: 'deep', type: 'console', run: 'echo' }],
            },
          ],
        },
      ],
    },
    { id: 'never', type: 'loop', maxIterations: 2, steps: [{ id: 'in_never', type: 'break' }] },
  ],
};

describe('liveValue', () => {
  it.each<[string, LiveValue]>([
    ['inputs.task', value('login form', 'text')],
    ['inputs.empty', value('', 'empty')],
    ['inputs.rounds', value('3', 'number')],
    ['inputs.rounds * 2', value('6', 'number')],
    ['inputs.strict', value('false', 'boolean')],
    ['steps.tests.exitCode == 0', value('false', 'boolean')],
    ['inputs.tags', value('[\n  "a",\n  "b"\n]', 'list')],
    ['steps.review.json', value('{\n  "approved": false,\n  "issues": [\n    "x"\n  ]\n}', 'object')],
    ['inputs.nothing', value('', 'empty')],
    ['inputs.missing', value('', 'empty')],
    ['steps.tests.output', value('1 failed\n', 'text')],
    ["'a }} b'", value('a }} b', 'text')],
    ['join(steps.review.json.issues, ", ")', value('x', 'text')],
    ['steps.fix.status', value('skipped', 'text')],
    ['steps.fix.text', value('', 'empty')],
    ['workflow.name', value('Review loop', 'text')],
    ['workspace.root', value('/ws', 'text')],
    ['run.id', value('run-1', 'text')],
  ])('evaluates %s', (expression, expected) => {
    expect(liveValue(context, expression)).toEqual(expected);
  });

  it('masks secrets and reports masked values', () => {
    expect(liveValue(context, 'secrets.API_TOKEN')).toEqual(value(SECRET_MASK, 'text', { masked: true }));
    expect(liveValue(context, "'Bearer ' + secrets.API_TOKEN")).toEqual(
      value(`Bearer ${SECRET_MASK}`, 'text', { masked: true }),
    );
    expect(liveValue(context, 'steps.deploy.output')).toMatchObject({ kind: 'value', masked: true });
    expect(liveValue(context, 'secrets.OTHER')).toEqual(value('', 'empty'));
  });

  it('never shows environment values', () => {
    const unavailable = { kind: 'unavailable', message: "Environment values aren't saved with runs." };
    expect(liveValue(context, 'env.HOME')).toEqual(unavailable);
    expect(liveValue(context, 'env')).toEqual(unavailable);
    expect(liveValue(context, "inputs.task + ' in ' + env.HOME")).toEqual(unavailable);
    expect(liveValue(context, 'steps.nope.text || env.HOME')).toEqual(unavailable);
  });

  it('reports blocks without a result in the run', () => {
    expect(liveValue(context, 'steps.lint.exitCode')).toEqual({
      kind: 'unavailable',
      message: 'lint has no result in this run.',
    });
    expect(liveValue(context, "steps['lint'].exitCode == 0")).toEqual({
      kind: 'unavailable',
      message: 'lint has no result in this run.',
    });
  });

  it('reports parse errors and evaluation errors', () => {
    expect(liveValue(context, 'steps.tests.')).toMatchObject({ kind: 'error' });
    expect(liveValue(context, '')).toMatchObject({ kind: 'error' });
    const unknownFunction = liveValue(context, 'nope(1)');
    expect(unknownFunction.kind).toBe('error');
    const invalidRegex = liveValue(context, "matches(inputs.task, '(')");
    expect(invalidRegex.kind).toBe('error');
    expect((invalidRegex as { message: string }).message).not.toBe('');
  });

  describe('loop scope', () => {
    const at = (stepId: string | null) => ({ workflow, stepId });

    it('reads the innermost loop that contains the block', () => {
      expect(liveValue(context, 'loop.iteration', at('in_outer'))).toEqual(value('2', 'number'));
      expect(liveValue(context, 'loop.index', at('deep'))).toEqual(value('2', 'number'));
      expect(liveValue(context, 'loop.iteration', at('gate'))).toEqual(value('3', 'number'));
    });

    it("uses the loop's own iteration for its until / while", () => {
      expect(liveValue(context, 'loop.iteration == 2', at('outer'))).toEqual(value('true', 'boolean'));
      expect(liveValue(context, 'loop.index', at('inner'))).toEqual(value('2', 'number'));
    });

    it('is unavailable outside loops and without a scope', () => {
      const outside = { kind: 'unavailable', message: 'loop is only set inside a loop.' };
      expect(liveValue(context, 'loop.iteration', at('setup'))).toEqual(outside);
      expect(liveValue(context, 'loop.iteration')).toEqual(outside);
      expect(liveValue(context, 'loop.iteration', { workflow: null, stepId: 'deep' })).toEqual(outside);
      expect(liveValue(context, 'loop.iteration', at('unknown'))).toEqual(outside);
      expect(liveValue(context, 'loop.iteration', at(null))).toEqual(outside);
    });

    it('is unavailable when the loop did not run', () => {
      expect(liveValue(context, 'loop.iteration', at('in_never'))).toEqual({
        kind: 'unavailable',
        message: 'never has no result in this run.',
      });
    });

    it('does not need a loop for expressions without loop', () => {
      expect(liveValue(context, 'inputs.rounds', at('setup'))).toEqual(value('3', 'number'));
    });
  });

  describe('truncation', () => {
    const cut = `${'x'.repeat(2048)}…`;
    const big = liveCtx({
      inputs: { long: 'y'.repeat(1500) },
      steps: { tests: { status: 'success', output: cut, json: { log: cut } } },
    });

    it('cuts long values at 2,048 characters', () => {
      const result = liveValue(big, 'inputs.long + inputs.long');
      expect(result).toMatchObject({ kind: 'value', type: 'text', truncated: true });
      expect((result as { text: string }).text).toHaveLength(2048);
    });

    it('marks values built from outputs that were cut', () => {
      expect(liveValue(big, 'steps.tests.output')).toMatchObject({
        truncated: true,
        text: cut.slice(0, 2048),
      });
      expect(liveValue(big, 'tail(steps.tests.output, 1)')).toMatchObject({ truncated: true });
      expect(liveValue(big, 'steps.tests.output.length')).toMatchObject({ truncated: true });
      expect(liveValue(big, 'steps.tests.json')).toMatchObject({ truncated: true });
      expect(liveValue(big, 'steps.tests.status')).toMatchObject({ truncated: false });
      expect(liveValue(big, 'steps.tests.missing')).toMatchObject({ truncated: false });
      expect(liveValue(big, "steps[inputs.which ? 'a' : 'tests'].output")).toMatchObject({
        truncated: true,
      });
    });

    it('is not truncated for short values', () => {
      expect(liveValue(big, 'inputs.long')).toMatchObject({ truncated: false });
    });
  });
});
