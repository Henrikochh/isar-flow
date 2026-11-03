import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MEMORY_FILE, MEMORY_MISSING, MEMORY_OVER } from '../../harness/fixtures';
import { AgentApp } from '../../src/views/agent/AgentApp';
import { agentDoc, CATALOG, clearPosted, fromHost, postedOfType, REVIEWER_AGENT_TEXT } from './helpers';

function renderEditor(text = REVIEWER_AGENT_TEXT, overrides: Parameters<typeof agentDoc>[1] = {}) {
  const view = render(<AgentApp />);
  fromHost({ type: 'document', doc: agentDoc(text, overrides) });
  fromHost({ type: 'catalog', catalog: CATALOG });
  clearPosted();
  return view;
}

const section = () => screen.getByRole('heading', { name: 'Memory' }).closest('section') as HTMLElement;
const modes = () => within(section()).getByRole('radiogroup', { name: 'Project memory' });
const mode = (name: string) => within(modes()).getByRole('radio', { name });
const hint = () => section().querySelector('.ag-permission__hint');

beforeAll(() => {
  Element.prototype.scrollIntoView ??= () => undefined;
});
beforeEach(() => clearPosted());

describe('Memory section', () => {
  it('reads the memory by default and says what that means', () => {
    renderEditor();
    expect(mode('Read')).toHaveAttribute('aria-checked', 'true');
    expect(hint()).toHaveTextContent('Adds .isarflow/memory.md (first 8 KB) to the instructions.');
    expect(hint()?.querySelector('code')).toHaveTextContent('.isarflow/memory.md');
  });

  it('follows the setting of the file', () => {
    renderEditor(`${REVIEWER_AGENT_TEXT}memory: write\n`);
    expect(mode('Read and write')).toHaveAttribute('aria-checked', 'true');
    expect(hint()).toHaveTextContent(
      'Adds .isarflow/memory.md (first 8 KB) to the instructions and lets the agent save notes with the remember tool.',
    );
    expect(Array.from(hint()?.querySelectorAll('code') ?? []).map((c) => c.textContent)).toEqual([
      '.isarflow/memory.md',
      'remember',
    ]);
  });

  it('writes Off and Read and write, and removes the key for the default', () => {
    renderEditor();
    fireEvent.click(mode('Off'));
    expect(within(section()).getByText('The agent never sees the memory file.')).toBeInTheDocument();
    fireEvent.click(mode('Read and write'));
    fireEvent.click(mode('Read'));
    expect(postedOfType('update')).toEqual([
      { type: 'update', set: { memory: 'none' } },
      { type: 'update', set: { memory: 'write' } },
      { type: 'update', set: {}, unset: ['memory'] },
    ]);
  });

  it('shows the memory file with its size and first lines, and opens it', () => {
    renderEditor();
    fromHost({ type: 'memory', memory: MEMORY_FILE });
    const file = within(section()).getByText('.isarflow/memory.md', { selector: 'code.ag-memory__path' });
    expect(file).toBeInTheDocument();
    expect(within(section()).getByText('1.3 KB')).toBeInTheDocument();
    const preview = within(section()).getByText(/Tests run with npm test/);
    expect(preview).toHaveClass('ag-memory__preview');
    expect(preview.textContent?.split('\n')).toHaveLength(6);
    fireEvent.click(within(section()).getByRole('button', { name: 'Open memory file' }));
    expect(postedOfType('openMemory')).toEqual([{ type: 'openMemory' }]);
  });

  it('offers to create a missing memory file', () => {
    renderEditor();
    fromHost({ type: 'memory', memory: MEMORY_MISSING });
    expect(within(section()).getByText('Not created yet')).toBeInTheDocument();
    expect(within(section()).queryByText(/Tests run/)).toBeNull();
    fireEvent.click(within(section()).getByRole('button', { name: 'Create memory file' }));
    expect(postedOfType('openMemory')).toHaveLength(1);
  });

  it('warns when the file is longer than agents read', () => {
    renderEditor();
    fromHost({ type: 'memory', memory: MEMORY_OVER });
    expect(within(section()).getByText('11.7 KB')).toBeInTheDocument();
    expect(within(section()).getByText('Agents read only the first 8 KB.')).toBeInTheDocument();
  });

  it('shows no file without a workspace folder and says how to get one', () => {
    renderEditor();
    fromHost({ type: 'memory', memory: null });
    expect(within(section()).queryByRole('button', { name: /memory file/ })).toBeNull();
    expect(mode('Read')).toBeInTheDocument();
    expect(within(section()).getByText('Open a folder to use project memory.')).toBeInTheDocument();
  });

  it('says nothing about folders while the host has not sent the file yet', () => {
    renderEditor();
    expect(within(section()).queryByText('Open a folder to use project memory.')).toBeNull();
  });

  it('says nothing about folders when memory is off', () => {
    renderEditor(`${REVIEWER_AGENT_TEXT}memory: none\n`);
    fromHost({ type: 'memory', memory: null });
    expect(within(section()).queryByText('Open a folder to use project memory.')).toBeNull();
  });

  it('explains which memory a user agent uses', () => {
    renderEditor(REVIEWER_AGENT_TEXT, { scope: 'user' });
    fromHost({ type: 'memory', memory: MEMORY_FILE });
    expect(
      within(section()).getByText('Uses the memory of the workspace folder it runs in.'),
    ).toBeInTheDocument();
  });

  it('comes after Permissions', () => {
    renderEditor();
    const headings = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(headings.indexOf('Memory')).toBe(headings.indexOf('Permissions') + 1);
  });
});
