import { describe, expect, it } from 'vitest';
import type { Condition } from '../src/conditions';
import type { Diagnostic } from '../src/diagnostics';
import type { AgentStep, ConsoleStep, IfStep, LoopStep, Step, Workflow } from '../src/schema';
import { type ValidateOptions, validateWorkflow } from '../src/validate';
import { availableVariables } from '../src/variables';

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

const check = (steps: Step[], options?: ValidateOptions, extra?: Partial<Workflow>) =>
  validateWorkflow(workflow(steps, extra), options);
const withCode = (diagnostics: Diagnostic[], code: string) => diagnostics.filter((d) => d.code === code);
const codes = (diagnostics: Diagnostic[]) => diagnostics.map((d) => d.code);

describe('a well-formed workflow', () => {
  it('has no diagnostics', () => {
    const steps: Step[] = [
      agent('implement', 'Implement ${{ inputs.task }}'),
      loop(
        'review-loop',
        [
          shell('tests', 'npm test', {
            continueOnError: true,
            cwd: '${{ workspace.root }}',
            env: { RUN: '${{ run.id }}' },
          }),
          branch('failing', { value: '${{ steps.tests.exitCode }}', op: 'neq', to: 0 }, [
            agent('fix', 'Fix:\n${{ tail(steps.tests.output, 50) }}'),
          ]),
          agent('review', 'Review attempt ${{ loop.iteration }} of ${{ workflow.name }}', {
            output: { format: 'json', schema: { approved: 'boolean' } },
          }),
          branch('done', '${{ steps.review.json.approved }}', [{ id: 'leave', type: 'break' }]),
        ],
        {
          until: {
            all: [
              { value: '${{ steps.review.json.approved }}', op: 'isTrue' },
              { value: '${{ steps.tests.output }}', op: 'matches', to: '\\d+ passed' },
            ],
          },
        },
      ),
      { id: 'ask', type: 'approval', message: 'Merge after ${{ steps.review-loop.iterations }} rounds?' },
      {
        id: 'end',
        type: 'stop',
        outcome: 'success',
        message: '${{ secrets.TOKEN }} ${{ env.CI }} ${{ workflow.file }}',
      },
    ];
    const options = { agentIds: ['coder'], modelRefs: ['litellm/gpt'], secretNames: ['TOKEN'] };
    expect(check(steps, options, { inputs: { task: { type: 'string' } }, env: { CI: '1' } })).toEqual([]);
  });

  it('accepts every variable that availableVariables offers at a block', () => {
    const build = (target: string, text: string) => {
      const field = (id: string) => (id === target ? text : 'echo');
      return workflow(
        [
          shell('first', field('first')),
          loop('l', [
            shell('inner', field('inner')),
            branch(
              'b',
              'true',
              [shell('yes', field('yes'))],
              [
                agent('judge', field('judge'), {
                  output: { format: 'json', schema: { ok: 'boolean', tags: 'string[]' } },
                }),
              ],
            ),
          ]),
          shell('last', field('last')),
        ],
        { inputs: { task: {} }, env: { CI: '1', 'MY.VAR': '2' } },
      );
    };
    for (const target of ['first', 'inner', 'yes', 'judge', 'last']) {
      const text = availableVariables(build(target, ''), target)
        .map((v) => `\${{ ${v.expression} }}`)
        .join(' ');
      expect(validateWorkflow(build(target, text)), target).toEqual([]);
    }
  });
});

describe('duplicate-id', () => {
  it('reports every duplicate after the first', () => {
    const diagnostics = withCode(check([shell('a'), loop('l', [shell('a')]), shell('a')]), 'duplicate-id');
    expect(diagnostics.map((d) => d.path)).toEqual([
      ['steps', 1, 'steps', 0, 'id'],
      ['steps', 2, 'id'],
    ]);
    expect(diagnostics.every((d) => d.severity === 'error' && d.stepId === 'a')).toBe(true);
    expect(diagnostics[0].message).toContain("'a'");
  });

  it('accepts unique ids', () => {
    expect(withCode(check([shell('a'), loop('l', [shell('b')])]), 'duplicate-id')).toEqual([]);
  });
});

