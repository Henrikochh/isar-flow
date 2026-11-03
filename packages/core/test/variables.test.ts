import { describe, expect, it } from 'vitest';
import type { Condition } from '../src/conditions';
import { analyzeExpression, parseExpression } from '../src/expr';
import {
  type AgentStep,
  type ConsoleStep,
  type IfStep,
  type LoopStep,
  STEP_TYPES,
  type Step,
  type Workflow,
} from '../src/schema';
import { availableVariables, STEP_OUTPUTS, type VariableInfo } from '../src/variables';

const workflow = (steps: Step[], extra: Partial<Workflow> = {}): Workflow => ({
  version: 1,
  name: 'Test',
  steps,
  ...extra,
});
const agent = (id: string, prompt = 'Do the task', extra: Partial<AgentStep> = {}): AgentStep => ({
  id,
  type: 'agent',
  agent: 'coder',
  prompt,
  ...extra,
});
const shell = (id: string, run = 'npm test', extra: Partial<ConsoleStep> = {}): ConsoleStep => ({
  id,
  type: 'console',
  run,
  ...extra,
});
const loop = (id: string, steps: Step[], extra: Partial<LoopStep> = {}): LoopStep => ({
  id,
  type: 'loop',
  maxIterations: 3,
  steps,
  ...extra,
});
const branch = (id: string, condition: Condition, then: Step[], otherwise?: Step[]): IfStep => ({
  id,
  type: 'if',
  condition,
  then,
  ...(otherwise ? { else: otherwise } : {}),
});

const sample = workflow(
  [
    agent('plan', 'Plan ${{ inputs.task }}'),
    loop(
      'fix-loop',
      [
        agent('implement'),
        shell('tests'),
        branch(
          'gate',
          '${{ steps.tests.exitCode == 0 }}',
          [{ id: 'ok', type: 'break' }],
          [
            agent('review', 'Review', {
              output: { format: 'json', schema: { approved: 'boolean', issues: 'string[]' } },
            }),
          ],
        ),
      ],
      { until: '${{ steps.review.json.approved }}' },
    ),
    shell('report'),
  ],
  {
    inputs: {
      task: { type: 'string', description: 'What to build', required: true },
      strict: { type: 'boolean' },
    },
    env: { CI: '1', 'MY.VAR': 'x' },
  },
);

const blocksSeen = (stepId: string | null, wf: Workflow = sample) => [
  ...new Set(
    availableVariables(wf, stepId)
      .filter((v) => v.group === 'steps')
      .map((v) => v.stepId),
  ),
];
const expressions = (stepId: string | null, wf: Workflow = sample) =>
  availableVariables(wf, stepId).map((v) => v.expression);
const find = (vars: VariableInfo[], expression: string) => vars.find((v) => v.expression === expression);

describe('STEP_OUTPUTS', () => {
  const keys = (type: keyof typeof STEP_OUTPUTS) => STEP_OUTPUTS[type].map((o) => o.key);

  it('lists status, durationMs and error for every block type', () => {
    for (const type of STEP_TYPES) {
      expect(keys(type).slice(-3)).toEqual(['status', 'durationMs', 'error']);
      expect(STEP_OUTPUTS[type].at(-1)).toMatchObject({ key: 'error', type: 'string' });
    }
  });

  it('follows the outputs of the spec per block type', () => {
    expect(keys('agent')).toEqual([
      'text',
      'json',
      'model',
      'usage.inputTokens',
      'usage.outputTokens',
      'turns',
      'toolCalls',
      'status',
      'durationMs',
      'error',
    ]);
    expect(keys('console')).toEqual([
      'exitCode',
      'stdout',
      'stderr',
      'output',
      'timedOut',
      'status',
      'durationMs',
      'error',
    ]);
    expect(keys('loop')).toEqual(['iterations', 'exitReason', 'status', 'durationMs', 'error']);
    expect(keys('if')).toEqual(['branch', 'result', 'status', 'durationMs', 'error']);
    expect(keys('approval')).toEqual(['approved', 'comment', 'status', 'durationMs', 'error']);
    expect(keys('break')).toEqual(['status', 'durationMs', 'error']);
    expect(keys('stop')).toEqual(['status', 'durationMs', 'error']);
  });

  it('types and describes every output', () => {
    const type = (step: keyof typeof STEP_OUTPUTS, key: string) =>
      STEP_OUTPUTS[step].find((o) => o.key === key)?.type;
    expect(type('console', 'exitCode')).toBe('number');
    expect(type('console', 'timedOut')).toBe('boolean');
    expect(type('agent', 'text')).toBe('string');
    expect(type('agent', 'usage.inputTokens')).toBe('number');
    expect(type('agent', 'toolCalls')).toBe('number');
    expect(STEP_OUTPUTS.agent.find((o) => o.key === 'toolCalls')?.description).toBe(
      'Tool calls the agent made',
    );
    expect(type('loop', 'iterations')).toBe('number');
    expect(type('if', 'result')).toBe('boolean');
    expect(type('approval', 'approved')).toBe('boolean');
    for (const type of STEP_TYPES) {
      for (const output of STEP_OUTPUTS[type]) expect(output.description.length).toBeGreaterThan(0);
    }
  });
});

