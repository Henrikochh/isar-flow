import { describe, expect, it } from 'vitest';
import {
  applyAgentUpdate,
  applyWorkflowOps,
  parseAgentText,
  parseWorkflowText,
  type WorkflowOp,
} from '../../src/yaml';

const lines = (...text: string[]) => `${text.join('\n')}\n`;

const base = lines(
  'version: 1',
  'name: Docs check',
  'description: Checks the docs.',
  'inputs:',
  '  strict: { type: boolean, default: false }',
  'steps:',
  '  - id: lint',
  '    type: console',
  '    run: npm run lint:docs',
);

function apply(text: string, ...ops: WorkflowOp[]): string {
  const result = applyWorkflowOps(text, ops);
  if (result.error) throw new Error(result.error);
  return result.text;
}

describe('workflow key order for on and expose', () => {
  it('parses on: as the string key "on" (YAML 1.2, not a boolean)', () => {
    const text = lines(
      'version: 1',
      'name: Docs check',
      'on:',
      '  save: { files: "docs/**" }',
      '  schedule: { every: 1h }',
      'steps: []',
    );
    const result = parseWorkflowText(text);
    expect(result.valid).toBe(true);
    expect(result.workflow?.on).toEqual({ save: { files: 'docs/**' }, schedule: { every: '1h' } });
    expect(Object.keys(result.workflow ?? {})).toContain('on');
  });

  it('inserts on and expose after the description and before the inputs', () => {
    const out = apply(base, {
      op: 'updateWorkflow',
      set: { expose: true, on: { save: { files: ['docs/**', '!docs/gen/**'] }, schedule: { every: '1h' } } },
    });
    expect(out).toBe(
      lines(
        'version: 1',
        'name: Docs check',
        'description: Checks the docs.',
        'on:',
        '  save:',
        '    files: [docs/**, "!docs/gen/**"]',
        '  schedule:',
        '    every: 1h',
        'expose: true',
        'inputs:',
        '  strict: { type: boolean, default: false }',
        'steps:',
        '  - id: lint',
        '    type: console',
        '    run: npm run lint:docs',
      ),
    );
    const parsed = parseWorkflowText(out);
    expect(parsed.valid).toBe(true);
    expect(parsed.workflow?.on?.save?.files).toEqual(['docs/**', '!docs/gen/**']);
    expect(parsed.workflow?.expose).toBe(true);
  });

  it('places on before expose whatever order they are set in, and removes them again', () => {
    const withExpose = apply(base, { op: 'updateWorkflow', set: { expose: true } });
    const both = apply(withExpose, { op: 'updateWorkflow', set: { on: { change: { files: 'docs/**' } } } });
    expect(both).toContain(
      'description: Checks the docs.\non:\n  change:\n    files: docs/**\nexpose: true\ninputs:',
    );
    expect(apply(both, { op: 'updateWorkflow', set: {}, unset: ['on', 'expose'] })).toBe(base);
  });

  it('round-trips a workflow with on, expose, an ask block and an inline agent with memory unchanged', () => {
    const text = lines(
      'version: 1',
      'name: Release',
      'on:',
      '  change: { files: [CHANGELOG.md] }',
      'expose: true',
      'steps:',
      '  - id: target',
      '    type: ask',
      '    question: Where to?',
      '    choices: [ dev, prod ]',
      '    default: dev',
      '    timeout: 60',
      '  - id: notes',
      '    type: agent',
      '    agent: { model: litellm/x, memory: write }',
      '    prompt: Write notes for ${{ steps.target.answer }}',
    );
    expect(parseWorkflowText(text).valid).toBe(true);
    expect(apply(text, { op: 'updateWorkflow', set: { name: 'Release' } })).toBe(text);
    expect(apply(text, { op: 'updateStep', stepId: 'target', set: { timeout: 60 } })).toBe(text);
  });
});

describe('ask block key order', () => {
  it('writes question, choices and default after the type, with choices on one line', () => {
    const out = apply(base, {
      op: 'insertStep',
      target: { parentId: null, slot: 'steps', index: 1 },
      step: {
        timeout: 120,
        default: 'dev',
        choices: ['dev', 'prod'],
        question: 'Deploy to which environment?',
        type: 'ask',
        id: 'target',
      },
    });
    expect(out).toBe(
      base +
        lines(
          '  - id: target',
          '    type: ask',
          '    question: Deploy to which environment?',
          '    choices: [dev, prod]',
          '    default: dev',
          '    timeout: 120',
        ),
    );
    expect(parseWorkflowText(out).valid).toBe(true);
  });

  it('adds a default after the choices of an existing block', () => {
    const text = lines(
      'version: 1',
      'name: x',
      'steps:',
      '  - id: pick',
      '    type: ask',
      '    question: Which one?',
      '    choices: [ a, b ]',
      '    continueOnError: true',
    );
    const out = apply(text, { op: 'updateStep', stepId: 'pick', set: { default: 'b' } });
    expect(out).toBe(text.replace('    choices: [ a, b ]\n', '    choices: [ a, b ]\n    default: b\n'));
  });

  it('keeps long or multi-line choices as a block list', () => {
    const out = apply(base, {
      op: 'insertStep',
      target: { parentId: null, slot: 'steps', index: 1 },
      step: { id: 'pick', type: 'ask', question: 'Which?', choices: ['one\ntwo', 'three'] },
    });
    expect(out).toContain('    choices:\n      - |-\n        one\n        two\n      - three\n');
  });
});

describe('agent key order for memory', () => {
  const agent = lines(
    'name: Reviewer',
    'model: litellm/claude',
    'tools: [readFile]',
    'permissions: { edits: auto }',
  );

  it('inserts memory after permissions', () => {
    const result = applyAgentUpdate(agent, { memory: 'write', temperature: 0.2 });
    expect(result.text).toBe(
      `${agent.replace('model: litellm/claude\n', 'model: litellm/claude\ntemperature: 0.2\n')}memory: write\n`,
    );
    expect(parseAgentText(result.text).agent?.memory).toBe('write');
  });

  it('inserts memory after tools when there are no permissions', () => {
    const text = lines('name: Reviewer', 'model: litellm/claude', 'tools: [readFile]');
    expect(applyAgentUpdate(text, { memory: 'none' }).text).toBe(`${text}memory: none\n`);
  });

  it('orders memory in new inline agents too', () => {
    const out = apply(base, {
      op: 'insertStep',
      target: { parentId: null, slot: 'steps', index: 1 },
      step: {
        id: 'a',
        type: 'agent',
        prompt: 'Hi',
        agent: { memory: 'read', permissions: { edits: 'auto' }, model: 'm' },
      },
    });
    expect(out).toContain(
      '    agent:\n      model: m\n      permissions: { edits: auto }\n      memory: read\n',
    );
  });
});