describe('break-outside-loop', () => {
  it('reports a break at the top level', () => {
    const [d] = withCode(check([shell('a'), { id: 'b', type: 'break' }]), 'break-outside-loop');
    expect(d).toMatchObject({ severity: 'error', path: ['steps', 1], stepId: 'b' });
  });

  it('reports a break inside an if that is not inside a loop', () => {
    const diagnostics = check([branch('c', 'true', [{ id: 'b', type: 'break' }])]);
    expect(withCode(diagnostics, 'break-outside-loop')).toHaveLength(1);
  });

  it('accepts a break inside an if inside a loop', () => {
    const diagnostics = check([loop('l', [branch('c', 'true', [{ id: 'b', type: 'break' }])])]);
    expect(withCode(diagnostics, 'break-outside-loop')).toEqual([]);
  });
});

describe('agent-missing', () => {
  it('reports an agent block without agent and model', () => {
    const [d] = withCode(check([{ id: 'x', type: 'agent', prompt: 'Hi' }]), 'agent-missing');
    expect(d).toMatchObject({ severity: 'error', stepId: 'x', path: ['steps', 0] });
    expect(d.message).toContain("Choose an agent or a model for block 'x'");
  });

  it('reports an inline agent without any model', () => {
    const [d] = withCode(check([agent('x', 'Hi', { agent: { systemPrompt: 'Be brief' } })]), 'agent-missing');
    expect(d).toMatchObject({ severity: 'error', path: ['steps', 0, 'agent'] });
  });

  it('accepts an agent id, a model, or an inline agent with a model', () => {
    const steps: Step[] = [
      agent('a'),
      { id: 'b', type: 'agent', prompt: 'Hi', model: 'litellm/gpt' },
      agent('c', 'Hi', { agent: { model: 'litellm/gpt' } }),
      agent('d', 'Hi', { agent: { systemPrompt: 'Be brief' }, model: 'litellm/gpt' }),
    ];
    expect(withCode(check(steps), 'agent-missing')).toEqual([]);
  });
});

describe('unknown-agent', () => {
  it('reports agent ids that are not in agentIds', () => {
    const [d] = withCode(
      check([agent('x', 'Hi', { agent: 'reviewer' })], { agentIds: ['coder'] }),
      'unknown-agent',
    );
    expect(d).toMatchObject({ severity: 'error', path: ['steps', 0, 'agent'], stepId: 'x' });
    expect(d.message).toContain("'reviewer'");
  });

  it('treats an empty agentIds list as "no agents exist"', () => {
    expect(withCode(check([agent('x')], { agentIds: [] }), 'unknown-agent')).toHaveLength(1);
  });

  it('accepts known agents, inline agents and skips the check without agentIds', () => {
    expect(withCode(check([agent('x')], { agentIds: ['coder'] }), 'unknown-agent')).toEqual([]);
    expect(
      withCode(check([agent('x', 'Hi', { agent: { model: 'a/b' } })], { agentIds: [] }), 'unknown-agent'),
    ).toEqual([]);
    expect(withCode(check([agent('x', 'Hi', { agent: 'reviewer' })]), 'unknown-agent')).toEqual([]);
  });
});

describe('unknown-model', () => {
  const modelRefs = ['litellm/gpt', 'vscode/copilot/gpt-4.1'];

  it('warns about a step model that is not available', () => {
    const [d] = withCode(
      check([agent('x', 'Hi', { model: 'litellm/nope' })], { modelRefs }),
      'unknown-model',
    );
    expect(d).toMatchObject({ severity: 'warning', path: ['steps', 0, 'model'], stepId: 'x' });
    expect(d.message).toContain("'litellm/nope'");
  });

  it('warns about inline agent models and fallback models', () => {
    const step = agent('x', 'Hi', {
      agent: { model: 'other/a', fallbackModels: ['vscode/copilot/gpt-4.1', 'other/b'] },
    });
    const diagnostics = withCode(check([step], { modelRefs }), 'unknown-model');
    expect(diagnostics.map((d) => d.path)).toEqual([
      ['steps', 0, 'agent', 'model'],
      ['steps', 0, 'agent', 'fallbackModels', 1],
    ]);
  });

  it('accepts known models and skips the check without a model list', () => {
    expect(
      withCode(check([agent('x', 'Hi', { model: 'litellm/gpt' })], { modelRefs }), 'unknown-model'),
    ).toEqual([]);
    expect(withCode(check([agent('x', 'Hi', { model: 'a/b' })], { modelRefs: [] }), 'unknown-model')).toEqual(
      [],
    );
    expect(withCode(check([agent('x', 'Hi', { model: 'a/b' })]), 'unknown-model')).toEqual([]);
  });
});

