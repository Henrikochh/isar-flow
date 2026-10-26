import { describe, expect, it } from 'vitest';
import type { AgentSummary, ModelCatalog } from '@isar-flow/core';
import {
  buildAgentDocumentState,
  buildWorkflowDocumentState,
  validationContext,
} from '../../../src/editors/documentState';

const URI = 'file:///repo/.isarflow/workflows/review.workflow.yaml';
const CTX = { agentIds: ['coder'], modelRefs: ['vscode/copilot/gpt-4.1'] };

const lines = (...text: string[]) => `${text.join('\n')}\n`;

const VALID = lines(
  'version: 1',
  'name: Review',
  'steps:',
  '  - id: implement',
  '    type: agent',
  '    agent: coder',
  '    prompt: Do it',
  '  - id: tests',
  '    type: console',
  '    run: npm test',
);

describe('buildWorkflowDocumentState', () => {
  it('passes a valid workflow through without diagnostics', () => {
    const state = buildWorkflowDocumentState(VALID, URI, 'review.workflow.yaml', CTX);
    expect(state).toMatchObject({ uri: URI, fileName: 'review.workflow.yaml', text: VALID, valid: true });
    expect(state.workflow?.name).toBe('Review');
    expect(state.diagnostics).toEqual([]);
  });

  it('merges semantic errors, marks the document invalid and points at the offending key', () => {
    const text = VALID.replace('agent: coder', 'agent: nobody');
    const state = buildWorkflowDocumentState(text, URI, 'review.workflow.yaml', CTX);
    expect(state.valid).toBe(false);
    expect(state.workflow).not.toBeNull();
    const [unknown] = state.diagnostics;
    expect(unknown).toMatchObject({ code: 'unknown-agent', severity: 'error', stepId: 'implement' });
    // Line 5 is "    agent: nobody": the range covers the key and its value.
    expect(unknown.range).toEqual({ start: { line: 5, character: 4 }, end: { line: 5, character: 17 } });
  });

  it('follows nested keys inside a block', () => {
    const text = lines(
      'version: 1',
      'name: Loop',
      'steps:',
      '  - id: again',
      '    type: loop',
      '    maxIterations: 3',
      '    until:',
      '      any:',
      '        - "${{ steps.nope.text }}"',
      '    steps:',
      '      - id: inner',
      '        type: console',
      '        run: echo hi',
    );
    const state = buildWorkflowDocumentState(text, URI, 'loop.workflow.yaml', CTX);
    const reference = state.diagnostics.find((d) => d.code === 'unknown-step-reference');
    expect(reference?.stepId).toBe('again');
    expect(reference?.range?.start).toEqual({ line: 7, character: 6 });
  });

  it('uses the first line of the block when the key cannot be found', () => {
    const text = lines('version: 1', 'name: Flow', 'steps:', '  - { id: out, type: break }');
    const state = buildWorkflowDocumentState(text, URI, 'flow.workflow.yaml', CTX);
    const [diagnostic] = state.diagnostics;
    expect(diagnostic.code).toBe('break-outside-loop');
    expect(diagnostic.range).toEqual({ start: { line: 3, character: 4 }, end: { line: 3, character: 28 } });
  });

  it('locates workflow-level diagnostics by their top-level key', () => {
    const text = lines(
      'version: 1',
      'name: Env',
      'env:',
      '  TOKEN: ${{ steps.missing.text }}',
      'steps:',
      '  - id: tests',
      '    type: console',
      '    run: npm test',
      '    env:',
      '      TOKEN: x',
    );
    const state = buildWorkflowDocumentState(text, URI, 'env.workflow.yaml', CTX);
    const [diagnostic] = state.diagnostics;
    expect(diagnostic.stepId).toBeUndefined();
    expect(diagnostic.range?.start).toEqual({ line: 3, character: 2 });
  });

  it('keeps parse and schema diagnostics with their ranges', () => {
    const text = VALID.replace('run: npm test', 'run: 3');
    const state = buildWorkflowDocumentState(text, URI, 'review.workflow.yaml', CTX);
    expect(state.valid).toBe(false);
    const schema = state.diagnostics.find((d) => d.path?.join('.') === 'steps.1.run');
    expect(schema?.range?.start.line).toBe(9);
  });

  it('reports YAML syntax errors without a workflow', () => {
    const state = buildWorkflowDocumentState('version: 1\nname: [oops\n', URI, 'x.workflow.yaml', CTX);
    expect(state.workflow).toBeNull();
    expect(state.valid).toBe(false);
    expect(state.diagnostics[0]).toMatchObject({ code: 'yaml-syntax', severity: 'error' });
    expect(state.diagnostics[0].range).toBeDefined();
  });

  it('stays valid with warnings only', () => {
    const text = VALID.replace('    prompt: Do it', '    model: litellm/unknown\n    prompt: Do it');
    const state = buildWorkflowDocumentState(text, URI, 'review.workflow.yaml', CTX);
    expect(state.diagnostics.map((d) => d.code)).toEqual(['unknown-model']);
    expect(state.valid).toBe(true);
  });

  it('skips the model check when no model refs are known', () => {
    const text = VALID.replace('    prompt: Do it', '    model: litellm/unknown\n    prompt: Do it');
    const state = buildWorkflowDocumentState(text, URI, 'review.workflow.yaml', { ...CTX, modelRefs: [] });
    expect(state.diagnostics).toEqual([]);
  });

  it('handles CRLF line endings', () => {
    const text = VALID.replace('agent: coder', 'agent: nobody').replace(/\n/g, '\r\n');
    const state = buildWorkflowDocumentState(text, URI, 'review.workflow.yaml', CTX);
    expect(state.diagnostics[0].range).toEqual({
      start: { line: 5, character: 4 },
      end: { line: 5, character: 17 },
    });
  });
});