describe('availableVariables: which blocks are readable', () => {
  it('offers no block outputs to the first block', () => {
    expect(blocksSeen('plan')).toEqual([]);
  });

  it('offers every block of the workflow after the whole workflow (null)', () => {
    expect(blocksSeen(null)).toEqual([
      'plan',
      'fix-loop',
      'implement',
      'tests',
      'gate',
      'ok',
      'review',
      'report',
    ]);
  });

  it('offers earlier blocks, including blocks nested in earlier containers, but never the block itself', () => {
    expect(blocksSeen('report')).toEqual(['plan', 'fix-loop', 'implement', 'tests', 'gate', 'ok', 'review']);
  });

  it('offers all blocks of the enclosing loop body inside a loop, including later ones and the block itself', () => {
    const inside = ['plan', 'implement', 'tests', 'gate', 'ok', 'review'];
    expect(blocksSeen('tests')).toEqual(inside);
    expect(blocksSeen('implement')).toEqual(inside);
  });

  it('does not offer the other branch of an if inside a loop, because the engine marks it skipped first', () => {
    expect(blocksSeen('review')).toEqual(['plan', 'implement', 'tests', 'gate', 'review']);
    expect(blocksSeen('ok')).toEqual(['plan', 'implement', 'tests', 'gate', 'ok']);
  });

  it('offers the loop body to the loop’s own condition, but not the loop itself', () => {
    expect(blocksSeen('fix-loop')).toEqual(['plan', 'implement', 'tests', 'gate', 'ok', 'review']);
  });

  it('includes blocks of every enclosing loop body in nested loops', () => {
    const wf = workflow([
      loop('outer', [shell('before'), loop('inner', [shell('deep')]), shell('after')]),
      shell('end'),
    ]);
    expect(blocksSeen('deep', wf)).toEqual(['before', 'inner', 'deep', 'after']);
    expect(blocksSeen('end', wf)).toEqual(['outer', 'before', 'inner', 'deep', 'after']);
  });

  it('does not offer blocks of the other branch, of the branch being entered or of enclosing ifs outside loops', () => {
    const wf = workflow([shell('a'), branch('check', 'true', [shell('b')], [shell('c')]), shell('d')]);
    expect(blocksSeen('c', wf)).toEqual(['a']);
    expect(blocksSeen('b', wf)).toEqual(['a']);
    expect(blocksSeen('check', wf)).toEqual(['a']);
    expect(blocksSeen('d', wf)).toEqual(['a', 'check', 'b', 'c']);
  });

  it('offers only workflow-level variables for an unknown block id', () => {
    const vars = availableVariables(sample, 'missing');
    expect(vars.filter((v) => v.group === 'steps' || v.group === 'loop')).toEqual([]);
    expect(vars.map((v) => v.expression)).toContain('inputs.task');
  });

  it('lists a duplicated id only once', () => {
    const wf = workflow([shell('a'), shell('a'), shell('b')]);
    const list = expressions('b', wf);
    expect(list.filter((e) => e === 'steps.a.exitCode')).toHaveLength(1);
  });
});

describe('availableVariables: loop variables', () => {
  it('offers loop.iteration and loop.index inside a loop and in its own condition', () => {
    for (const id of ['tests', 'review', 'fix-loop']) {
      expect(expressions(id)).toEqual(expect.arrayContaining(['loop.iteration', 'loop.index']));
    }
    expect(find(availableVariables(sample, 'tests'), 'loop.iteration')).toMatchObject({
      type: 'number',
      group: 'loop',
    });
  });

  it('does not offer loop variables outside loops', () => {
    expect(expressions('plan')).not.toContain('loop.iteration');
    expect(expressions('report')).not.toContain('loop.index');
    expect(expressions(null)).not.toContain('loop.iteration');
  });
});