describe('expression-syntax', () => {
  it.each<[string, Step, (string | number)[]]>([
    ['prompt', agent('a', 'Do ${{ contains(inputs.task }}'), ['steps', 0, 'prompt']],
    ['run', shell('a', 'echo ${{ 1 + }}'), ['steps', 0, 'run']],
    ['cwd', shell('a', 'ls', { cwd: '${{ workspace..root }}' }), ['steps', 0, 'cwd']],
    ['env value', shell('a', 'ls', { env: { TOKEN: '${{ ) }}' } }), ['steps', 0, 'env', 'TOKEN']],
    ['stop message', { id: 'a', type: 'stop', message: 'Done ${{ }}' }, ['steps', 0, 'message']],
    [
      'approval message',
      { id: 'a', type: 'approval', message: 'OK ${{ inputs.task' },
      ['steps', 0, 'message'],
    ],
    ['until expression', loop('a', [shell('t')], { until: 'steps.t.exitCode ==' }), ['steps', 0, 'until']],
    [
      'while template',
      loop('a', [shell('t')], { while: '${{ steps.t.exitCode !! }}' }),
      ['steps', 0, 'while'],
    ],
    [
      'nested condition value',
      branch(
        'a',
        { any: [{ value: 'x', op: 'eq', to: 'y' }, { not: { value: '${{ (1 }}', op: 'isTrue' } }] },
        [shell('t')],
      ),
      ['steps', 0, 'condition', 'any', 1, 'not', 'value'],
    ],
    [
      'comparison to',
      branch('a', { value: '${{ inputs.task }}', op: 'eq', to: '${{ 1 + }}' }, [shell('t')]),
      ['steps', 0, 'condition', 'to'],
    ],
    [
      'context files',
      agent('a', 'Hi', { context: { files: ['src/**/*.ts', 'docs/${{ inputs.task'] } }),
      ['steps', 0, 'context', 'files', 1],
    ],
    ['blank if condition', branch('a', '  ', [shell('t')]), ['steps', 0, 'condition']],
    [
      'blank nested condition',
      loop('a', [shell('t')], { until: { all: [{ value: '${{ steps.t.stdout }}', op: 'isEmpty' }, ' '] } }),
      ['steps', 0, 'until', 'all', 1],
    ],
  ])('reports a broken expression in %s', (_name, step, path) => {
    const diagnostics = withCode(check([step], undefined, { inputs: { task: {} } }), 'expression-syntax');
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ severity: 'error', path, stepId: 'a' });
  });

  it('names the field and includes the parser message', () => {
    const [d] = withCode(check([agent('a', 'Do ${{ contains(inputs.task }}')]), 'expression-syntax');
    expect(d.message).toContain('prompt');
    expect(d.message).toContain("Expected ')' but found end of expression");
    const [cond] = withCode(
      check([loop('l', [shell('t')], { until: { all: [{ value: '${{ 1 + }}', op: 'isTrue' }] } })]),
      'expression-syntax',
    );
    expect(cond.message).toContain('until.all[0].value');
    const [unterminated] = withCode(check([shell('a', 'echo ${{ inputs.task')]), 'expression-syntax');
    expect(unterminated.message).toContain('Unterminated');
    const [blank] = withCode(check([branch('c', ' ', [shell('t')])]), 'expression-syntax');
    expect(blank.message).toContain("condition of 'c' is empty");
  });

  it('points at the innermost block of nested fields', () => {
    const [d] = withCode(
      check([shell('first'), loop('l', [agent('inner', '${{ 1 + }}')])]),
      'expression-syntax',
    );
    expect(d).toMatchObject({ path: ['steps', 1, 'steps', 0, 'prompt'], stepId: 'inner' });
  });

  it('accepts plain text, literal comparison operands and valid expressions', () => {
    const steps: Step[] = [
      agent('a', 'No templates here { } $ {{ x }}'),
      branch('b', { value: 'literal', op: 'eq', to: 'other' }, [shell('t', 'echo ${{ 1 + 2 * 3 }}')]),
      loop('c', [shell('u')], { until: 'steps.u.exitCode == 0 && true' }),
    ];
    expect(withCode(check(steps), 'expression-syntax')).toEqual([]);
  });

  it('accepts templates and condition expressions that span CRLF lines', () => {
    const steps: Step[] = [
      shell('t', 'echo ${{\r\n  inputs.task\r\n}}\r\nnpm test\r\n'),
      loop('l', [shell('u')], { until: 'steps.u.exitCode == 0 &&\r\n  true' }),
    ];
    expect(check(steps, undefined, { inputs: { task: {} } })).toEqual([]);
  });

  it('checks templates in workflow-level env values', () => {
    const [d] = withCode(check([shell('a')], undefined, { env: { A: '${{ 1 + }}' } }), 'expression-syntax');
    expect(d).toMatchObject({ severity: 'error', path: ['env', 'A'] });
    expect(d.stepId).toBeUndefined();
  });

  it('checks workflow-level env values as rendered once when the run starts, before any block', () => {
    const env = {
      A: '${{ steps.first.stdout }}',
      B: '${{ loop.iteration }}',
      C: '${{ steps.nope.stdout }} ${{ inputs.x }} ${{ inputs.task }} ${{ env.HOME }} ${{ run.id }}',
    };
    const diagnostics = check([shell('first')], undefined, { env, inputs: { task: {} } });
    expect(diagnostics.map((d) => [d.code, d.severity, d.path])).toEqual([
      ['forward-reference', 'warning', ['env', 'A']],
      ['loop-variable-outside-loop', 'error', ['env', 'B']],
      ['unknown-step-reference', 'error', ['env', 'C']],
      ['unknown-input', 'error', ['env', 'C']],
    ]);
    expect(diagnostics.every((d) => d.stepId === undefined)).toBe(true);
    expect(diagnostics[0].message).toContain('when the run starts');
    expect(diagnostics[1].message).toContain('when the run starts');
  });
});

