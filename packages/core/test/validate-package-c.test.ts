import { describe, expect, it } from 'vitest';
import type { Diagnostic } from '../src/diagnostics';
import type { AskStep, Step, Workflow, WorkflowTriggers } from '../src/schema';
import { validateWorkflow } from '../src/validate';

const workflow = (steps: Step[], extra: Partial<Workflow> = {}): Workflow => ({
  version: 1,
  name: 'Test',
  ...extra,
  steps,
});
const shell = (id: string, run: string): Step => ({ id, type: 'console', run });
const ask = (extra: Partial<AskStep> = {}): AskStep => ({
  id: 'pick',
  type: 'ask',
  question: 'Where?',
  ...extra,
});
const withCode = (diagnostics: Diagnostic[], code: string) => diagnostics.filter((d) => d.code === code);
const onlyCodes = (diagnostics: Diagnostic[]) => diagnostics.map((d) => d.code);
const triggers = (on: WorkflowTriggers, extra: Partial<Workflow> = {}) =>
  validateWorkflow(workflow([shell('a', 'npm test')], { on, ...extra }));

describe('editor and git roots', () => {
  it('accepts every field of editor and git', () => {
    const run =
      '${{ editor.selection }} ${{ editor.file }} ${{ editor.language }} ${{ editor.line }} ${{ editor }} ' +
      '${{ git.branch }} ${{ git.changedFiles[0] }} ${{ length(git.diff) }} ${{ git }}';
    expect(validateWorkflow(workflow([shell('a', run)]))).toEqual([]);
    expect(validateWorkflow(workflow([], { env: { F: '${{ editor.file }}' } }))).toEqual([]);
  });

  it('lists editor and git among the known names', () => {
    const [d] = withCode(validateWorkflow(workflow([shell('a', '${{ foo }}')])), 'unknown-root');
    expect(d.message).toBe(
      "'foo' in run of 'a' is not a known name. Expressions can read inputs, steps, env, loop, workflow, workspace, " +
        'run, secrets, editor, git.',
    );
  });

  it('warns about fields editor and git do not have', () => {
    const steps: Step[] = [
      { id: 'x', type: 'agent', agent: 'coder', prompt: 'Explain ${{ editor.path }}' },
      shell('y', "${{ git['commit'] }}"),
    ];
    expect(withCode(validateWorkflow(workflow(steps)), 'unknown-root-field')).toEqual([
      {
        severity: 'warning',
        code: 'unknown-root-field',
        message: "editor.path in prompt of 'x' is not known. editor has selection, file, language and line.",
        path: ['steps', 0, 'prompt'],
        stepId: 'x',
      },
      {
        severity: 'warning',
        code: 'unknown-root-field',
        message: "git.commit in run of 'y' is not known. git has branch, changedFiles and diff.",
        path: ['steps', 1, 'run'],
        stepId: 'y',
      },
    ]);
  });

  it('checks the fields in conditions and workflow env too', () => {
    const steps: Step[] = [{ id: 'gate', type: 'if', condition: 'git.sha == ""', then: [shell('a', 'x')] }];
    const diagnostics = validateWorkflow(workflow(steps, { env: { L: '${{ editor.lines }}' } }));
    expect(withCode(diagnostics, 'unknown-root-field').map((d) => [d.message, d.path])).toEqual([
      [
        'editor.lines in env.L of the workflow is not known. editor has selection, file, language and line.',
        ['env', 'L'],
      ],
      [
        "git.sha in condition of 'gate' is not known. git has branch, changedFiles and diff.",
        ['steps', 0, 'condition'],
      ],
    ]);
  });
});

