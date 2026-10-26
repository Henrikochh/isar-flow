import { describe, expect, it } from 'vitest';
import type { AgentStep, ConsoleStep, IfStep, LoopStep } from '../../src/schema';
import {
  defaultAgentText,
  newAgentText,
  newWorkflowText,
  parseAgentText,
  parseWorkflowText,
  workflowTemplate,
} from '../../src/yaml';

describe('newWorkflowText', () => {
  it.each(['My flow', 'Fix: "all" the #1 bugs', "it's done", 'yes', '123', '  padded  '])(
    'round-trips the name %j',
    (name) => {
      const result = parseWorkflowText(newWorkflowText(name));
      expect(result.valid).toBe(true);
      expect(result.workflow?.name).toBe(name.trim());
      expect(result.workflow?.steps).toEqual([]);
    },
  );

  it('starts with a short explanatory comment and an empty block list', () => {
    const text = newWorkflowText('Fresh');
    expect(text.startsWith('# ')).toBe(true);
    expect(text).toContain('version: 1\nname: Fresh\nsteps: []\n');
  });

  it('collapses line breaks in names', () => {
    expect(parseWorkflowText(newWorkflowText('two\nlines')).workflow?.name).toBe('two lines');
  });

  it('falls back to a default name when the name is blank', () => {
    expect(parseWorkflowText(newWorkflowText('  ')).workflow?.name).toBe('New workflow');
  });
});

describe('workflowTemplate', () => {
  it.each(['blank', 'review-loop', 'test-fix'] as const)(
    '%s parses as a valid workflow with the given name',
    (id) => {
      const text = workflowTemplate(id, 'Team flow');
      const result = parseWorkflowText(text);
      expect(result.diagnostics).toEqual([]);
      expect(result.valid).toBe(true);
      expect(result.workflow?.name).toBe('Team flow');
      expect(text.startsWith('# ')).toBe(true);
    },
  );

  it('uses newWorkflowText for the blank template', () => {
    expect(workflowTemplate('blank', 'X')).toBe(newWorkflowText('X'));
  });

  it('builds the review loop from the coder and reviewer agents', () => {
    const wf = parseWorkflowText(workflowTemplate('review-loop', 'Review')).workflow;
    expect(wf?.inputs?.task).toMatchObject({ type: 'string', required: true });
    const [implement, loop] = wf?.steps ?? [];
    expect(implement).toMatchObject({ id: 'implement', type: 'agent', agent: 'coder' });
    expect((implement as AgentStep).prompt).toContain('${{ inputs.task }}');
    const l = loop as LoopStep;
    expect(l).toMatchObject({ id: 'review_loop', type: 'loop', maxIterations: 5 });
    expect(l.until).toEqual({
      all: [
        { value: '${{ steps.tests.exitCode }}', op: 'eq', to: 0 },
        { value: '${{ steps.review.json.approved }}', op: 'isTrue' },
      ],
    });
    const [tests, review, fix] = l.steps;
    expect(tests).toMatchObject({ id: 'tests', type: 'console', continueOnError: true });
    expect(review).toMatchObject({
      id: 'review',
      type: 'agent',
      agent: 'reviewer',
      output: { format: 'json' },
    });
    expect((review as AgentStep).output?.schema).toEqual({ approved: 'boolean', issues: 'string[]' });
    expect(fix).toMatchObject({ id: 'needs_fix', type: 'if' });
    expect((fix as IfStep).then[0]).toMatchObject({ id: 'fix', type: 'agent', agent: 'coder' });
  });

  it('builds the test-fix loop around the test output', () => {
    const wf = parseWorkflowText(workflowTemplate('test-fix', 'Fix tests')).workflow;
    const loop = wf?.steps[0] as LoopStep;
    expect(loop).toMatchObject({
      type: 'loop',
      maxIterations: 5,
      until: { value: '${{ steps.tests.exitCode }}', op: 'eq', to: 0 },
    });
    const [tests, failing] = loop.steps;
    expect(tests).toMatchObject({
      id: 'tests',
      type: 'console',
      continueOnError: true,
    } satisfies Partial<ConsoleStep>);
    const branch = failing as IfStep;
    expect(branch.condition).toEqual({ value: '${{ steps.tests.exitCode }}', op: 'neq', to: 0 });
    expect(branch.then[0]).toMatchObject({ type: 'agent', agent: 'coder' });
    expect((branch.then[0] as AgentStep).prompt).toContain('${{ tail(steps.tests.output, 80) }}');
  });
});

describe('agent texts', () => {
  it('newAgentText produces a valid agent with the default model', () => {
    const text = newAgentText('Helper');
    const result = parseAgentText(text);
    expect(result.valid).toBe(true);
    expect(result.agent).toMatchObject({ name: 'Helper', model: 'vscode/copilot/gpt-4.1' });
    expect(text.startsWith('# ')).toBe(true);
  });

  it('newAgentText uses the given model', () => {
    expect(parseAgentText(newAgentText('A: b', 'ollama/llama3:8b')).agent).toMatchObject({
      name: 'A: b',
      model: 'ollama/llama3:8b',
    });
  });

  it('defaultAgentText builds a coder that may edit files and asks before commands', () => {
    const result = parseAgentText(defaultAgentText('coder', 'litellm/gpt-4.1'));
    expect(result.valid).toBe(true);
    expect(result.agent).toMatchObject({
      name: 'Coder',
      model: 'litellm/gpt-4.1',
      tools: ['readFile', 'listFiles', 'searchText', 'gitDiff', 'editFile', 'writeFile', 'runCommand'],
      permissions: { edits: 'auto', commands: 'ask' },
    });
  });

  it('defaultAgentText builds a read-only reviewer that answers in JSON', () => {
    const result = parseAgentText(defaultAgentText('reviewer', 'vscode/copilot/gpt-4.1'));
    expect(result.valid).toBe(true);
    expect(result.agent).toMatchObject({
      name: 'Reviewer',
      tools: ['readFile', 'listFiles', 'searchText', 'gitDiff'],
      permissions: { edits: 'none', commands: 'none' },
    });
    expect(result.agent?.systemPrompt).toMatch(/JSON/);
    expect(result.agent?.systemPrompt).toContain('"approved"');
    expect(result.agent?.systemPrompt).toContain('"issues"');
  });
});