describe('unknown-function', () => {
  it('reports calls to functions that do not exist', () => {
    const [d] = withCode(
      check([agent('a', '${{ shout(inputs.task) }}')], undefined, { inputs: { task: {} } }),
      'unknown-function',
    );
    expect(d).toMatchObject({ severity: 'error', path: ['steps', 0, 'prompt'], stepId: 'a' });
    expect(d.message).toContain("'shout'");
  });

  it('reports unknown functions in expression-form conditions', () => {
    expect(withCode(check([loop('l', [shell('t')], { until: 'nope(1)' })]), 'unknown-function')).toHaveLength(
      1,
    );
  });

  it('accepts built-in functions', () => {
    const prompt = '${{ upper(trim(default(inputs.task, "x"))) }} ${{ join(lines(steps.t.stdout), ", ") }}';
    expect(
      withCode(
        check([shell('t'), agent('a', prompt)], undefined, { inputs: { task: {} } }),
        'unknown-function',
      ),
    ).toEqual([]);
  });
});

describe('invalid-regex', () => {
  it('reports invalid literal patterns of matches and notMatches comparisons', () => {
    const steps: Step[] = [
      shell('t'),
      branch('a', { value: '${{ steps.t.stdout }}', op: 'matches', to: '([a-z' }, [shell('x')]),
      loop('l', [shell('u')], {
        until: { not: { value: '${{ steps.u.stdout }}', op: 'notMatches', to: '*oops' } },
      }),
    ];
    const diagnostics = withCode(check(steps), 'invalid-regex');
    expect(diagnostics.map((d) => d.path)).toEqual([
      ['steps', 1, 'condition', 'to'],
      ['steps', 2, 'until', 'not', 'to'],
    ]);
    expect(diagnostics[0]).toMatchObject({ severity: 'error', stepId: 'a' });
    expect(diagnostics[0].message).toContain('([a-z');
  });

  it('skips templated patterns and other operators', () => {
    const steps: Step[] = [
      shell('t'),
      branch('a', { value: '${{ steps.t.stdout }}', op: 'matches', to: '${{ steps.t.stderr }}' }, [
        shell('x'),
      ]),
      branch('b', { value: '${{ steps.t.stdout }}', op: 'contains', to: '([a-z' }, [shell('y')]),
      branch('c', { value: '${{ steps.t.stdout }}', op: 'matches', to: '^\\d+ (passed|failed)$' }, [
        shell('z'),
      ]),
    ];
    expect(withCode(check(steps), 'invalid-regex')).toEqual([]);
  });

  it('reports invalid literal patterns and flags passed to matches()', () => {
    const diagnostics = withCode(
      check(
        [
          shell('t', "echo ${{ matches(inputs.task, '[unclosed') }}"),
          shell('u', "echo ${{ matches(inputs.task, 'a', 'zz') }}"),
          shell('v', "echo ${{ matches(inputs.task, 'a', 1) }}"),
        ],
        undefined,
        { inputs: { task: {} } },
      ),
      'invalid-regex',
    );
    expect(diagnostics.map((d) => d.stepId)).toEqual(['t', 'u', 'v']);
    expect(diagnostics[0].path).toEqual(['steps', 0, 'run']);
    expect(diagnostics[0].message).toMatch(/Fix the pattern\.$/);
    expect(diagnostics[1].message).toMatch(/Fix the pattern or its flags\.$/);
  });

  it('accepts valid and dynamic patterns in matches()', () => {
    const run =
      "echo ${{ matches(inputs.task, '^fix') }} ${{ matches(inputs.task, inputs.pattern, 'i') }}" +
      " ${{ matches(inputs.task, 'a', null) }}";
    const diagnostics = check([shell('t', run)], undefined, { inputs: { task: {}, pattern: {} } });
    expect(withCode(diagnostics, 'invalid-regex')).toEqual([]);
  });
});