describe('availableVariables: entries', () => {
  it('offers declared inputs with their type and description', () => {
    const vars = availableVariables(sample, 'plan');
    expect(find(vars, 'inputs.task')).toEqual({
      expression: 'inputs.task',
      label: 'inputs.task',
      description: 'What to build',
      type: 'string',
      group: 'inputs',
    });
    expect(find(vars, 'inputs.strict')).toMatchObject({ type: 'boolean', group: 'inputs' });
    expect(find(vars, 'inputs.strict')?.description.length).toBeGreaterThan(0);
  });

  it('offers workflow, workspace, run and env variables everywhere', () => {
    for (const id of ['plan', 'tests', null]) {
      expect(expressions(id)).toEqual(
        expect.arrayContaining([
          'workflow.name',
          'workflow.file',
          'workspace.root',
          'run.id',
          'env.CI',
          "env['MY.VAR']",
        ]),
      );
    }
    const vars = availableVariables(sample, 'plan');
    expect(find(vars, 'workflow.name')?.group).toBe('workflow');
    expect(find(vars, 'workspace.root')?.group).toBe('workflow');
    expect(find(vars, 'run.id')?.group).toBe('run');
    expect(find(vars, 'env.CI')).toMatchObject({ group: 'env', type: 'string' });
  });

  it('describes block outputs with dot paths, the block id and the output type', () => {
    const vars = availableVariables(sample, 'report');
    expect(find(vars, 'steps.tests.exitCode')).toEqual({
      expression: 'steps.tests.exitCode',
      label: 'tests.exitCode',
      description: STEP_OUTPUTS.console[0].description,
      type: 'number',
      group: 'steps',
      stepId: 'tests',
    });
    expect(expressions('report')).toEqual(
      expect.arrayContaining([
        'steps.plan.usage.inputTokens',
        'steps.plan.usage.outputTokens',
        'steps.plan.toolCalls',
        'steps.fix-loop.iterations',
        'steps.fix-loop.exitReason',
        'steps.gate.branch',
        'steps.gate.result',
        'steps.ok.status',
        'steps.ok.durationMs',
        'steps.ok.error',
      ]),
    );
  });

  it('offers the error of every readable block', () => {
    const vars = availableVariables(sample, 'report');
    for (const id of ['plan', 'tests', 'fix-loop', 'gate', 'review']) {
      expect(find(vars, `steps.${id}.error`)).toMatchObject({ type: 'string', group: 'steps', stepId: id });
    }
    expect(find(vars, 'steps.review.error')?.description).toMatch(/failed or was cancelled/);
  });

  it('only offers json for agent blocks with JSON output and adds fields of a compact shape', () => {
    const vars = availableVariables(sample, 'report');
    expect(find(vars, 'steps.plan.text')).toBeDefined();
    expect(find(vars, 'steps.plan.json')).toBeUndefined();
    expect(find(vars, 'steps.review.json')).toMatchObject({ type: 'object', stepId: 'review' });
    expect(find(vars, 'steps.review.json.approved')).toMatchObject({
      type: 'boolean',
      group: 'steps',
      stepId: 'review',
      label: 'review.json.approved',
    });
    expect(find(vars, 'steps.review.json.issues')?.type).toBe('list');
  });

  it('adds fields of a full JSON Schema output, including nested objects', () => {
    const wf = workflow([
      agent('judge', 'Judge', {
        output: {
          format: 'json',
          schema: {
            type: 'object',
            properties: {
              score: { type: 'number' },
              meta: { type: 'object', properties: { ok: { type: 'boolean' } } },
            },
          },
        },
      }),
    ]);
    const vars = availableVariables(wf, null);
    expect(find(vars, 'steps.judge.json')?.type).toBe('object');
    expect(find(vars, 'steps.judge.json.score')?.type).toBe('number');
    expect(find(vars, 'steps.judge.json.meta')?.type).toBe('object');
    expect(find(vars, 'steps.judge.json.meta.ok')?.type).toBe('boolean');
  });

  it('offers untyped json when an agent asks for JSON without a schema', () => {
    const wf = workflow([agent('free', 'Answer', { output: { format: 'json' } })]);
    const vars = availableVariables(wf, null);
    expect(find(vars, 'steps.free.json')?.type).toBe('any');
    expect(vars.filter((v) => v.expression.startsWith('steps.free.json.'))).toEqual([]);
  });

  it('uses bracket access for names that are not plain identifiers', () => {
    const wf = workflow([
      shell('a-'),
      agent('j', 'x', { output: { format: 'json', schema: { 'two words': 'string' } } }),
    ]);
    const list = expressions(null, wf);
    expect(list).toContain("steps['a-'].exitCode");
    expect(list).toContain("steps.j.json['two words']");
  });

  it('labels block outputs by block id even when the expression needs brackets', () => {
    const vars = availableVariables(workflow([shell('a-')]), null);
    expect(find(vars, "steps['a-'].exitCode")?.label).toBe('a-.exitCode');
  });

  it('produces expressions that parse back to the same reference path', () => {
    for (const v of availableVariables(sample, null)) {
      expect(() => parseExpression(v.expression)).not.toThrow();
      expect(analyzeExpression(v.expression).references).toHaveLength(1);
    }
    expect(analyzeExpression("env['MY.VAR']").references).toEqual([['env', 'MY.VAR']]);
  });

  it('orders groups as inputs, steps, loop, workflow, env, run', () => {
    const groups = availableVariables(sample, 'tests').map((v) => v.group);
    const order = [...new Set(groups)];
    expect(order).toEqual(['inputs', 'steps', 'loop', 'workflow', 'env', 'run']);
  });
});

