import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApp } from '../../src/views/agent/AgentApp';
import { agentDoc, CATALOG, clearPosted, fromHost, posted, postedOfType, REVIEWER_AGENT_TEXT } from './helpers';

function renderEditor(text = REVIEWER_AGENT_TEXT, overrides: Parameters<typeof agentDoc>[1] = {}) {
  const view = render(<AgentApp />);
  fromHost({ type: 'document', doc: agentDoc(text, overrides) });
  fromHost({ type: 'catalog', catalog: CATALOG });
  clearPosted();
  return view;
}

const updates = () => postedOfType('update');

beforeAll(() => {
  // jsdom has no layout; the Select scrolls its active option into view.
  Element.prototype.scrollIntoView ??= () => undefined;
});
beforeEach(() => clearPosted());

describe('AgentApp', () => {
  it('posts ready once and waits for the document', () => {
    render(<AgentApp />);
    expect(posted()).toEqual([{ type: 'ready' }]);
    expect(screen.getByText('Loading agent…')).toBeInTheDocument();
    fromHost({ type: 'document', doc: agentDoc(REVIEWER_AGENT_TEXT) });
    expect(screen.getByRole('textbox', { name: 'Agent name' })).toHaveValue('Reviewer');
    expect(screen.getByRole('textbox', { name: 'Description' })).toHaveValue('Strict senior code reviewer');
    expect(screen.getByText('Workspace')).toBeInTheDocument();
    expect(postedOfType('ready')).toHaveLength(1);
  });

  it('commits the name on blur and never writes an empty name', () => {
    renderEditor();
    const name = screen.getByRole('textbox', { name: 'Agent name' });
    fireEvent.focus(name);
    fireEvent.change(name, { target: { value: 'Strict reviewer' } });
    fireEvent.blur(name);
    expect(updates()).toEqual([{ type: 'update', set: { name: 'Strict reviewer' } }]);

    clearPosted();
    fireEvent.focus(name);
    fireEvent.change(name, { target: { value: '   ' } });
    fireEvent.blur(name);
    expect(updates()).toEqual([]);
    expect(name).toHaveValue('Strict reviewer');
  });

  it('removes the description key when the description is cleared', () => {
    renderEditor();
    const description = screen.getByRole('textbox', { name: 'Description' });
    fireEvent.focus(description);
    fireEvent.change(description, { target: { value: '' } });
    fireEvent.blur(description);
    expect(updates()).toEqual([{ type: 'update', set: {}, unset: ['description'] }]);
  });

  it('restores the name on Escape', () => {
    renderEditor();
    const name = screen.getByRole('textbox', { name: 'Agent name' });
    fireEvent.focus(name);
    fireEvent.change(name, { target: { value: 'Oops' } });
    fireEvent.keyDown(name, { key: 'Escape' });
    expect(name).toHaveValue('Reviewer');
    expect(updates()).toEqual([]);
  });

  it('writes numbers, clears empty ones and rejects text', () => {
    renderEditor();
    const temperature = screen.getByLabelText('Temperature');
    fireEvent.change(temperature, { target: { value: '0.7' } });
    fireEvent.blur(temperature);
    fireEvent.change(temperature, { target: { value: '' } });
    fireEvent.blur(temperature);
    expect(updates()).toEqual([
      { type: 'update', set: { temperature: 0.7 } },
      { type: 'update', set: {}, unset: ['temperature'] },
    ]);

    clearPosted();
    const maxTurns = screen.getByLabelText('Max turns');
    fireEvent.change(maxTurns, { target: { value: '2.5' } });
    fireEvent.blur(maxTurns);
    expect(updates()).toEqual([]);
    expect(screen.getByText('Enter a whole number.')).toBeInTheDocument();
  });

  it('writes the system prompt and removes it when emptied', () => {
    renderEditor();
    const prompt = screen.getByLabelText(/System prompt/);
    fireEvent.change(prompt, { target: { value: 'Be brief.' } });
    fireEvent.blur(prompt);
    fireEvent.change(prompt, { target: { value: '  ' } });
    fireEvent.blur(prompt);
    expect(updates()).toEqual([
      { type: 'update', set: { systemPrompt: 'Be brief.' } },
      { type: 'update', set: {}, unset: ['systemPrompt'] },
    ]);
  });

  it('groups tools by risk and writes them in canonical order', () => {
    renderEditor();
    expect(screen.getByRole('group', { name: 'Read only' })).toBeInTheDocument();
    const edits = screen.getByRole('group', { name: 'Edits files' });
    expect(within(edits).getAllByRole('checkbox')).toHaveLength(2);
    expect(screen.getByText('4 of 7 on')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox', { name: /^Edit files/ }));
    expect(updates()).toEqual([
      { type: 'update', set: { tools: ['readFile', 'listFiles', 'searchText', 'gitDiff', 'editFile'] } },
    ]);
  });

  it('builds quick changes on each other before the host answers', () => {
    renderEditor();
    fireEvent.click(screen.getByRole('checkbox', { name: /^Edit files/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /^Write files/ }));
    expect(updates()[1]).toEqual({
      type: 'update',
      set: { tools: ['readFile', 'listFiles', 'searchText', 'gitDiff', 'editFile', 'writeFile'] },
    });
    // The host re-sends the old text (e.g. after the model list changed) before it applies the changes.
    fromHost({ type: 'document', doc: agentDoc(REVIEWER_AGENT_TEXT) });
    expect(screen.getByRole('checkbox', { name: /^Write files/ })).toBeChecked();
    expect(screen.getByText('6 of 7 on')).toBeInTheDocument();
  });

  it('disables a permission until one of its tools is on', () => {
    renderEditor();
    const edits = screen.getByRole('radiogroup', { name: 'Edit files' });
    expect(within(edits).getByRole('radio', { name: 'Never' })).toBeDisabled();
    expect(screen.getByText('Turn on Edit files or Write files under Tools to use this.')).toBeInTheDocument();

    const withEdits = REVIEWER_AGENT_TEXT.replace('gitDiff]', 'gitDiff, writeFile]');
    fromHost({ type: 'document', doc: agentDoc(withEdits) });
    const ask = within(screen.getByRole('radiogroup', { name: 'Edit files' })).getByRole('radio', { name: 'Ask' });
    expect(ask).toBeEnabled();
    fireEvent.click(ask);
    expect(updates()).toEqual([{ type: 'update', set: { permissions: { edits: 'ask', commands: 'none' } } }]);
    expect(within(screen.getByRole('radiogroup', { name: 'Run commands' })).getByRole('radio', { name: 'Never' })).toBeDisabled();
  });

  it('shows unset permissions as Ask, the level the tool host applies, and writes any level chosen', () => {
    const unset = REVIEWER_AGENT_TEXT.replace('gitDiff]', 'gitDiff, runCommand]').replace(/permissions:\n.*\n.*\n/, '');
    renderEditor(unset);
    const commands = screen.getByRole('radiogroup', { name: 'Run commands' });
    expect(within(commands).getByRole('radio', { name: 'Ask' })).toBeChecked();
    expect(screen.getByText('Not set — asks each time')).toBeInTheDocument();

    fireEvent.click(within(commands).getByRole('radio', { name: 'Ask' }));
    fireEvent.click(within(commands).getByRole('radio', { name: 'Always' }));
    expect(updates()).toEqual([
      { type: 'update', set: { permissions: { commands: 'ask' } } },
      { type: 'update', set: { permissions: { commands: 'auto' } } },
    ]);

    fromHost({ type: 'document', doc: agentDoc(unset.replace('tools:', 'permissions:\n  commands: ask\ntools:')) });
    expect(screen.queryByText('Not set — asks each time')).not.toBeInTheDocument();
    expect(screen.getByText('VS Code asks you before each command.')).toBeInTheDocument();
  });

  it('removes and adds fallback models', () => {
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Remove litellm/claude-sonnet' }));
    expect(updates()).toEqual([{ type: 'update', set: {}, unset: ['fallbackModels'] }]);

    clearPosted();
    fireEvent.click(screen.getByRole('button', { name: /^Fallback models/ }));
    fireEvent.click(screen.getByRole('option', { name: /Claude Sonnet 4\.5/ }));
    // The add builds on the removal before the host confirms it, so the removed model stays removed.
    expect(updates()).toEqual([
      { type: 'update', set: { fallbackModels: ['vscode/copilot/claude-sonnet-4.5'] } },
    ]);
  });

  it('changes the main model through the picker', () => {
    renderEditor();
    fireEvent.click(screen.getByLabelText('Main model'));
    fireEvent.click(screen.getByRole('option', { name: /qwen-coder-32b/ }));
    expect(updates()).toEqual([{ type: 'update', set: { model: 'litellm/qwen-coder-32b' } }]);
    // The summary under the picker names the listed model by its reference.
    expect(screen.getByText('litellm/qwen-coder-32b')).toBeInTheDocument();
  });

  it('warns when the model is not offered by its provider', () => {
    renderEditor(REVIEWER_AGENT_TEXT.replace('model: vscode/copilot/gpt-4.1', 'model: litellm/gpt-9'));
    expect(screen.getByText("LiteLLM (localhost:4000) doesn't list this model. Refresh models or choose another one.")).toBeInTheDocument();
    // The picker already shows the bare reference, so the summary under it does not repeat it.
    const section = screen.getByRole('heading', { name: 'Model' }).closest('section') as HTMLElement;
    expect(within(section).getAllByText('litellm/gpt-9')).toHaveLength(1);
  });

  it('shows the full name as a tooltip only when the header cuts it off', () => {
    renderEditor();
    const name = screen.getByRole('textbox', { name: 'Agent name' });
    fireEvent.mouseEnter(name);
    expect(name).not.toHaveAttribute('title');
    Object.defineProperty(name, 'scrollWidth', { configurable: true, value: 400 });
    Object.defineProperty(name, 'clientWidth', { configurable: true, value: 200 });
    fireEvent.mouseEnter(name);
    expect(name).toHaveAttribute('title', 'Reviewer');
  });

  it('posts catalog actions and Open YAML', () => {
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Open YAML' }));
    fireEvent.click(screen.getByLabelText('Main model'));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh models' }));
    expect(posted()).toEqual([{ type: 'openYaml' }, { type: 'refreshModels' }]);
  });

  it('shows schema problems in a banner and at their fields', () => {
    renderEditor(REVIEWER_AGENT_TEXT.replace('temperature: 0.2', 'temperature: 3').replace('edits: none', 'edits: sometimes'));
    const banner = screen.getAllByRole('alert')[0];
    expect(banner).toHaveTextContent("'temperature' must be at most 2");
    expect(banner).toHaveTextContent('One more problem is marked below.');
    expect(screen.getByLabelText('Temperature')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText(/Invalid value 'sometimes'/)).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Message to the agent' })).toBeDisabled();

    fireEvent.click(within(banner).getByRole('button', { name: 'Open YAML' }));
    expect(posted()).toEqual([{ type: 'openYaml' }]);
  });

  it('survives unreadable YAML and wrongly typed fields', () => {
    renderEditor('name: [unclosed\n');
    expect(screen.getByRole('alert')).toHaveTextContent('Fix the YAML to edit the agent here.');
    expect(screen.queryByText('Tools')).not.toBeInTheDocument();

    fromHost({
      type: 'document',
      doc: agentDoc('name: 42\nmodel: true\ntools: readFile\nfallbackModels: [1, a/b]\npermissions: always\n'),
    });
    expect(screen.getByRole('textbox', { name: 'Agent name' })).toHaveValue('42');
    expect(screen.getByText('0 of 7 on')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove a/b' })).toBeInTheDocument();
  });

  it('shows a dismissible banner when an update fails', () => {
    renderEditor();
    fromHost({ type: 'updateFailed', error: 'The file changed on disk. Try again.' });
    expect(screen.getByText("The change couldn't be saved")).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText("The change couldn't be saved")).not.toBeInTheDocument();
  });

  it('lists the workflows that use the agent and opens one on click', () => {
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Open workflow .isarflow/workflows/review-loop.workflow.yaml' }));
    expect(posted()).toEqual([{ type: 'openWorkflow', path: '.isarflow/workflows/review-loop.workflow.yaml' }]);
    expect(screen.getByText('agent: reviewer')).toBeInTheDocument();
    fromHost({ type: 'document', doc: agentDoc(REVIEWER_AGENT_TEXT, { usedBy: [] }) });
    expect(screen.getByText('No workflow uses this agent yet.')).toBeInTheDocument();
  });

  it('lists a path once when workflows in two workspace folders share it', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const path = '.isarflow/workflows/review-loop.workflow.yaml';
    renderEditor(REVIEWER_AGENT_TEXT, { usedBy: [path, path, '.isarflow/workflows/nightly.workflow.yaml'] });
    expect(screen.getAllByRole('button', { name: /^Open workflow/ })).toHaveLength(2);
    expect(screen.getByText('2 workflows')).toBeInTheDocument();
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});