const AGENT_URI = 'file:///repo/.isarflow/agents/reviewer.agent.yaml';
const AGENT = lines(
  'name: Reviewer',
  'model: vscode/copilot/gpt-4.1',
  'fallbackModels: [litellm/backup]',
  'tools: [readFile]',
);

describe('buildAgentDocumentState', () => {
  it('describes a valid agent file', () => {
    const state = buildAgentDocumentState(AGENT, AGENT_URI, 'reviewer', 'workspace', 'reviewer.agent.yaml', [
      '.isarflow/workflows/review.workflow.yaml',
    ]);
    expect(state).toMatchObject({
      uri: AGENT_URI,
      id: 'reviewer',
      scope: 'workspace',
      fileName: 'reviewer.agent.yaml',
      text: AGENT,
      valid: true,
      diagnostics: [],
      usedBy: ['.isarflow/workflows/review.workflow.yaml'],
    });
    expect(state.agent?.name).toBe('Reviewer');
  });

  it('marks schema problems invalid but keeps the lenient agent', () => {
    const text = `${AGENT}temperature: hot\n`;
    const state = buildAgentDocumentState(text, AGENT_URI, 'reviewer', 'user', 'reviewer.agent.yaml', []);
    expect(state.valid).toBe(false);
    expect(state.agent?.name).toBe('Reviewer');
    expect(state.diagnostics[0].range?.start.line).toBe(4);
  });

  it('has no agent for unreadable YAML', () => {
    const state = buildAgentDocumentState(
      'name: [x\n',
      AGENT_URI,
      'reviewer',
      'user',
      'reviewer.agent.yaml',
      [],
    );
    expect(state.agent).toBeNull();
    expect(state.valid).toBe(false);
  });

  it('warns about unknown models when model refs are given', () => {
    const state = buildAgentDocumentState(
      AGENT,
      AGENT_URI,
      'reviewer',
      'workspace',
      'reviewer.agent.yaml',
      [],
      {
        modelRefs: ['vscode/copilot/gpt-4.1'],
      },
    );
    expect(state.valid).toBe(true);
    expect(state.diagnostics).toEqual([
      expect.objectContaining({
        code: 'unknown-model',
        severity: 'warning',
        path: ['fallbackModels', 0],
        range: { start: { line: 2, character: 0 }, end: { line: 2, character: 32 } },
      }),
    ]);
  });
});

describe('validationContext', () => {
  const agent = (id: string, scope: 'workspace' | 'user'): AgentSummary => ({
    id,
    name: id,
    model: 'a/b',
    tools: [],
    scope,
    uri: `file:///${scope}/${id}.agent.yaml`,
    valid: true,
  });
  const catalog = (loading: boolean): ModelCatalog => ({
    loading,
    providers: [],
    models: [
      {
        ref: 'vscode/copilot/gpt-4.1',
        provider: 'vscode',
        providerLabel: 'VS Code',
        id: 'copilot/gpt-4.1',
        name: 'GPT-4.1',
        capabilities: { tools: true, jsonSchema: false },
      },
    ],
  });

  it('lists every agent id once and the available model refs', () => {
    const ctx = validationContext([agent('coder', 'workspace'), agent('coder', 'user')], catalog(false));
    expect(ctx).toEqual({ agentIds: ['coder'], modelRefs: ['vscode/copilot/gpt-4.1'] });
  });

  it('skips the model check while models are still loading', () => {
    expect(validationContext([], catalog(true)).modelRefs).toEqual([]);
  });
});
