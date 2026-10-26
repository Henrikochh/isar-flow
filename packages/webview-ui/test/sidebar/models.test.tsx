import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { CATALOG } from '../../harness/fixtures';
import { postedOfType, renderSidebar, resetPosted } from './helpers';

beforeEach(resetPosted);

describe('Models section', () => {
  it('lists providers with status, model counts and errors', () => {
    renderSidebar();
    const list = screen.getByRole('list', { name: 'Model providers' });
    const vscode = within(list).getByRole('button', { name: /VS Code.*4 models/ });
    expect(within(vscode).getByRole('img', { name: 'Connected' })).toBeInTheDocument();

    const ollama = within(list).getByRole('button', { name: /Ollama.*Not reachable/ });
    expect(ollama).toHaveTextContent('Not reachable');
    expect(ollama).toHaveTextContent('Cannot reach http://localhost:11434/v1. Is the server running?');
    expect(within(ollama).getByRole('img', { name: 'Error' })).toBeInTheDocument();
  });

  it('gives provider names and errors that may be cut off a tooltip with the full text', () => {
    renderSidebar();
    const litellm = screen.getByRole('button', { name: /LiteLLM.*5 models/ });
    expect(within(litellm).getByTitle('LiteLLM (localhost:4000)')).toHaveTextContent('LiteLLM (localhost:4000)');
    const ollama = screen.getByRole('button', { name: /Ollama.*Not reachable/ });
    expect(within(ollama).getByTitle('Cannot reach http://localhost:11434/v1. Is the server running?')).toBeInTheDocument();
  });

  it('opens the provider settings when a row is clicked', async () => {
    const user = userEvent.setup();
    renderSidebar();
    await user.click(screen.getByRole('button', { name: /Ollama.*Not reachable/ }));
    expect(postedOfType('editProvider')).toEqual([{ type: 'editProvider', providerId: 'ollama' }]);
  });

  it('refreshes models and adds endpoints from the section header', async () => {
    const user = userEvent.setup();
    renderSidebar();
    await user.click(screen.getByRole('button', { name: 'Refresh models' }));
    await user.click(screen.getByRole('button', { name: 'Add endpoint' }));
    expect(postedOfType('refreshModels')).toHaveLength(1);
    expect(postedOfType('addProvider')).toHaveLength(1);
  });

  it('marks the refresh action busy while models are fetched', () => {
    renderSidebar({ catalog: { ...CATALOG, loading: true } });
    expect(screen.getByRole('button', { name: 'Fetching models…' })).toHaveAttribute('aria-busy', 'true');
  });

  it('sets keys and removes endpoints (after confirming), but not the built-in VS Code provider', async () => {
    const user = userEvent.setup();
    renderSidebar();
    expect(screen.queryByRole('button', { name: 'Remove VS Code' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Change API key' }));
    expect(postedOfType('setProviderKey')).toEqual([{ type: 'setProviderKey', providerId: 'litellm' }]);

    await user.click(screen.getByRole('button', { name: 'Remove Ollama' }));
    expect(postedOfType('removeProvider')).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Remove endpoint' }));
    expect(postedOfType('removeProvider')).toEqual([{ type: 'removeProvider', providerId: 'ollama' }]);
  });
});
