import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentSummary } from '@isar-flow/core';
import { AGENTS } from '../../harness/fixtures';
import { postedOfType, renderSidebar, resetPosted } from './helpers';

beforeEach(resetPosted);
afterEach(cleanup);

const agentRow = (name: RegExp) => screen.getByRole('button', { name });

describe('Agents tab', () => {
  it('opens the agent editor when a row is clicked', async () => {
    const user = userEvent.setup();
    renderSidebar();
    await user.click(agentRow(/^Coder/));
    expect(postedOfType('openAgent')).toEqual([{ type: 'openAgent', uri: AGENTS[0].uri }]);
  });

  it('shows the model, tool count, what the agent may do and the user scope', () => {
    renderSidebar();
    const coder = agentRow(/^Coder/);
    expect(coder).toHaveTextContent('litellm/claude-sonnet');
    expect(coder).toHaveTextContent('7 tools');
    expect(coder).toHaveTextContent('Edits files');
    expect(coder).toHaveTextContent('Runs commands');
    expect(coder).not.toHaveTextContent('User');

    const reviewer = agentRow(/^Reviewer/);
    expect(reviewer).toHaveTextContent('4 tools');
    expect(reviewer).not.toHaveTextContent('Edits files');

    expect(agentRow(/^Docs writer/)).toHaveTextContent('User');
  });

  it('deletes an agent only after the inline confirmation', async () => {
    const user = userEvent.setup();
    renderSidebar();
    await user.click(screen.getByRole('button', { name: 'Delete Docs writer' }));
    const confirm = screen.getByRole('group', { name: 'Delete Docs writer?' });
    expect(confirm).toHaveTextContent('docs-writer.agent.yaml');
    expect(within(confirm).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    expect(postedOfType('deleteAgent')).toEqual([]);

    await user.click(within(confirm).getByRole('button', { name: 'Delete agent' }));
    expect(postedOfType('deleteAgent')).toEqual([{ type: 'deleteAgent', uri: AGENTS[2].uri }]);
  });

  it('cancels the deletion with Escape and returns focus to the delete button', async () => {
    const user = userEvent.setup();
    renderSidebar();
    await user.click(screen.getByRole('button', { name: 'Delete Reviewer' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('group', { name: 'Delete Reviewer?' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete Reviewer' })).toHaveFocus();
    expect(postedOfType('deleteAgent')).toEqual([]);
  });

  it('shows the empty state, whose action opens the new agent card', async () => {
    const user = userEvent.setup();
    renderSidebar({ agents: [] });
    expect(screen.getByText('No agents yet')).toBeInTheDocument();
    expect(screen.getByText('Agents are reusable AI helpers with a model, instructions and tools.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Create agent' }));
    expect(screen.getByRole('form', { name: 'New agent' })).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveFocus();
    expect(screen.queryByText('No agents yet')).not.toBeInTheDocument();
  });
});

describe('New agent card', () => {
  it('creates a user agent from a starter, which also fills in the name', async () => {
    const user = userEvent.setup();
    renderSidebar({ agents: [] });
    await user.click(screen.getByRole('button', { name: 'New agent' }));
    await user.click(screen.getByRole('radio', { name: 'Reviewer' }));
    expect(screen.getByLabelText('Name')).toHaveValue('Reviewer');
    await user.click(screen.getByRole('radio', { name: 'User' }));
    await user.click(screen.getByRole('button', { name: 'Create agent' }));
    expect(postedOfType('createAgent')).toEqual([{ type: 'createAgent', name: 'Reviewer', scope: 'user', starter: 'reviewer' }]);
    expect(screen.queryByRole('form', { name: 'New agent' })).not.toBeInTheDocument();
  });

  it('keeps a typed name when the starter changes, and sends blank agents without a starter', async () => {
    const user = userEvent.setup();
    renderSidebar();
    await user.click(screen.getByRole('button', { name: 'New agent' }));
    await user.type(screen.getByLabelText('Name'), '  Translator ');
    await user.click(screen.getByRole('radio', { name: 'Coder' }));
    await user.click(screen.getByRole('radio', { name: 'Blank' }));
    expect(screen.getByLabelText('Name')).toHaveValue('  Translator ');
    await user.type(screen.getByLabelText('Name'), '{Enter}');
    expect(postedOfType('createAgent')).toEqual([{ type: 'createAgent', name: 'Translator', scope: 'workspace' }]);
  });

  it('explains what is wrong instead of creating an unnamed or clashing agent', async () => {
    const user = userEvent.setup();
    renderSidebar();
    await user.click(screen.getByRole('button', { name: 'New agent' }));
    await user.click(screen.getByRole('button', { name: 'Create agent' }));
    expect(screen.getByText('Enter a name for the agent.')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Name'), 'coder');
    expect(screen.getByText('This workspace already has an agent named Coder. Choose another name.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Create agent' }));
    expect(postedOfType('createAgent')).toEqual([]);

    // The same name is fine as a user agent.
    await user.click(screen.getByRole('radio', { name: 'User' }));
    expect(screen.queryByText(/already has an agent/)).not.toBeInTheDocument();
  });

  it('closes on Escape and gives focus back to the New button', async () => {
    const user = userEvent.setup();
    renderSidebar();
    await user.click(screen.getByRole('button', { name: 'New agent' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('form', { name: 'New agent' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New agent' })).toHaveFocus();
  });
});

describe('lenient agent summaries', () => {
  it('renders agents from broken files with fallbacks and a warning', () => {
    const broken = { id: '', name: '', model: '', tools: undefined, scope: 'workspace', uri: 'file:///w/.isarflow/agents/translator.agent.yaml', valid: false } as unknown as AgentSummary;
    const duplicate = { ...AGENTS[0] };
    renderSidebar({ agents: [AGENTS[0], duplicate, broken, { ...AGENTS[1], shadowed: true, scope: 'user' }] });
    const row = agentRow(/^translator/);
    expect(row).toHaveTextContent('No model set');
    expect(row).toHaveTextContent('No tools');
    expect(within(row).getByRole('img', { name: 'Has problems' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^Coder/ })).toHaveLength(2);
    expect(screen.getByText('Hidden')).toBeInTheDocument();
  });
});

describe('agent avatars', () => {
  it('never take the alpenrose (error) color, whatever the id', () => {
    const many = Array.from({ length: 40 }, (_, i): AgentSummary => ({ ...AGENTS[0], id: `agent-${i}`, name: `Agent ${i}`, uri: `file:///a/${i}.agent.yaml` }));
    renderSidebar({ agents: [...many, { ...AGENTS[0], id: 'translator', name: 'Translator', uri: 'file:///t.agent.yaml' }] });
    const colors = new Set([...document.querySelectorAll('.sb-list .if-stone')].map((stone) => stone.getAttribute('data-type')));
    expect(colors.has('stop')).toBe(false);
    expect(colors.size).toBeGreaterThan(2);
  });
});
