import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SimulationFile } from '@isar-flow/core';
import { RELEASE_WORKFLOW_TEXT } from '../../../harness/fixtures';
import {
  answerChoices,
  defaultsText,
  mockKind,
  newRow,
  setAnswer,
} from '../../../src/views/workflow/simulation/mockRows';
import { docFor, fromHost, posted, renderInspector, resetPosted, simulation } from '../live/helpers';

const PICK = {
  id: 'pick-env',
  type: 'ask',
  question: 'Which environment should I deploy to?',
  choices: ['dev', 'staging', 'prod'],
  default: 'dev',
};
const NOTES = { id: 'release-notes', type: 'ask', question: 'Notes?', default: 'Routine release' };

describe('mock rows of ask blocks', () => {
  it('gives ask blocks their own editor', () => {
    expect(mockKind(PICK)).toBe('ask');
    expect(mockKind(NOTES)).toBe('ask');
  });

  it('starts new rows with the answer Simulate would give', () => {
    expect(newRow('ask', PICK, undefined, 1).result).toEqual({ answer: 'dev' });
    expect(newRow('ask', { ...PICK, default: undefined }, undefined, 1).result).toEqual({ answer: 'dev' });
    expect(newRow('ask', { ...PICK, default: 'prod' }, undefined, 1).result).toEqual({ answer: 'prod' });
    expect(newRow('ask', { id: 'q', type: 'ask', question: 'Why?' }, undefined, 1).result).toEqual({
      answer: '(simulated answer)',
    });
  });

  it('says what Simulate answers without results', () => {
    expect(defaultsText('ask', undefined, PICK)).toBe("Without results, Simulate answers 'dev'.");
    expect(defaultsText('ask', undefined, NOTES)).toBe(
      "Without results, Simulate answers 'Routine release'.",
    );
  });

  it('offers only literal choices in the list', () => {
    expect(answerChoices(PICK)).toEqual(['dev', 'staging', 'prod']);
    expect(answerChoices({ ...PICK, choices: ['dev', '${{ inputs.env }}', ' dev ', 3, ''] })).toEqual([
      'dev',
    ]);
    expect(answerChoices(NOTES)).toEqual([]);
  });

  it('writes an answer, and leaves it out when it is empty', () => {
    const row = newRow('ask', PICK, undefined, 1);
    expect(setAnswer(row, 'prod').result).toEqual({ answer: 'prod' });
    expect(setAnswer(row, '').result).toEqual({});
  });
});

const FILE: SimulationFile = {
  version: 1,
  blocks: { 'pick-env': [{ answer: 'staging' }, { answer: 'prod' }] },
};

beforeEach(() => {
  resetPosted();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

function open(stepId: string, file: SimulationFile = FILE) {
  const utils = renderInspector({ doc: docFor(RELEASE_WORKFLOW_TEXT), selection: stepId });
  fromHost({ type: 'simulation', simulation: simulation(file) });
  return utils;
}

const section = () => screen.getByRole('button', { name: /^Simulation/ });
const call = (n: number) => screen.getByRole('group', { name: `Call ${n}` });
const mocks = () => posted('setSimulationMocks');
const idle = () =>
  act(() => {
    vi.advanceTimersByTime(350);
  });

describe('Simulation section of an ask block', () => {
  it('picks one of the choices for a call', () => {
    open('pick-env');
    const answer = within(call(1)).getByRole('button', { name: 'Answer' });
    expect(answer).toHaveTextContent('staging');
    fireEvent.click(answer);
    fireEvent.click(screen.getByRole('option', { name: 'prod' }));
    expect(mocks()).toEqual([
      { type: 'setSimulationMocks', stepId: 'pick-env', results: [{ answer: 'prod' }, { answer: 'prod' }] },
    ]);
  });

  it('takes an answer that is not a choice, typed into the list', () => {
    open('pick-env');
    fireEvent.click(within(call(2)).getByRole('button', { name: 'Answer' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter options' }), { target: { value: 'qa' } });
    fireEvent.click(screen.getByRole('option', { name: 'Answer "qa"' }));
    expect(mocks().at(-1)?.results).toEqual([{ answer: 'staging' }, { answer: 'qa' }]);
    expect(within(call(2)).getByRole('button', { name: 'Answer' })).toHaveTextContent('qa');
    expect(
      within(call(2)).getByText('Pick a choice, or type another answer to see the block fail.'),
    ).toBeInTheDocument();
  });

  it('explains the default and adds a result with it', () => {
    open('pick-env', { version: 1 });
    fireEvent.click(section());
    expect(screen.getByText("Without results, Simulate answers 'dev'.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add result' }));
    expect(mocks()).toEqual([
      { type: 'setSimulationMocks', stepId: 'pick-env', results: [{ answer: 'dev' }] },
    ]);
  });

  it('types the answer of a free-text question', () => {
    open('release-notes', { version: 1, blocks: { 'release-notes': [{ answer: 'Routine release' }] } });
    const input = within(call(1)).getByRole('textbox', { name: 'Answer' });
    expect(input).toHaveValue('Routine release');
    fireEvent.change(input, { target: { value: 'Hotfix for the voucher bug' } });
    idle();
    expect(mocks()).toEqual([
      {
        type: 'setSimulationMocks',
        stepId: 'release-notes',
        results: [{ answer: 'Hotfix for the voucher bug' }],
      },
    ]);
    fireEvent.change(input, { target: { value: '' } });
    idle();
    expect(input).toHaveAttribute('placeholder', 'Routine release');
    expect(mocks().at(-1)?.results).toEqual([{}]);
  });
});
