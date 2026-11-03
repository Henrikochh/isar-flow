import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ModelCatalog, ModelProbeResult } from '@isar-flow/core';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AgentApp } from '../../src/views/agent/AgentApp';
import { agentDoc, CATALOG, clearPosted, fromHost, postedOfType } from './helpers';

const TEXT = `name: Helper
model: litellm/claude-sonnet
tools: [readFile, listFiles]
`;

function probe(ref: string, outcome: ModelProbeResult['outcome'], message: string, latencyMs?: number) {
  return { ref, outcome, message, toolCalls: outcome === 'tools', json: true, latencyMs, testedAt: 0 };
}

const BASE: ModelCatalog = { ...CATALOG, probes: {}, probing: [] };

function renderEditor(text = TEXT, catalog: ModelCatalog = BASE) {
  const view = render(<AgentApp />);
  fromHost({ type: 'document', doc: agentDoc(text) });
  fromHost({ type: 'catalog', catalog });
  clearPosted();
  return view;
}

const updates = () => postedOfType('update');
const header = () => document.querySelector<HTMLElement>('.ag-header') as HTMLElement;

beforeAll(() => {
  Element.prototype.scrollIntoView ??= () => undefined;
});
beforeEach(() => clearPosted());

describe('agent header capability badges', () => {
  it('shows what the agent may do, following unsaved changes in the form', () => {
    renderEditor();
    expect(within(header()).getByText('Read-only')).toBeInTheDocument();
    expect(within(header()).getByText('Workspace')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox', { name: /^Apply patches/ }));
    expect(within(header()).getByText('Edits files (asks)')).toBeInTheDocument();
    expect(within(header()).queryByText('Read-only')).toBeNull();

    fireEvent.click(
      within(screen.getByRole('radiogroup', { name: 'Edit files' })).getByRole('radio', { name: 'Always' }),
    );
    expect(within(header()).getByText('Edits files (auto)')).toBeInTheDocument();
  });
});

describe('Test model', () => {
  it('tests the main model', () => {
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Test model' }));
    expect(postedOfType('testModel')).toEqual([{ type: 'testModel', ref: 'litellm/claude-sonnet' }]);
  });

  it('is disabled without a model', () => {
    renderEditor('name: Helper\ntools: [readFile]\n');
    expect(screen.getByRole('button', { name: 'Test model' })).toBeDisabled();
  });

  it('says Testing… while the model is tested and keeps the focus', () => {
    renderEditor(TEXT, { ...BASE, probing: ['litellm/claude-sonnet'] });
    const testing = screen.getByRole('button', { name: 'Testing…' });
    expect(testing).toHaveAttribute('aria-disabled', 'true');
    expect(testing).not.toHaveAttribute('disabled');
    fireEvent.click(testing);
    expect(postedOfType('testModel')).toEqual([]);
  });

  it('tells screen readers when the test starts and how it went', () => {
    renderEditor(TEXT, { ...BASE, probing: ['litellm/claude-sonnet'] });
    expect(screen.getByText('Testing litellm/claude-sonnet…')).toHaveAttribute('role', 'status');
    fromHost({
      type: 'catalog',
      catalog: {
        ...BASE,
        probes: {
          'litellm/claude-sonnet': probe('litellm/claude-sonnet', 'text', 'Needs text tool mode', 900),
        },
      },
    });
    expect(screen.getByText('Test of litellm/claude-sonnet: Needs text tool mode')).toHaveAttribute(
      'role',
      'status',
    );
  });

  it('shows the result with its latency', () => {
    renderEditor(TEXT, {
      ...BASE,
      probes: { 'litellm/claude-sonnet': probe('litellm/claude-sonnet', 'tools', 'Tool calls work', 820) },
    });
    const result = screen.getByText('Tool calls work').closest('.ag-probe') as HTMLElement;
    expect(result).toHaveTextContent('820 ms');
    expect(result.querySelector('.codicon-pass')).not.toBeNull();
  });

  it('shows a failed test as an error', () => {
    renderEditor(TEXT, {
      ...BASE,
      probes: {
        'litellm/claude-sonnet': probe('litellm/claude-sonnet', 'failed', 'The API key was rejected.'),
      },
    });
    const result = screen.getByText('The API key was rejected.').closest('.ag-probe') as HTMLElement;
    expect(result).toHaveClass('ag-probe--failed');
  });
});

describe('Tool calls setting', () => {
  it('writes the tool mode and unsets it for Automatic', () => {
    renderEditor();
    const select = screen.getByRole('button', { name: /Tool calls/ });
    expect(select).toHaveTextContent('Automatic');
    fireEvent.click(select);
    fireEvent.click(screen.getByRole('option', { name: /Text in the prompt/ }));
    expect(updates()).toEqual([{ type: 'update', set: { toolMode: 'text' } }]);
    expect(screen.getByRole('button', { name: /Tool calls/ })).toHaveTextContent('Text in the prompt');

    clearPosted();
    fireEvent.click(screen.getByRole('button', { name: /Tool calls/ }));
    fireEvent.click(screen.getByRole('option', { name: /Automatic/ }));
    expect(updates()).toEqual([{ type: 'update', set: {}, unset: ['toolMode'] }]);
  });

  it('reads native mode from the file', () => {
    renderEditor(`${TEXT}toolMode: native\n`);
    expect(screen.getByRole('button', { name: /Tool calls/ })).toHaveTextContent('Native');
  });
});

describe('model notes', () => {
  const NO_TOOLS: ModelCatalog = {
    ...BASE,
    models: BASE.models.map((m) =>
      m.ref === 'litellm/claude-sonnet' ? { ...m, capabilities: { ...m.capabilities, tools: false } } : m,
    ),
  };

  it('explains how Automatic handles a model without native tool calls', () => {
    renderEditor(TEXT, NO_TOOLS);
    expect(
      screen.getByText(
        "This model can't call tools natively, so Automatic describes the tools in the prompt.",
      ),
    ).toBeInTheDocument();
  });

  it('treats a model whose test needed text mode the same way', () => {
    renderEditor(TEXT, {
      ...BASE,
      probes: { 'litellm/claude-sonnet': probe('litellm/claude-sonnet', 'text', 'Needs text tool mode') },
    });
    expect(screen.getByText(/so Automatic describes the tools in the prompt/)).toBeInTheDocument();
  });

  it('warns when native mode is forced on such a model', () => {
    renderEditor(`${TEXT}toolMode: native\n`, NO_TOOLS);
    expect(
      screen.getByText(
        "This model can't call tools natively. Set Tool calls to Automatic or Text in the prompt.",
      ),
    ).toBeInTheDocument();
  });

  it('says nothing about tool calls in text mode', () => {
    renderEditor(`${TEXT}toolMode: text\n`, NO_TOOLS);
    expect(screen.queryByText(/can't call tools natively/)).toBeNull();
  });

  it('shows a "needs text mode" result as settled once the agent uses text mode', () => {
    renderEditor(`${TEXT}toolMode: text\n`, {
      ...BASE,
      probes: { 'litellm/claude-sonnet': probe('litellm/claude-sonnet', 'text', 'Needs text tool mode') },
    });
    expect(screen.getByText('Needs text tool mode').closest('.ag-probe')).toHaveClass('ag-probe--tools');
  });
});

describe('Tools section', () => {
  it('lists Apply patches with the edit tools and explains read-only agents', () => {
    renderEditor();
    const edits = screen.getByRole('group', { name: 'Edits files' });
    expect(within(edits).getByRole('checkbox', { name: /^Apply patches/ })).toBeInTheDocument();
    expect(
      screen.getByText(
        'Read-only: it can look at files but not change them. Turn on Edit files to let it change code.',
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: /^Edit files/ }));
    expect(screen.queryByText(/^Read-only: it can look at files/)).toBeNull();
  });

  it('turns on the Edit files permission for an agent that only applies patches', () => {
    renderEditor(`${TEXT.replace('[readFile, listFiles]', '[readFile, applyPatch]')}`);
    const edits = screen.getByRole('radiogroup', { name: 'Edit files' });
    expect(within(edits).getByRole('radio', { name: 'Ask' })).toBeEnabled();
  });
});
