import { describe, expect, it } from 'vitest';
import { type AgentDefinition, type AgentSummary, parseWorkflowText } from '@isar-flow/core';
import { modelUsage, type UsageWorkflow } from '../../../src/models/modelUsage';

const summary = (id: string, overrides: Partial<AgentSummary> = {}): AgentSummary => ({
  id,
  name: id,
  model: '',
  tools: [],
  scope: 'workspace',
  uri: `file:///ws/.isarflow/agents/${id}.agent.yaml`,
  valid: true,
  ...overrides,
});

const DEFINITIONS: Record<string, AgentDefinition> = {
  coder: {
    name: 'Coder',
    model: 'litellm/gpt-4.1',
    fallbackModels: ['ollama/qwen3'],
    tools: ['readFile', 'editFile'],
  },
  reviewer: { name: 'Reviewer', model: 'ollama/llama3', tools: ['readFile'], toolMode: 'text' },
  writer: { name: 'Writer', model: 'ollama/llama3' },
};
const AGENTS = [summary('coder', { name: 'Coder' }), summary('reviewer'), summary('writer')];

function workflow(relativePath: string, yaml: string): UsageWorkflow {
  const parsed = parseWorkflowText(yaml);
  if (!parsed.workflow) throw new Error('fixture does not parse');
  return {
    uri: `file:///ws/${relativePath}`,
    name: parsed.workflow.name,
    relativePath,
    workflow: parsed.workflow,
  };
}

const REVIEW = workflow(
  '.isarflow/workflows/review.workflow.yaml',
  `version: 1
name: Review loop
steps:
  - id: fix
    type: agent
    agent: coder
    prompt: Fix it
  - id: loop
    type: loop
    maxIterations: 3
    steps:
      - id: review
        type: agent
        agent: reviewer
        prompt: Review it
      - id: quick
        type: agent
        agent: reviewer
        model: litellm/gpt-4.1-mini
        prompt: Again
`,
);

const INLINE = workflow(
  'inline.workflow.yaml',
  `version: 1
name: Inline
steps:
  - id: ask
    type: agent
    agent:
      model: ollama/llama3
      fallbackModels: ['\${{ inputs.model }}', '']
      tools: [readFile]
    prompt: Hi
  - id: shell
    type: console
    run: echo hi
  - id: missing
    type: agent
    agent: ghost
    model: litellm/gpt-4.1
    prompt: Hi
  - id: noTarget
    type: agent
    agent: ghost
    prompt: Hi
`,
);

describe('modelUsage', () => {
  it('lists every model of agent blocks with the workflows and agents that use it', () => {
    const uses = modelUsage([REVIEW], AGENTS, DEFINITIONS);
    expect(uses.map((u) => [u.ref, u.usedBy])).toEqual([
      ['litellm/gpt-4.1', ['.isarflow/workflows/review.workflow.yaml', 'coder']],
      ['litellm/gpt-4.1-mini', ['.isarflow/workflows/review.workflow.yaml', 'reviewer']],
      ['ollama/llama3', ['.isarflow/workflows/review.workflow.yaml', 'reviewer']],
      ['ollama/qwen3', ['.isarflow/workflows/review.workflow.yaml', 'coder']],
    ]);
  });

  it('knows which agents would need text tool mode', () => {
    const uses = modelUsage([REVIEW], AGENTS, DEFINITIONS);
    const coder = uses.find((u) => u.ref === 'litellm/gpt-4.1');
    expect(coder?.targets).toEqual([
      {
        name: 'Coder',
        usesTools: true,
        fix: {
          label: 'Open Coder',
          message: { type: 'openAgent', uri: 'file:///ws/.isarflow/agents/coder.agent.yaml' },
        },
      },
    ]);
    const llama = uses.find((u) => u.ref === 'ollama/llama3');
    expect(llama?.targets).toMatchObject([{ name: 'Reviewer', toolMode: 'text', usesTools: true }]);
  });

  it('reads inline agents and block models, and skips templates, empty refs and unknown agents', () => {
    const uses = modelUsage([INLINE, REVIEW], AGENTS, DEFINITIONS);
    const llama = uses.find((u) => u.ref === 'ollama/llama3');
    expect(llama?.usedBy).toEqual([
      '.isarflow/workflows/review.workflow.yaml',
      'inline.workflow.yaml',
      'reviewer',
    ]);
    expect(llama?.targets.map((t) => t.name)).toEqual(['block ask of inline.workflow.yaml', 'Reviewer']);
    expect(llama?.targets[0].fix).toEqual({
      label: 'Open Inline',
      message: { type: 'openWorkflow', uri: 'file:///ws/inline.workflow.yaml' },
    });
    const gpt = uses.find((u) => u.ref === 'litellm/gpt-4.1');
    expect(gpt?.usedBy).toEqual([
      '.isarflow/workflows/review.workflow.yaml',
      'inline.workflow.yaml',
      'coder',
      'ghost',
    ]);
    expect(uses.some((u) => u.ref.includes('${{'))).toBe(false);
    expect(uses.some((u) => u.ref === '')).toBe(false);
  });

  it('is empty without agent blocks', () => {
    expect(modelUsage([], AGENTS, DEFINITIONS)).toEqual([]);
  });
});
