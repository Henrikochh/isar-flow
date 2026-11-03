import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ModelCatalog, ModelProbeResult } from '@isar-flow/core';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Button, CapabilityChips, ModelPicker, ProbeChip } from '../../src/components';

beforeAll(() => {
  // jsdom has no layout; the Select scrolls its active option into view.
  Element.prototype.scrollIntoView ??= () => undefined;
});

describe('CapabilityChips', () => {
  it('shows what an agent may do with the permission level', () => {
    render(
      <CapabilityChips
        source={{ tools: ['readFile', 'editFile', 'runCommand'], permissions: { edits: 'auto' } }}
      />,
    );
    const edits = screen.getByText('Edits files (auto)');
    expect(edits.closest('.if-chip')).toHaveAttribute('title', 'Changes files without asking.');
    expect(edits.closest('.if-chip')?.querySelector('.codicon-edit')).not.toBeNull();
    expect(screen.getByText('Runs commands (asks)')).toBeInTheDocument();
    expect(screen.queryByText('Read-only')).toBeNull();
  });

  it('says read-only for agents without edit or command tools, and is lenient', () => {
    const { rerender } = render(<CapabilityChips source={{ tools: ['readFile'] }} />);
    expect(screen.getByText('Read-only').closest('.if-chip')).toHaveAttribute(
      'title',
      'Can look at files but not change them or run commands.',
    );
    rerender(
      <CapabilityChips
        source={{ tools: ['editFile', 'teleport', 7] as never, permissions: { edits: 'sometimes' as never } }}
      />,
    );
    expect(screen.getByText('Edits files (asks)')).toBeInTheDocument();
    rerender(<CapabilityChips source={{ tools: ['editFile'], permissions: { edits: 'none' } }} />);
    expect(screen.getByText('Read-only')).toBeInTheDocument();
  });
});

function probe(outcome: ModelProbeResult['outcome'], message: string): ModelProbeResult {
  return { ref: 'x', outcome, message, toolCalls: outcome === 'tools', json: true, testedAt: 0 };
}

describe('ProbeChip', () => {
  it('names the outcome of a model test in its tone', () => {
    const { rerender } = render(<ProbeChip probe={probe('tools', 'Tool calls work')} />);
    expect(screen.getByText('Tool calls OK').closest('.if-chip')).toHaveClass('if-chip--success');
    rerender(<ProbeChip probe={probe('text', 'Needs text tool mode')} />);
    expect(screen.getByText('Needs text mode').closest('.if-chip')).toHaveClass('if-chip--warning');
    rerender(<ProbeChip probe={probe('failed', 'The API key was rejected.')} />);
    const failed = screen.getByText('Test failed').closest('.if-chip');
    expect(failed).toHaveClass('if-chip--error');
    expect(failed).toHaveAttribute('title', 'The API key was rejected.');
  });

  it('renders nothing for unknown outcomes', () => {
    const { container } = render(<ProbeChip probe={probe('maybe' as never, '')} />);
    expect(container).toBeEmptyDOMElement();
  });
});

const CATALOG: ModelCatalog = {
  loading: false,
  providers: [],
  models: [
    {
      ref: 'litellm/gpt-4.1',
      provider: 'litellm',
      providerLabel: 'LiteLLM',
      id: 'gpt-4.1',
      name: 'gpt-4.1',
      capabilities: { tools: true, jsonSchema: true },
    },
    {
      ref: 'litellm/llama',
      provider: 'litellm',
      providerLabel: 'LiteLLM',
      id: 'llama',
      name: 'llama',
      capabilities: { tools: true, jsonSchema: false },
    },
    {
      ref: 'litellm/qwen',
      provider: 'litellm',
      providerLabel: 'LiteLLM',
      id: 'qwen',
      name: 'qwen',
      capabilities: { tools: false, jsonSchema: false },
    },
  ],
  probes: {
    'litellm/gpt-4.1': { ...probe('tools', 'Tool calls work'), ref: 'litellm/gpt-4.1' },
    'litellm/llama': { ...probe('text', 'Needs text tool mode'), ref: 'litellm/llama' },
    'other/unlisted': { ...probe('failed', 'Not found'), ref: 'other/unlisted' },
  },
};

describe('ModelPicker probe chips', () => {
  it('shows the test result next to the capability chips', () => {
    render(<ModelPicker value={undefined} catalog={CATALOG} onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button'));
    const gpt = screen.getByRole('option', { name: /gpt-4\.1/ });
    expect(within(gpt).getByText('Tools')).toBeInTheDocument();
    expect(within(gpt).getByText('Tool calls OK')).toBeInTheDocument();
    expect(
      within(screen.getByRole('option', { name: /llama/ })).getByText('Needs text mode'),
    ).toBeInTheDocument();
    const qwen = screen.getByRole('option', { name: /qwen/ });
    expect(within(qwen).queryByText(/Tool calls OK|Needs text mode|Test failed/)).toBeNull();
  });

  it('shows the result for an unlisted current model too', () => {
    render(<ModelPicker value="other/unlisted" catalog={CATALOG} onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button'));
    expect(
      within(screen.getByRole('option', { name: /other\/unlisted/ })).getByText('Test failed'),
    ).toBeInTheDocument();
  });
});

describe('Button link variant', () => {
  it('renders a text-like button', () => {
    const onClick = vi.fn();
    render(
      <Button variant="link" onClick={onClick}>
        Pick Coder
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Pick Coder' });
    expect(button).toHaveClass('if-btn--link');
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalled();
  });
});