describe('ask blocks', () => {
  it('accepts a well-formed ask block', () => {
    const steps: Step[] = [
      shell('list', 'git branch'),
      ask({
        question: 'Deploy ${{ steps.list.output }}?',
        choices: ['dev', '${{ inputs.extra }}'],
        default: '${{ inputs.extra }}',
      }),
      shell('use', 'echo ${{ steps.pick.answer }} ${{ steps.pick.timedOut }}'),
    ];
    expect(validateWorkflow(workflow(steps, { inputs: { extra: { type: 'string' } } }))).toEqual([]);
    expect(validateWorkflow(workflow([ask({ choices: ['Dev', 'Prod'], default: 'prod' })]))).toEqual([]);
    expect(validateWorkflow(workflow([ask({ default: 'anything' })]))).toEqual([]);
  });

  it('checks templates in the question, the choices and the default', () => {
    const step = ask({
      question: '${{ steps.later.output }}',
      choices: ['a', '${{ inputs.nope }}'],
      default: '${{ bad( }}',
    });
    const diagnostics = validateWorkflow(workflow([step, shell('later', 'x')]));
    expect(diagnostics.map((d) => [d.code, d.path])).toEqual([
      ['forward-reference', ['steps', 0, 'question']],
      ['unknown-input', ['steps', 0, 'choices', 1]],
      ['expression-syntax', ['steps', 0, 'default']],
    ]);
    expect(withCode(diagnostics, 'unknown-input')[0].message).toBe(
      "inputs.nope in choices[1] of 'pick' is not a declared input. Add 'nope' under inputs or fix the name.",
    );
  });

  it('reports a literal default that is not one of the literal choices', () => {
    const diagnostics = validateWorkflow(workflow([ask({ choices: ['dev', 'prod'], default: 'staging' })]));
    expect(diagnostics).toEqual([
      {
        severity: 'error',
        code: 'ask-default-not-a-choice',
        message:
          "The default 'staging' of 'pick' isn't one of its choices: dev, prod. Add it to the choices or change the default.",
        path: ['steps', 0, 'default'],
        stepId: 'pick',
      },
    ]);
  });

  it('skips the default check when the default or a choice has a template, or the default is empty', () => {
    const cases: Partial<AskStep>[] = [
      { choices: ['dev', 'prod'], default: '${{ inputs.env }}' },
      { choices: ['dev', '${{ inputs.env }}'], default: 'staging' },
      { choices: ['dev', 'prod'], default: '  ' },
    ];
    for (const extra of cases) {
      const wf = workflow([ask(extra)], { inputs: { env: { type: 'string' } } });
      expect(withCode(validateWorkflow(wf), 'ask-default-not-a-choice')).toEqual([]);
    }
  });

  it('warns about duplicate literal choices', () => {
    const diagnostics = validateWorkflow(
      workflow([ask({ choices: ['dev', 'prod', ' dev', 'prod', 'Dev'] })]),
    );
    expect(withCode(diagnostics, 'ask-duplicate-choice')).toEqual([
      {
        severity: 'warning',
        code: 'ask-duplicate-choice',
        message: "Choice 'dev' of 'pick' is listed twice. Remove the duplicate.",
        path: ['steps', 0, 'choices', 2],
        stepId: 'pick',
      },
      {
        severity: 'warning',
        code: 'ask-duplicate-choice',
        message: "Choice 'prod' of 'pick' is listed twice. Remove the duplicate.",
        path: ['steps', 0, 'choices', 3],
        stepId: 'pick',
      },
    ]);
    const templated = workflow([ask({ choices: ['${{ inputs.a }}', '${{ inputs.a }}'] })], {
      inputs: { a: { type: 'string' } },
    });
    expect(withCode(validateWorkflow(templated), 'ask-duplicate-choice')).toEqual([]);
  });

  it('does not throw on malformed ask blocks', () => {
    const broken = workflow([
      { id: 'q', type: 'ask', question: 3, choices: 'a', default: 5 } as unknown as Step,
      { id: 'r', type: 'ask', choices: [1, null, 'x'], default: 'y' } as unknown as Step,
    ]);
    expect(() => validateWorkflow(broken)).not.toThrow();
  });
});

