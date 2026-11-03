import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AgentSummary, RunRecordSummary, SetupReport } from '@isar-flow/core';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeState, postedOfType, renderSidebar, resetPosted, sendState } from './helpers';

beforeAll(() => {
  Element.prototype.scrollIntoView ??= () => undefined;
});
beforeEach(resetPosted);

function agent(overrides: Partial<AgentSummary>): AgentSummary {
  return {
    id: 'a',
    name: 'A',
    model: 'litellm/claude-sonnet',
    tools: [],
    scope: 'workspace',
    uri: `file:///w/${overrides.id ?? 'a'}.agent.yaml`,
    valid: true,
    ...overrides,
  };
}

const AGENTS: AgentSummary[] = [
  agent({
    id: 'coder',
    name: 'Coder',
    tools: ['readFile', 'editFile', 'applyPatch', 'runCommand'],
    permissions: { edits: 'auto', commands: 'ask' },
  }),
  agent({ id: 'reviewer', name: 'Reviewer', tools: ['readFile', 'gitDiff'], permissions: { edits: 'none' } }),
  agent({ id: 'writer', name: 'Writer', tools: ['writeFile'], scope: 'user', shadowed: true }),
  agent({ id: 'locked', name: 'Locked', tools: ['editFile'], permissions: { edits: 'none' } }),
];

const row = (name: RegExp) => screen.getByRole('button', { name });

describe('agent capability badges', () => {
  it('replaces the old reach chips with badges that name the permission level', () => {
    renderSidebar({ agents: AGENTS });
    const coder = row(/^Coder/);
    expect(coder).toHaveTextContent('4 tools');
    expect(within(coder).getByText('Edits files (auto)')).toBeInTheDocument();
    expect(within(coder).getByText('Runs commands (asks)')).toBeInTheDocument();
    expect(within(row(/^Reviewer/)).getByText('Read-only')).toBeInTheDocument();
    const writer = row(/^Writer/);
    expect(within(writer).getByText('Edits files (asks)')).toBeInTheDocument();
    expect(writer).toHaveTextContent('User');
    expect(writer).toHaveTextContent('Hidden');
    // Edit tools whose permission is "none" do not count.
    expect(within(row(/^Locked/)).getByText('Read-only')).toBeInTheDocument();
  });
});

