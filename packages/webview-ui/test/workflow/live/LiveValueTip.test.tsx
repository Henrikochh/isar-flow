import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { LiveValue } from '@isar-flow/core';
import type { LiveSnapshot } from '../../../src/views/workflow/live/LiveDataProvider';
import { LiveValueTip } from '../../../src/views/workflow/live/LiveValueTip';
import { lastContext } from './helpers';

const LAST: LiveSnapshot = { context: lastContext(), source: 'last' };

function show(value: LiveValue, snapshot: LiveSnapshot = LAST, expression = 'steps.tests.output') {
  const anchor = document.createElement('span');
  document.body.append(anchor);
  render(<LiveValueTip anchor={anchor} snapshot={snapshot} expression={expression} value={value} />);
  return screen.getByRole('tooltip');
}

describe('LiveValueTip', () => {
  it('shows the value of the last run with its type', () => {
    const tip = show({
      kind: 'value',
      text: '1 failed\n31 passed',
      type: 'text',
      truncated: false,
      masked: false,
    });
    expect(within(tip).getByText('Last run')).toBeInTheDocument();
    expect(within(tip).getByText('5 min ago')).toBeInTheDocument();
    expect(within(tip).getByRole('img', { name: 'Failed' })).toBeInTheDocument();
    expect(within(tip).getByText('steps.tests.output')).toBeInTheDocument();
    expect(within(tip).getByText('Text')).toBeInTheDocument();
    expect(tip.querySelector('pre')?.textContent).toBe('1 failed\n31 passed');
    expect(within(tip).queryByText('Simulated')).toBeNull();
    expect(within(tip).queryByText('Showing the first 2 KB.')).toBeNull();
    // Nothing in it takes the focus.
    expect(tip.querySelector('button, input, [tabindex]:not([tabindex="-1"])')).toBeNull();
  });

  it('names the shown run', () => {
    const tip = show(
      { kind: 'value', text: '0', type: 'number', truncated: false, masked: false },
      { context: lastContext({ status: 'success' }), source: 'shown' },
    );
    expect(within(tip).getByText('This run')).toBeInTheDocument();
    expect(within(tip).getByText('Number')).toBeInTheDocument();
    expect(within(tip).getByRole('img', { name: 'Succeeded' })).toBeInTheDocument();
  });

  it.each([
    ['shown', 'This simulation'],
    ['last', 'Last simulation'],
  ] as const)('names a %s simulation and marks it with the beaker', (source, name) => {
    const tip = show(
      { kind: 'value', text: '0', type: 'number', truncated: false, masked: false },
      { context: lastContext({ simulated: true, status: 'success' }), source },
    );
    expect(within(tip).getByText(name)).toBeInTheDocument();
    expect(within(tip).queryByText(/run$/)).toBeNull();
    expect(tip.querySelector('.wf-live-run .codicon-beaker')).not.toBeNull();
  });

  it.each([
    ['boolean', 'Yes / no'],
    ['list', 'List'],
    ['object', 'Object'],
  ] as const)('labels %s values', (type, label) => {
    const tip = show({ kind: 'value', text: 'x', type, truncated: false, masked: false });
    expect(within(tip).getByText(label)).toBeInTheDocument();
  });

  it('says when a value is empty', () => {
    const tip = show({ kind: 'value', text: '', type: 'empty', truncated: false, masked: false });
    expect(within(tip).getByText('Empty')).toBeInTheDocument();
    expect(tip.querySelector('pre')).toBeNull();
  });

  it('notes cut and masked values', () => {
    const tip = show({ kind: 'value', text: 'x'.repeat(2048), type: 'text', truncated: true, masked: true });
    expect(within(tip).getByText('Showing the first 2 KB.')).toBeInTheDocument();
    expect(within(tip).getByText('Contains a secret, shown as ••••••.')).toBeInTheDocument();
  });

  it('shows why a value is unavailable', () => {
    const tip = show({ kind: 'unavailable', message: "Environment values aren't saved with runs." });
    expect(within(tip).getByText("Environment values aren't saved with runs.")).toHaveClass('wf-live-msg');
    expect(tip.querySelector('pre')).toBeNull();
    expect(within(tip).queryByText('Text')).toBeNull();
  });

  it('shows evaluation errors as they are', () => {
    const tip = show({ kind: 'error', message: "Unknown function 'tial'" });
    expect(within(tip).getByText("Unknown function 'tial'")).toHaveClass('wf-live-msg');
  });

  it('renders model text as plain text', () => {
    const tip = show({ kind: 'value', text: '<b>bold</b>', type: 'text', truncated: false, masked: false });
    expect(tip.querySelector('b')).toBeNull();
    expect(tip.querySelector('pre')?.textContent).toBe('<b>bold</b>');
  });
});