describe('unknown-step-reference', () => {
  it('reports references to blocks that do not exist', () => {
    const [d] = withCode(check([agent('a', '${{ steps.nope.text }}')]), 'unknown-step-reference');
    expect(d).toMatchObject({ severity: 'error', path: ['steps', 0, 'prompt'], stepId: 'a' });
    expect(d.message).toContain('nope');
  });

  it('reports literal bracket access too', () => {
    expect(withCode(check([agent('a', "${{ steps['nope'].text }}")]), 'unknown-step-reference')).toHaveLength(
      1,
    );
  });

  it('accepts existing blocks and dynamic access', () => {
    const steps: Step[] = [
      shell('t'),
      agent('a', '${{ steps.t.stdout }} ${{ steps[inputs.which].text }} ${{ steps }}'),
    ];
    expect(withCode(check(steps, undefined, { inputs: { which: {} } }), 'unknown-step-reference')).toEqual(
      [],
    );
  });
});

describe('forward-reference', () => {
  it('warns when a block reads a block that comes later', () => {
    const [d] = withCode(check([shell('a', 'echo ${{ steps.b.stdout }}'), shell('b')]), 'forward-reference');
    expect(d).toMatchObject({ severity: 'warning', path: ['steps', 0, 'run'], stepId: 'a' });
    expect(d.message).toContain("'b'");
  });

  it('warns when a block reads a block of the other branch', () => {
    const steps: Step[] = [branch('check', 'true', [shell('t')], [shell('e', 'echo ${{ steps.t.stdout }}')])];
    const [d] = withCode(check(steps), 'forward-reference');
    expect(d.stepId).toBe('e');
    expect(d.message).toContain("other branch of 'check'");
    const [ahead] = withCode(
      check([branch('check', 'true', [shell('t', 'echo ${{ steps.e.stdout }}')], [shell('e')])]),
      'forward-reference',
    );
    expect(ahead.message).toContain("other branch of 'check'");
  });

  it('warns about the other branch of an if inside a loop too (it is marked skipped before a branch runs)', () => {
    const steps: Step[] = [
      loop('l', [
        branch(
          'failing',
          'true',
          [agent('fix', 'Fix')],
          [agent('review', 'Last fix: ${{ steps.fix.text }}')],
        ),
      ]),
    ];
    const [d] = withCode(check(steps), 'forward-reference');
    expect(d).toMatchObject({ severity: 'warning', path: ['steps', 0, 'steps', 0, 'else', 0, 'prompt'] });
    expect(d.message).toContain("other branch of 'failing'");
  });

  it('warns when an if condition reads blocks of its own branches', () => {
    expect(
      withCode(check([branch('check', '${{ steps.t.exitCode == 0 }}', [shell('t')])]), 'forward-reference'),
    ).toHaveLength(1);
  });

  it('warns when a block reads an enclosing if', () => {
    expect(
      withCode(
        check([branch('check', 'true', [shell('t', 'echo ${{ steps.check.branch }}')])]),
        'forward-reference',
      ),
    ).toHaveLength(1);
  });

  it('checks references in agent context files', () => {
    const steps: Step[] = [agent('a', 'Hi', { context: { files: ['${{ steps.b.stdout }}'] } }), shell('b')];
    const [d] = withCode(check(steps), 'forward-reference');
    expect(d).toMatchObject({ path: ['steps', 0, 'context', 'files', 0], stepId: 'a' });
    expect(d.message).toContain('context.files[0]');
  });

  it('warns when a block in a loop reads a block after the loop', () => {
    const steps: Step[] = [loop('l', [shell('a', 'echo ${{ steps.after.stdout }}')]), shell('after')];
    expect(withCode(check(steps), 'forward-reference')).toHaveLength(1);
  });

  it('accepts later blocks of the enclosing loop body (latest iteration)', () => {
    const steps: Step[] = [
      loop('outer', [
        shell('a', 'echo ${{ steps.b.stdout }}'),
        loop('inner', [shell('deep', 'echo ${{ steps.after.stdout }} ${{ steps.b.stdout }}')]),
        shell('b'),
        shell('after'),
      ]),
    ];
    expect(withCode(check(steps), 'forward-reference')).toEqual([]);
  });

  it('accepts a loop condition reading its body, and blocks after containers reading their children', () => {
    const steps: Step[] = [
      loop('l', [shell('t')], { while: '${{ steps.t.exitCode != 0 }}' }),
      branch('c', 'true', [shell('x')], [shell('y')]),
      shell(
        'after',
        'echo ${{ steps.t.stdout }} ${{ steps.x.stdout }} ${{ steps.y.stdout }} ${{ steps.l.iterations }}',
      ),
    ];
    expect(withCode(check(steps), 'forward-reference')).toEqual([]);
  });
});