describe('New agent card hints', () => {
  it('explains the Blank starter and recommends Coder for agents that change code', async () => {
    const user = userEvent.setup();
    renderSidebar({ agents: AGENTS.filter((a) => a.id !== 'coder') });
    await user.click(screen.getByRole('button', { name: 'New agent' }));
    expect(
      screen.getByText(
        'Read-only: it can look at files but not change them. Turn on Edit files to let it change code.',
      ),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole('button', { name: 'For an agent that should change code, pick Coder.' }),
    );
    expect(screen.getByRole('radio', { name: 'Coder' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Coder' })).toHaveFocus();
    expect(screen.getByLabelText('Name')).toHaveValue('Coder');
    expect(screen.queryByRole('button', { name: /pick Coder/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Create agent' }));
    expect(postedOfType('createAgent')).toEqual([
      { type: 'createAgent', name: 'Coder', scope: 'workspace', starter: 'coder' },
    ]);
  });
});

describe('Models section controls', () => {
  it('starts the setup check', async () => {
    const user = userEvent.setup();
    renderSidebar({ agents: AGENTS });
    await user.click(screen.getByRole('button', { name: 'Check setup' }));
    expect(postedOfType('checkSetup')).toEqual([{ type: 'checkSetup' }]);
  });

  it('tests the models of a provider from its row', async () => {
    const user = userEvent.setup();
    renderSidebar({ agents: AGENTS });
    await user.click(screen.getByRole('button', { name: 'Test models of LiteLLM (localhost:4000)' }));
    await user.click(screen.getByRole('button', { name: 'Test models of VS Code' }));
    expect(postedOfType('testModel')).toEqual([
      { type: 'testModel', providerId: 'litellm' },
      { type: 'testModel', providerId: 'vscode' },
    ]);
  });
});

const REPORT: SetupReport = {
  startedAt: 1000,
  finishedAt: 9000,
  items: [
    { id: 'endpoint:vscode', kind: 'endpoint', label: 'VS Code', status: 'ok', message: '4 models' },
    {
      id: 'endpoint:ollama',
      kind: 'endpoint',
      label: 'Ollama',
      status: 'error',
      message: "Can't reach Ollama.",
      fix: { label: 'Edit endpoint', message: { type: 'editProvider', providerId: 'ollama' } },
    },
    {
      id: 'model:litellm/llama',
      kind: 'model',
      label: 'litellm/llama',
      status: 'warning',
      message: 'Needs text tool mode. In writer, set Tool calls to Text in the prompt.',
      usedBy: ['writer', '.isarflow/workflows/review-loop.workflow.yaml'],
      fix: { label: 'Open settings', message: { type: 'openSettings', query: 'isarFlow.modelPrices' } },
    },
    {
      id: 'model:none',
      kind: 'model',
      label: 'No models',
      status: 'skipped',
      message: 'No workflow uses a model yet.',
    },
  ],
};

describe('Setup check card', () => {
  it('lists the results with status, fixes and who uses a model', async () => {
    const user = userEvent.setup();
    renderSidebar({ agents: AGENTS, setupCheck: REPORT });
    const card = screen.getByRole('region', { name: 'Setup check' });
    expect(within(card).getByText('2 problems')).toBeInTheDocument();
    const list = within(card).getByRole('list', { name: 'Setup check results' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(4);
    expect(within(items[0]).getByRole('img', { name: 'OK' })).toBeInTheDocument();
    expect(within(items[1]).getByRole('img', { name: 'Error' })).toBeInTheDocument();
    expect(within(items[2]).getByRole('img', { name: 'Warning' })).toBeInTheDocument();
    expect(within(items[3]).getByRole('img', { name: 'Skipped' })).toBeInTheDocument();
    expect(within(items[2]).getByText('litellm/llama').tagName).toBe('CODE');
    expect(within(items[0]).getByText('VS Code').tagName).not.toBe('CODE');
    expect(items[2]).toHaveTextContent('Used by writer, .isarflow/workflows/review-loop.workflow.yaml');
    // Agent ids and workflow paths are code.
    expect(within(items[2]).getByText('writer').tagName).toBe('CODE');
    expect(within(items[2]).getByText('.isarflow/workflows/review-loop.workflow.yaml').tagName).toBe('CODE');

    await user.click(within(items[1]).getByRole('button', { name: 'Edit endpoint' }));
    await user.click(within(items[2]).getByRole('button', { name: 'Open settings' }));
    expect(postedOfType('editProvider')).toEqual([{ type: 'editProvider', providerId: 'ollama' }]);
    expect(postedOfType('openSettings')).toEqual([{ type: 'openSettings', query: 'isarFlow.modelPrices' }]);

    await user.click(within(card).getByRole('button', { name: 'Run again' }));
    expect(postedOfType('checkSetup')).toHaveLength(1);
    await user.click(within(card).getByRole('button', { name: 'Close setup check' }));
    expect(postedOfType('dismissSetupCheck')).toEqual([{ type: 'dismissSetupCheck' }]);
  });

  it('says when everything works', () => {
    renderSidebar({
      agents: AGENTS,
      setupCheck: { ...REPORT, items: [REPORT.items[0]] },
    });
    expect(
      within(screen.getByRole('region', { name: 'Setup check' })).getByText('Everything works'),
    ).toBeInTheDocument();
  });

  it('shows the check while it runs, also before the first result', () => {
    renderSidebar({ agents: AGENTS, setupCheck: { startedAt: 1, items: [] } });
    const card = screen.getByRole('region', { name: 'Setup check' });
    expect(within(card).getByRole('status')).toHaveTextContent('Checking…');
    // Unavailable but still focusable, so the keyboard stays on it while the check runs.
    const again = within(card).getByRole('button', { name: 'Run again' });
    expect(again).toHaveAttribute('aria-disabled', 'true');
    expect(again).not.toHaveAttribute('disabled');
    expect(within(card).queryByRole('list')).toBeNull();

    sendState(
      makeState({
        agents: AGENTS,
        setupCheck: {
          startedAt: 1,
          items: [{ ...REPORT.items[2], status: 'running', message: 'Testing the model…', fix: undefined }],
        },
      }),
    );
    const item = within(screen.getByRole('list', { name: 'Setup check results' })).getByRole('listitem');
    expect(within(item).getByRole('img', { name: 'Checking' })).toBeInTheDocument();
    expect(item).toHaveTextContent('Testing the model…');
  });

  it('is shown on the workflows tab too and goes away when dismissed', () => {
    renderSidebar({ agents: AGENTS, tab: 'workflows', setupCheck: REPORT });
    expect(screen.getByRole('region', { name: 'Setup check' })).toBeInTheDocument();
    sendState(makeState({ agents: AGENTS, tab: 'workflows', setupCheck: null }));
    expect(screen.queryByRole('region', { name: 'Setup check' })).toBeNull();
  });

  it('ignores fixes without a message type', () => {
    renderSidebar({
      agents: AGENTS,
      setupCheck: {
        ...REPORT,
        items: [{ ...REPORT.items[1], fix: { label: 'Broken', message: null as never } }],
      },
    });
    expect(screen.queryByRole('button', { name: 'Broken' })).toBeNull();
  });
});

describe('Recent runs review counts', () => {
  it('shows how many changed files wait for a review', () => {
    const run = (id: string, review?: RunRecordSummary['review']): RunRecordSummary => ({
      runId: id,
      workflowUri: 'file:///w/a.workflow.yaml',
      workflowName: `Run ${id}`,
      status: 'success',
      startedAt: Date.now() - 60_000,
      durationMs: 1000,
      review,
    });
    renderSidebar({
      tab: 'workflows',
      recentRuns: [
        run('1', { total: 3, kept: 1, reverted: 0, pending: 2 }),
        run('2', { total: 2, kept: 2, reverted: 0, pending: 0 }),
      ],
    });
    const runs = screen.getByRole('list', { name: 'Recent runs' });
    expect(within(runs).getByRole('button', { name: /Run 1/ })).toHaveTextContent('2 to review');
    expect(within(runs).getByRole('button', { name: /Run 2/ })).not.toHaveTextContent('to review');
  });
});