describe('triggers', () => {
  it('accepts well-formed triggers', () => {
    expect(
      triggers({
        save: { files: 'src/**/*.ts' },
        change: { files: ['docs/**', '!docs/gen/**', './notes.md'] },
        schedule: { every: '1m' },
      }),
    ).toEqual([]);
    expect(triggers({ schedule: { every: '1h30m' } })).toEqual([]);
  });

  it('reports schedules shorter than a minute', () => {
    expect(triggers({ schedule: { every: '30s' } })).toEqual([
      {
        severity: 'error',
        code: 'schedule-too-short',
        message: 'Schedules run at most once a minute. Use 1m or more.',
        path: ['on', 'schedule', 'every'],
      },
    ]);
    expect(onlyCodes(triggers({ schedule: { every: '59s' } }))).toEqual(['schedule-too-short']);
    expect(triggers({ schedule: { every: '60s' } })).toEqual([]);
    // Unreadable durations are reported by schema validation.
    expect(triggers({ schedule: { every: 'often' } })).toEqual([]);
  });

  it('reports patterns outside the workspace folder', () => {
    const files = [
      '/etc/**',
      'C:\\Users\\me\\**',
      'c:/repo/**',
      '../other/**',
      'src/../../x',
      '!../y/**',
      '\\\\server\\x',
    ];
    const diagnostics = triggers({ change: { files } });
    expect(diagnostics.map((d) => [d.code, d.severity, d.message, d.path])).toEqual([
      [
        'trigger-pattern-outside',
        'error',
        'File patterns are relative to the workspace folder. Remove the leading slash.',
        ['on', 'change', 'files', 0],
      ],
      [
        'trigger-pattern-outside',
        'error',
        'File patterns are relative to the workspace folder. Remove the drive letter.',
        ['on', 'change', 'files', 1],
      ],
      [
        'trigger-pattern-outside',
        'error',
        'File patterns are relative to the workspace folder. Remove the drive letter.',
        ['on', 'change', 'files', 2],
      ],
      [
        'trigger-pattern-outside',
        'error',
        "File patterns are relative to the workspace folder. Remove '..'.",
        ['on', 'change', 'files', 3],
      ],
      [
        'trigger-pattern-outside',
        'error',
        "File patterns are relative to the workspace folder. Remove '..'.",
        ['on', 'change', 'files', 4],
      ],
      [
        'trigger-pattern-outside',
        'error',
        "File patterns are relative to the workspace folder. Remove '..'.",
        ['on', 'change', 'files', 5],
      ],
      [
        'trigger-pattern-outside',
        'error',
        'File patterns are relative to the workspace folder. Remove the leading slash.',
        ['on', 'change', 'files', 6],
      ],
    ]);
    expect(triggers({ save: { files: '/src/**' } })[0]).toMatchObject({
      code: 'trigger-pattern-outside',
      path: ['on', 'save', 'files'],
    });
    expect(triggers({ save: { files: ['src/..foo/**', 'a..b'] } })).toEqual([]);
  });

  it('warns about pattern lists that only exclude', () => {
    expect(triggers({ save: { files: ['!dist/**', '!node_modules/**'] } })).toEqual([
      {
        severity: 'warning',
        code: 'trigger-only-exclusions',
        message: "Add a pattern to match, e.g. 'src/**'; patterns starting with ! only exclude.",
        path: ['on', 'save', 'files'],
      },
    ]);
    expect(onlyCodes(triggers({ change: { files: '!dist/**' } }))).toEqual(['trigger-only-exclusions']);
    expect(triggers({ change: { files: ['src/**', '!dist/**'] } })).toEqual([]);
  });

  it('warns about required inputs without default, which triggers cannot ask for', () => {
    const inputs = {
      task: { type: 'string' as const, required: true },
      level: { type: 'number' as const, required: true, default: 2 },
      note: { type: 'string' as const },
    };
    const diagnostics = triggers({ save: { files: 'src/**' } }, { inputs });
    expect(diagnostics).toEqual([
      {
        severity: 'warning',
        code: 'trigger-required-input',
        message: "Triggers can't ask for inputs. Give input 'task' a default or make it optional.",
        path: ['inputs', 'task'],
      },
    ]);
    expect(validateWorkflow(workflow([shell('a', '${{ inputs.task }}')], { inputs }))).toEqual([]);
    expect(triggers({}, { inputs })).toEqual([]);
    const emptyDefault = { task: { type: 'string' as const, required: true, default: '' } };
    expect(onlyCodes(triggers({ schedule: { every: '1h' } }, { inputs: emptyDefault }))).toEqual([
      'trigger-required-input',
    ]);
  });

  it('does not throw on malformed triggers', () => {
    for (const on of ['save', 3, ['save'], { save: 'x', change: { files: 3 }, schedule: { every: 15 } }]) {
      const wf = { ...workflow([]), on, inputs: { a: null } } as unknown as Workflow;
      expect(() => validateWorkflow(wf)).not.toThrow();
    }
  });
});

describe('expose', () => {
  it('suggests a description for workflows Copilot may run', () => {
    expect(validateWorkflow(workflow([], { expose: true }))).toEqual([
      {
        severity: 'info',
        code: 'expose-without-description',
        message: 'Add a description so Copilot knows when to use this workflow.',
        path: ['expose'],
      },
    ]);
    expect(onlyCodes(validateWorkflow(workflow([], { expose: true, description: '  ' })))).toEqual([
      'expose-without-description',
    ]);
  });

  it('accepts exposed workflows with a description and workflows that are not exposed', () => {
    expect(validateWorkflow(workflow([], { expose: true, description: 'Fixes lint errors.' }))).toEqual([]);
    expect(validateWorkflow(workflow([], { expose: false }))).toEqual([]);
    expect(validateWorkflow(workflow([]))).toEqual([]);
  });
});
