/** Realistic sample data for the harness, component tests and screenshots. */
import type { AgentSummary, ChatModelInfo, ModelCatalog, RunRecordSummary, WorkflowSummary } from '@isar-flow/core';

const NOW = Date.UTC(2026, 9, 26, 9, 30);
export const FIXTURE_NOW = NOW;

function model(provider: string, providerLabel: string, id: string, name = id): ChatModelInfo {
  return {
    ref: `${provider}/${id}`,
    provider,
    providerLabel,
    id,
    name,
    capabilities: { tools: true, jsonSchema: provider !== 'vscode' },
  };
}

export const MODELS: ChatModelInfo[] = [
  model('vscode', 'VS Code', 'copilot/gpt-4.1', 'GPT-4.1'),
  model('vscode', 'VS Code', 'copilot/claude-sonnet-4.5', 'Claude Sonnet 4.5'),
  model('vscode', 'VS Code', 'copilot/gemini-2.5-pro', 'Gemini 2.5 Pro'),
  model('vscode', 'VS Code', 'copilot/gpt-5-mini', 'GPT-5 mini'),
  model('litellm', 'LiteLLM (localhost:4000)', 'claude-sonnet'),
  model('litellm', 'LiteLLM (localhost:4000)', 'claude-haiku'),
  model('litellm', 'LiteLLM (localhost:4000)', 'gpt-4.1'),
  model('litellm', 'LiteLLM (localhost:4000)', 'llama-3.3-70b'),
  model('litellm', 'LiteLLM (localhost:4000)', 'qwen-coder-32b'),
];

export const CATALOG: ModelCatalog = {
  loading: false,
  models: MODELS,
  providers: [
    { id: 'vscode', label: 'VS Code', kind: 'vscode', hasApiKey: false, status: 'ok', modelCount: 4 },
    {
      id: 'litellm',
      label: 'LiteLLM (localhost:4000)',
      kind: 'openai-compatible',
      baseUrl: 'http://localhost:4000',
      hasApiKey: true,
      status: 'ok',
      modelCount: 5,
    },
    {
      id: 'ollama',
      label: 'Ollama',
      kind: 'openai-compatible',
      baseUrl: 'http://localhost:11434/v1',
      hasApiKey: false,
      status: 'error',
      error: 'Cannot reach http://localhost:11434/v1. Is the server running?',
      modelCount: 0,
    },
  ],
};

export const AGENTS: AgentSummary[] = [
  {
    id: 'coder',
    name: 'Coder',
    description: 'Implements changes and fixes review findings',
    model: 'litellm/claude-sonnet',
    tools: ['readFile', 'listFiles', 'searchText', 'gitDiff', 'editFile', 'writeFile', 'runCommand'],
    scope: 'workspace',
    uri: 'file:///c%3A/work/shop/.isarflow/agents/coder.agent.yaml',
    valid: true,
  },
  {
    id: 'reviewer',
    name: 'Reviewer',
    description: 'Strict senior code reviewer',
    model: 'vscode/copilot/gpt-4.1',
    tools: ['readFile', 'listFiles', 'searchText', 'gitDiff'],
    scope: 'workspace',
    uri: 'file:///c%3A/work/shop/.isarflow/agents/reviewer.agent.yaml',
    valid: true,
  },
  {
    id: 'docs-writer',
    name: 'Docs writer',
    description: 'Keeps the README and changelog current',
    model: 'litellm/llama-3.3-70b',
    tools: ['readFile', 'writeFile'],
    scope: 'user',
    uri: 'file:///c%3A/Users/me/AppData/Roaming/Code/User/globalStorage/isarflow.isar-flow/agents/docs-writer.agent.yaml',
    valid: true,
  },
];

export const RECENT_RUNS: RunRecordSummary[] = [
  {
    runId: 'run-7',
    workflowUri: 'file:///c%3A/work/shop/.isarflow/workflows/review-loop.workflow.yaml',
    workflowName: 'Review until approved',
    status: 'success',
    startedAt: NOW - 4 * 60_000,
    durationMs: 252_000,
    usage: { inputTokens: 48_210, outputTokens: 6_930 },
  },
  {
    runId: 'run-6',
    workflowUri: 'file:///c%3A/work/shop/.isarflow/workflows/test-fix.workflow.yaml',
    workflowName: 'Fix failing tests',
    status: 'failure',
    startedAt: NOW - 3 * 3_600_000,
    durationMs: 611_000,
    error: "Loop 'fix_loop' reached its limit of 5 iterations without meeting its condition",
  },
  {
    runId: 'run-5',
    workflowUri: 'file:///c%3A/work/shop/.isarflow/workflows/review-loop.workflow.yaml',
    workflowName: 'Review until approved',
    status: 'cancelled',
    startedAt: NOW - 26 * 3_600_000,
    durationMs: 48_000,
  },
];

export const WORKFLOWS: WorkflowSummary[] = [
  {
    uri: 'file:///c%3A/work/shop/.isarflow/workflows/review-loop.workflow.yaml',
    name: 'Review until approved',
    description: 'Implement a task, then test and review until the reviewer approves.',
    relativePath: '.isarflow/workflows/review-loop.workflow.yaml',
    valid: true,
    stepCount: 6,
    lastRun: RECENT_RUNS[0],
  },
  {
    uri: 'file:///c%3A/work/shop/.isarflow/workflows/test-fix.workflow.yaml',
    name: 'Fix failing tests',
    relativePath: '.isarflow/workflows/test-fix.workflow.yaml',
    valid: true,
    stepCount: 4,
    lastRun: RECENT_RUNS[1],
  },
  {
    uri: 'file:///c%3A/work/shop/tools/release-notes.workflow.yaml',
    name: 'Draft release notes',
    relativePath: 'tools/release-notes.workflow.yaml',
    valid: false,
    stepCount: 2,
  },
];

export const REVIEWER_AGENT_TEXT = `# Reviews changes and answers with JSON so workflows can branch on it.
name: Reviewer
description: Strict senior code reviewer
model: vscode/copilot/gpt-4.1
fallbackModels:
  - litellm/claude-sonnet
systemPrompt: |
  You are a strict senior reviewer. Check correctness, tests, naming and edge cases.
  Answer with JSON: { "approved": boolean, "issues": string[] }.
  Only approve when there is nothing left to fix.
temperature: 0.2
maxTokens: 4000
maxTurns: 20
tools: [readFile, listFiles, searchText, gitDiff]
permissions:
  edits: none
  commands: none
`;
