import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { RunOrigin } from '@isar-flow/core';
import { RunOriginChip } from '../../src/components';

const chipOf = (run: Parameters<typeof RunOriginChip>[0]['run']) => {
  const { container } = render(<RunOriginChip run={run} />);
  return container.querySelector('.if-chip');
};

describe('RunOriginChip', () => {
  it.each<[RunOrigin, string, string, string]>([
    [
      { kind: 'trigger', trigger: 'save', file: 'src/app.ts' },
      'On save',
      'Started on save of src/app.ts',
      'save',
    ],
    [{ kind: 'trigger', trigger: 'change' }, 'On change', 'Started by a file change', 'file'],
    [{ kind: 'trigger', trigger: 'schedule' }, 'Scheduled', 'Started by its schedule', 'watch'],
    [{ kind: 'copilot' }, 'Copilot', 'Started by Copilot', 'copilot'],
    [{ kind: 'selection' }, 'Selection', 'Started on a selection', 'selection'],
  ])('shows %o as a chip with the sentence as tooltip', (origin, chip, sentence, icon) => {
    const element = chipOf({ origin });
    expect(element).toHaveTextContent(chip);
    expect(element).toHaveAttribute('title', sentence);
    expect(element?.querySelector('.codicon')).toHaveClass(`codicon-${icon}`);
  });

  it('shows nothing for manual runs and origins it does not know', () => {
    expect(chipOf({ origin: { kind: 'manual' } })).toBeNull();
    expect(chipOf({})).toBeNull();
    expect(chipOf({ origin: { kind: 'later' } as unknown as RunOrigin })).toBeNull();
  });

  it('keeps the simulated and resumed chips', () => {
    render(<RunOriginChip run={{ simulated: true, origin: { kind: 'copilot' } }} />);
    expect(screen.getByText('Simulated')).toBeInTheDocument();
    expect(screen.queryByText('Copilot')).toBeNull();
    render(<RunOriginChip run={{ resumedFrom: { runId: 'r', stepId: 'tests' } }} />);
    expect(screen.getByText('Resumed')).toHaveAttribute('title', 'Resumed from tests');
  });
});