describe('self-reference', () => {
  it('reports a block reading its own outputs outside of a loop', () => {
    const [d] = withCode(check([shell('a', 'echo ${{ steps.a.stdout }}')]), 'self-reference');
    expect(d).toMatchObject({ severity: 'error', path: ['steps', 0, 'run'], stepId: 'a' });
    expect(codes(check([shell('a', 'echo ${{ steps.a.stdout }}')]))).not.toContain('forward-reference');
  });

  it('reports a loop condition reading the loop’s own outputs', () => {
    const steps: Step[] = [loop('l', [shell('t')], { until: '${{ steps.l.iterations > 2 }}' })];
    expect(withCode(check(steps), 'self-reference')).toHaveLength(1);
  });

  it('accepts a block reading its previous iteration inside a loop', () => {
    const steps: Step[] = [loop('l', [agent('a', 'Last time: ${{ steps.a.text }}')])];
    expect(withCode(check(steps), 'self-reference')).toEqual([]);
  });
});

describe('unknown-input', () => {
  it('reports inputs that are not declared', () => {
    const [d] = withCode(
      check([agent('a', '${{ inputs.nope }}')], undefined, { inputs: { task: {} } }),
      'unknown-input',
    );
    expect(d).toMatchObject({ severity: 'error', path: ['steps', 0, 'prompt'], stepId: 'a' });
    expect(d.message).toContain('nope');
    expect(withCode(check([agent('a', '${{ inputs.task }}')]), 'unknown-input')).toHaveLength(1);
  });

  it('accepts declared inputs', () => {
    expect(
      withCode(
        check([agent('a', '${{ inputs.task }}')], undefined, { inputs: { task: {} } }),
        'unknown-input',
      ),
    ).toEqual([]);
  });
});

describe('unknown-secret', () => {
  it('warns about secrets that are not stored', () => {
    const [d] = withCode(
      check([shell('a', 'deploy ${{ secrets.OTHER }}')], { secretNames: ['TOKEN'] }),
      'unknown-secret',
    );
    expect(d).toMatchObject({ severity: 'warning', path: ['steps', 0, 'run'], stepId: 'a' });
    expect(d.message).toContain('OTHER');
  });

  it('accepts known secrets and skips the check without secretNames', () => {
    expect(
      withCode(check([shell('a', '${{ secrets.TOKEN }}')], { secretNames: ['TOKEN'] }), 'unknown-secret'),
    ).toEqual([]);
    expect(withCode(check([shell('a', '${{ secrets.OTHER }}')]), 'unknown-secret')).toEqual([]);
  });
});