describe('availableVariables: JSON output shapes, read the way the agent runtime reads them', () => {
  const jsonVariables = (schema: unknown) =>
    availableVariables(
      workflow([agent('j', 'x', { output: { format: 'json', schema: schema as Record<string, unknown> } })]),
      null,
    )
      .filter((v) => v.stepId === 'j' && v.expression.startsWith('steps.j.json'))
      .map((v) => [v.expression, v.type]);

  it('drops the optional marker of keys and types', () => {
    expect(jsonVariables({ 'notes?': 'string', score: 'number?', tags: 'string[]?' })).toEqual([
      ['steps.j.json', 'object'],
      ['steps.j.json.notes', 'string'],
      ['steps.j.json.score', 'number'],
      ['steps.j.json.tags', 'list'],
    ]);
  });

  it('reads a JSON Schema that has properties but no type, or a list of types', () => {
    expect(jsonVariables({ properties: { score: { type: 'number' } }, required: ['score'] })).toEqual([
      ['steps.j.json', 'object'],
      ['steps.j.json.score', 'number'],
    ]);
    expect(jsonVariables({ type: ['object', 'null'], properties: { ok: { type: 'boolean' } } })).toEqual([
      ['steps.j.json', 'object'],
      ['steps.j.json.ok', 'boolean'],
    ]);
    expect(jsonVariables({ type: 'array', items: { type: 'string' } })).toEqual([['steps.j.json', 'list']]);
  });

  it('reads a compact shape with a field named type as a compact shape', () => {
    expect(jsonVariables({ type: 'string', severity: 'number' })).toEqual([
      ['steps.j.json', 'object'],
      ['steps.j.json.type', 'string'],
      ['steps.j.json.severity', 'number'],
    ]);
  });

  it('types one-element list shapes, integer, any and JSON Schemas nested in compact shapes', () => {
    const shape = {
      findings: [{ file: 'string' }],
      count: 'integer',
      raw: 'any',
      score: { type: 'number', minimum: 0 },
      meta: { author: 'string' },
    };
    expect(jsonVariables(shape)).toEqual([
      ['steps.j.json', 'object'],
      ['steps.j.json.findings', 'list'],
      ['steps.j.json.count', 'number'],
      ['steps.j.json.raw', 'any'],
      ['steps.j.json.score', 'number'],
      ['steps.j.json.meta', 'object'],
      ['steps.j.json.meta.author', 'string'],
    ]);
  });

  it('offers untyped json for a schema that is not a mapping', () => {
    expect(jsonVariables('string[]')).toEqual([['steps.j.json', 'any']]);
    expect(jsonVariables(null)).toEqual([['steps.j.json', 'any']]);
  });
});

describe('availableVariables: lenient models', () => {
  it('does not throw on partially invalid workflows', () => {
    const broken = {
      version: 1,
      name: 'Broken',
      inputs: 'nope',
      env: null,
      steps: [
        null,
        'text',
        { type: 'loop', steps: 'nope' },
        { id: 'a', type: 'if', then: null },
        { id: 'b', type: 'weird' },
        shell('c'),
      ],
    } as unknown as Workflow;
    expect(() => availableVariables(broken, 'c')).not.toThrow();
    // Blocks of unknown types have no known outputs.
    expect(blocksSeen('c', broken)).toEqual(['a']);
    expect(() =>
      availableVariables({ version: 1, name: 'Empty' } as unknown as Workflow, null),
    ).not.toThrow();
  });
});
