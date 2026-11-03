import { describe, expect, it } from 'vitest';
import {
  AgentDefinitionSchema,
  findStep,
  STEP_TYPES,
  stepChildren,
  walkSteps,
  WorkflowSchema,
  workflowJsonSchema,
  agentJsonSchema,
  type Workflow,
} from '../src/schema';

const fullExample = {
  version: 1,
  name: 'Implement & review until approved',
  inputs: { task: { type: 'string', description: 'What should be implemented?', required: true } },
  steps: [
    { id: 'implement', type: 'agent', agent: 'coder', prompt: 'Implement: ${{ inputs.task }}' },
    {
      id: 'review_loop',
      type: 'loop',
      until: {
        all: [
          { value: '${{ steps.tests.exitCode }}', op: 'eq', to: 0 },
          { value: '${{ steps.review.json.approved }}', op: 'eq', to: true },
        ],
      },
      maxIterations: 5,
      onMaxIterations: 'fail',
      steps: [
        { id: 'tests', type: 'console', run: 'npm test', shell: 'pwsh', timeout: 600, continueOnError: true },
        {
          id: 'review',
          type: 'agent',
          agent: 'reviewer',
          prompt: 'Review',
          output: { format: 'json', schema: { approved: 'boolean', issues: 'string[]' } },
        },
        {
          id: 'needs_fix',
          type: 'if',
          condition: '${{ !steps.review.json.approved }}',
          then: [{ id: 'fix', type: 'agent', agent: 'coder', prompt: 'Fix' }],
          else: [{ id: 'done', type: 'break' }],
        },
      ],
    },
    { id: 'ok', type: 'approval', message: 'Ship it?' },
    { id: 'end', type: 'stop', outcome: 'success' },
  ],
};

const issuesOf = (value: unknown) => {
  const result = WorkflowSchema.safeParse(value);
  return result.success ? [] : result.error.issues;
};

describe('WorkflowSchema', () => {
  it('accepts the full example', () => {
    expect(issuesOf(fullExample)).toEqual([]);
  });

  it('rejects a loop without maxIterations', () => {
    const wf = structuredClone(fullExample);
    delete (wf.steps[1] as Record<string, unknown>).maxIterations;
    const issues = issuesOf(wf);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].path).toEqual(['steps', 1, 'maxIterations']);
  });

  it.each([0, 101, 2.5])('rejects maxIterations %s', (value) => {
    const wf = structuredClone(fullExample);
    (wf.steps[1] as Record<string, unknown>).maxIterations = value;
    expect(issuesOf(wf).length).toBeGreaterThan(0);
  });

  it('rejects loops with both until and while', () => {
    const wf = structuredClone(fullExample);
    (wf.steps[1] as Record<string, unknown>).while = 'true';
    expect(issuesOf(wf).map((i) => i.message)).toContain('Use either "until" or "while", not both');
  });

  it('rejects invalid ids', () => {
    const wf = structuredClone(fullExample);
    wf.steps[0].id = '1st step';
    expect(issuesOf(wf)[0].path).toEqual(['steps', 0, 'id']);
  });

  it('rejects unknown keys to catch typos', () => {
    const wf = structuredClone(fullExample);
    (wf.steps[0] as Record<string, unknown>).promt = 'typo';
    expect(issuesOf(wf).length).toBeGreaterThan(0);
  });

  it('rejects unknown block types', () => {
    const wf = structuredClone(fullExample);
    (wf.steps[0] as Record<string, unknown>).type = 'teleport';
    expect(issuesOf(wf).length).toBeGreaterThan(0);
  });

  it('accepts inline agent settings', () => {
    const wf = structuredClone(fullExample);
    (wf.steps[0] as Record<string, unknown>).agent = {
      model: 'litellm/gpt-4.1',
      systemPrompt: 'Be brief',
      tools: ['readFile'],
      permissions: { edits: 'ask' },
    };
    expect(issuesOf(wf)).toEqual([]);
  });

  it('rejects malformed model references', () => {
    const wf = structuredClone(fullExample);
    (wf.steps[0] as Record<string, unknown>).model = 'gpt-4.1';
    expect(issuesOf(wf)[0].message).toMatch(/provider/);
  });
});

describe('AgentDefinitionSchema', () => {
  it('accepts a full agent', () => {
    const result = AgentDefinitionSchema.safeParse({
      name: 'Reviewer',
      model: 'vscode/copilot/gpt-4.1',
      fallbackModels: ['litellm/claude-sonnet'],
      systemPrompt: 'Strict',
      temperature: 0.2,
      maxTokens: 4000,
      maxTurns: 20,
      tools: ['readFile', 'gitDiff'],
      permissions: { edits: 'none', commands: 'ask' },
    });
    expect(result.success).toBe(true);
  });

  it('requires name and model', () => {
    expect(AgentDefinitionSchema.safeParse({ name: 'x' }).success).toBe(false);
    expect(AgentDefinitionSchema.safeParse({ model: 'a/b' }).success).toBe(false);
  });
});

describe('step helpers', () => {
  const wf = WorkflowSchema.parse(fullExample) as Workflow;

  it('lists step types', () => {
    expect(STEP_TYPES).toEqual(['agent', 'console', 'loop', 'if', 'break', 'stop', 'approval', 'ask']);
  });

  it('walks steps in document order with parents and slots', () => {
    const visited: string[] = [];
    walkSteps(wf.steps, (v) => {
      visited.push(`${v.step.id}@${v.parent?.id ?? 'root'}.${v.slot}[${v.index}]`);
    });
    expect(visited).toEqual([
      'implement@root.steps[0]',
      'review_loop@root.steps[1]',
      'tests@review_loop.steps[0]',
      'review@review_loop.steps[1]',
      'needs_fix@review_loop.steps[2]',
      'fix@needs_fix.then[0]',
      'done@needs_fix.else[0]',
      'ok@root.steps[2]',
      'end@root.steps[3]',
    ]);
  });

  it('finds steps with ancestors', () => {
    const found = findStep(wf.steps, 'fix');
    expect(found?.ancestors.map((s) => s.id)).toEqual(['review_loop', 'needs_fix']);
    expect(findStep(wf.steps, 'nope')).toBeUndefined();
  });

  it('returns children slots of containers', () => {
    expect(stepChildren(wf.steps[1]).map((c) => c.slot)).toEqual(['steps']);
    expect(stepChildren(wf.steps[0])).toEqual([]);
  });
});

describe('JSON schema generation', () => {
  it('produces a workflow schema with all block types', () => {
    const schema = JSON.stringify(workflowJsonSchema());
    for (const type of STEP_TYPES) expect(schema).toContain(`"const":"${type}"`);
    expect(schema).toContain('maxIterations');
  });

  it('produces an agent schema', () => {
    const schema = agentJsonSchema() as { required?: string[] };
    expect(schema.required).toEqual(expect.arrayContaining(['name', 'model']));
  });
});