describe('unknown-root', () => {
  it('warns about unknown names and suggests steps.<id> for block ids', () => {
    const diagnostics = withCode(
      check([shell('tests'), agent('a', '${{ tests.exitCode }} ${{ foo }}')]),
      'unknown-root',
    );
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[0]).toMatchObject({ severity: 'warning', path: ['steps', 1, 'prompt'], stepId: 'a' });
    expect(diagnostics[0].message).toContain('steps.tests.exitCode');
    expect(diagnostics[1].message).toContain("'foo'");
  });

  it('accepts all known roots', () => {
    const run =
      '${{ env.CI }} ${{ workflow.name }} ${{ workflow.file }} ${{ workspace.root }} ${{ run.id }} ${{ secrets.X }}';
    expect(withCode(check([shell('a', run)]), 'unknown-root')).toEqual([]);
  });
});

describe('loop-variable-outside-loop', () => {
  it('reports loop variables outside loops', () => {
    const [d] = withCode(check([agent('a', 'Try ${{ loop.iteration }}')]), 'loop-variable-outside-loop');
    expect(d).toMatchObject({ severity: 'error', path: ['steps', 0, 'prompt'], stepId: 'a' });
    const [cond] = withCode(
      check([branch('c', '${{ loop.index > 0 }}', [shell('a')]), loop('l', [shell('b')])]),
      'loop-variable-outside-loop',
    );
    expect(cond).toMatchObject({ path: ['steps', 0, 'condition'], stepId: 'c' });
  });

  it('accepts loop variables inside loops and in a loop’s own condition', () => {
    const steps: Step[] = [
      loop('l', [branch('c', '${{ loop.index > 0 }}', [agent('a', 'Try ${{ loop.iteration }}')])], {
        until: '${{ loop.iteration >= 2 }}',
      }),
    ];
    expect(withCode(check(steps), 'loop-variable-outside-loop')).toEqual([]);
  });
});

describe('empty-loop and empty-if', () => {
  it('warns about a loop without blocks', () => {
    const [d] = withCode(check([loop('l', [])]), 'empty-loop');
    expect(d).toMatchObject({ severity: 'warning', path: ['steps', 0, 'steps'], stepId: 'l' });
    expect(withCode(check([loop('l', [shell('a')])]), 'empty-loop')).toEqual([]);
  });

  it('warns about an if without blocks in both branches', () => {
    const [d] = withCode(check([branch('c', 'true', [], [])]), 'empty-if');
    expect(d).toMatchObject({ severity: 'warning', path: ['steps', 0], stepId: 'c' });
    expect(withCode(check([branch('c', 'true', [])]), 'empty-if')).toHaveLength(1);
  });

  it('accepts an if with blocks in one branch', () => {
    expect(withCode(check([branch('c', 'true', [shell('a')], [])]), 'empty-if')).toEqual([]);
    expect(withCode(check([branch('c', 'true', [], [shell('a')])]), 'empty-if')).toEqual([]);
  });
});

describe('missing-condition-value', () => {
  it('warns about comparisons without a value', () => {
    const steps: Step[] = [
      loop('l', [shell('t')], { until: { value: '', op: 'isEmpty' } }),
      branch(
        'c',
        {
          all: [
            { value: '${{ steps.t.stdout }}', op: 'isTrue' },
            { value: ' ', op: 'eq', to: 1 },
          ],
        },
        [shell('x')],
      ),
    ];
    const diagnostics = withCode(check(steps), 'missing-condition-value');
    expect(diagnostics.map((d) => d.path)).toEqual([
      ['steps', 0, 'until', 'value'],
      ['steps', 1, 'condition', 'all', 1, 'value'],
    ]);
    expect(diagnostics[0]).toMatchObject({ severity: 'warning', stepId: 'l' });
  });

  it('warns about comparisons that have no value key at all', () => {
    const [d] = withCode(
      check([branch('c', { op: 'isTrue' } as unknown as Condition, [shell('x')])]),
      'missing-condition-value',
    );
    expect(d).toMatchObject({ severity: 'warning', path: ['steps', 0, 'condition'], stepId: 'c' });
  });

  it('accepts comparisons with a value', () => {
    expect(
      withCode(check([branch('c', { value: 0, op: 'eq', to: 0 }, [shell('x')])]), 'missing-condition-value'),
    ).toEqual([]);
  });
});

