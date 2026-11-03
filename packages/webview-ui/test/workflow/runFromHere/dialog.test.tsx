import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowInput } from '@isar-flow/core';
import { InputsDialog } from '../../../src/views/workflow/topbar/InputsDialog';
import { patchEditorState, readEditorState } from '../../../src/views/workflow/viewState';

const URI = 'file:///w/review-loop.workflow.yaml';
const INPUTS: [string, WorkflowInput][] = [
  ['task', { type: 'string', required: true }],
  ['dryRun', { type: 'boolean' }],
];

let stored: unknown;
vi.mock('../../../src/vscode', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/vscode')>()),
  getViewState: () => stored,
  setViewState: (state: unknown) => {
    stored = state;
  },
}));

beforeEach(() => {
  stored = undefined;
  patchEditorState({ runInputs: { [URI]: { task: 'Remembered task', dryRun: false } } });
});

describe('inputs dialog modes', () => {
  it('runs with the remembered values and remembers new ones', () => {
    const onRun = vi.fn();
    render(<InputsDialog workflowName="Review" uri={URI} inputs={INPUTS} onRun={onRun} onClose={vi.fn()} />);
    const dialog = screen.getByRole('dialog', { name: 'Run Review' });
    expect(within(dialog).getByRole('textbox')).toHaveValue('Remembered task');
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'New task' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Run workflow' }));
    expect(onRun).toHaveBeenCalledWith({ task: 'New task', dryRun: false });
    expect(readEditorState().runInputs?.[URI]).toEqual({ task: 'New task', dryRun: false });
  });

  it('simulates with the same remembered values and says that nothing runs', () => {
    const onRun = vi.fn();
    render(
      <InputsDialog
        mode="simulate"
        workflowName="Review"
        uri={URI}
        inputs={INPUTS}
        onRun={onRun}
        onClose={vi.fn()}
      />,
    );
    const dialog = screen.getByRole('dialog', { name: 'Simulate Review' });
    expect(
      within(dialog).getByText(
        'Nothing runs: commands, agents and approvals use the mocks of the simulation file.',
      ),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('textbox')).toHaveValue('Remembered task');
    const button = within(dialog).getByRole('button', { name: 'Simulate' });
    expect(button.querySelector('.codicon-beaker')).not.toBeNull();
    fireEvent.click(button);
    expect(onRun).toHaveBeenCalledWith({ task: 'Remembered task', dryRun: false });
  });

  it('runs from a block with the inputs of that run, notes and warnings, and keeps the remembered values', () => {
    const onRun = vi.fn();
    render(
      <InputsDialog
        mode="resume"
        workflowName="Review"
        blockName="tests"
        uri={URI}
        inputs={INPUTS}
        values={{ task: 'Task of run 3', dryRun: true }}
        notes={{
          info: ['Blocks before tests reuse the results of the run from 5 min ago.'],
          warnings: ['implement changed since that run, so its result may be outdated.'],
        }}
        onRun={onRun}
        onClose={vi.fn()}
      />,
    );
    const dialog = screen.getByRole('dialog', { name: 'Run from tests' });
    expect(within(dialog).getByRole('textbox')).toHaveValue('Task of run 3');
    expect(within(dialog).getByRole('switch')).toBeChecked();
    expect(
      within(dialog).getByText('Blocks before tests reuse the results of the run from 5 min ago.'),
    ).toBeInTheDocument();
    const warning = within(dialog).getByRole('status');
    expect(warning).toHaveTextContent('Check before running');
    expect(warning).toHaveTextContent('implement changed since that run, so its result may be outdated.');
    const button = within(dialog).getByRole('button', { name: 'Run from here' });
    expect(button.querySelector('.codicon-run-below')).not.toBeNull();
    fireEvent.click(button);
    expect(onRun).toHaveBeenCalledWith({ task: 'Task of run 3', dryRun: true });
    expect(readEditorState().runInputs?.[URI]).toEqual({ task: 'Remembered task', dryRun: false });
  });

  it('shows why a run cannot continue and does not start it', () => {
    const onRun = vi.fn();
    render(
      <InputsDialog
        mode="resume"
        workflowName="Review"
        blockName="tests"
        uri={URI}
        inputs={[]}
        blocker="This block isn't in the workflow anymore."
        onRun={onRun}
        onClose={vi.fn()}
      />,
    );
    const dialog = screen.getByRole('dialog', { name: 'Run from tests' });
    expect(within(dialog).getByRole('alert')).toHaveTextContent("This block isn't in the workflow anymore.");
    expect(within(dialog).getByRole('button', { name: 'Run from here' })).toBeDisabled();
    // Without inputs the focus starts on Cancel, inside the dialog.
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
  });

  it('closes on Cancel', () => {
    const onClose = vi.fn();
    render(
      <InputsDialog
        mode="resume"
        workflowName="Review"
        blockName="tests"
        uri={URI}
        inputs={[]}
        onRun={vi.fn()}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