describe('json-field-without-json-output', () => {
  it('warns when json is read from an agent without JSON output', () => {
    const [d] = withCode(
      check([agent('r'), shell('t', 'echo ${{ steps.r.json.approved }}')]),
      'json-field-without-json-output',
    );
    expect(d).toMatchObject({ severity: 'warning', path: ['steps', 1, 'run'], stepId: 't' });
    expect(d.message).toContain("'r'");
  });

  it('accepts json of JSON agents and text of text agents', () => {
    const steps: Step[] = [
      agent('r', 'Review', { output: { format: 'json' } }),
      agent('p'),
      shell('t', 'echo ${{ steps.r.json.approved }} ${{ steps.p.text }}'),
    ];
    expect(withCode(check(steps), 'json-field-without-json-output')).toEqual([]);
  });
});

describe('setup commands', () => {
  const steps = [shell('tests')];

  it('warns about setup without isolation: worktree, pointing at setup', () => {
    for (const isolation of [undefined, 'workspace'] as const) {
      const diagnostics = check(steps, undefined, { setup: ['npm ci'], ...(isolation && { isolation }) });
      expect(withCode(diagnostics, 'setup-without-worktree')).toEqual([
        {
          severity: 'warning',
          code: 'setup-without-worktree',
          path: ['setup'],
          message:
            'Setup commands only run with isolation: worktree. Set isolation to worktree or remove setup.',
        },
      ]);
    }
  });

  it('accepts setup with isolation: worktree and workflows without setup', () => {
    expect(check(steps, undefined, { isolation: 'worktree', setup: ['npm ci'] })).toEqual([]);
    expect(check(steps, undefined, { isolation: 'worktree' })).toEqual([]);
    expect(check(steps, undefined, { setup: [] })).toEqual([]);
  });

  it('warns about templates in setup commands, which are not filled in', () => {
    const diagnostics = check(steps, undefined, {
      isolation: 'worktree',
      setup: ['npm ci', 'npm run build -- ${{ inputs.target }}', 'echo ${{'],
    });
    expect(withCode(diagnostics, 'setup-template')).toEqual([
      expect.objectContaining({ severity: 'warning', path: ['setup', 1] }),
      expect.objectContaining({ severity: 'warning', path: ['setup', 2] }),
    ]);
    expect(withCode(diagnostics, 'setup-template')[0].message).toBe(
      'Setup commands run as written; ${{ }} templates are not filled in.',
    );
    // Setup commands are not rendered, so their templates are not checked as expressions.
    expect(codes(diagnostics)).toEqual(['setup-template', 'setup-template']);
  });

  it('ignores setup entries that are not text', () => {
    const wf = { ...workflow(steps), isolation: 'worktree', setup: [7, null] } as unknown as Workflow;
    expect(validateWorkflow(wf)).toEqual([]);
    const notList = { ...workflow(steps), isolation: 'worktree', setup: 'npm ci' } as unknown as Workflow;
    expect(validateWorkflow(notList)).toEqual([]);
  });
});

describe('robustness', () => {
  it('does not throw on lenient models of invalid documents', () => {
    const broken = {
      version: 1,
      name: 'Broken',
      inputs: 'nope',
      env: { A: 3 },
      steps: [
        null,
        'text',
        { type: 'loop', steps: 'nope', until: 42 },
        { id: 'a', type: 'if', condition: { all: 'x' }, then: null },
        { type: 'agent', prompt: 7, agent: 5, output: 'json' },
        { id: 'c', type: 'console', run: '${{ steps.a.branch }}', env: 'x' },
        { id: 'd', type: 'weird', run: '${{ nope( }}' },
      ],
    } as unknown as Workflow;
    expect(() =>
      validateWorkflow(broken, { agentIds: [], modelRefs: ['a/b'], secretNames: [] }),
    ).not.toThrow();
    expect(() => validateWorkflow({ version: 1, name: 'Empty' } as unknown as Workflow)).not.toThrow();
  });

  it('reports each problem once per field', () => {
    const diagnostics = check([agent('a', '${{ steps.nope.text }} and ${{ steps.nope.json }}')]);
    expect(withCode(diagnostics, 'unknown-step-reference')).toHaveLength(1);
  });
});
