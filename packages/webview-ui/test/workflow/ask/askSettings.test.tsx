import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RELEASE_WORKFLOW_TEXT } from '../../../harness/fixtures';
import { docFor, fromHost, renderInspector, resetPosted, sentOps } from '../inspector/helpers';

beforeEach(() => {
  resetPosted();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

const open = (stepId: string) => renderInspector({ doc: docFor(RELEASE_WORKFLOW_TEXT), selection: stepId });

/** Lets drafts commit (they wait for a short pause in typing). */
const settle = () => act(() => vi.advanceTimersByTime(400));

const choiceInputs = () =>
  within(screen.getByRole('group', { name: 'Choices' })).getAllByRole('textbox') as HTMLInputElement[];

const answers = () => screen.getByRole('radiogroup', { name: 'Answers' });

describe('Ask settings', () => {
  it('shows the question, the choices and the default of a choice question', () => {
    open('pick-env');
    expect(screen.getByLabelText('Question')).toHaveValue('Which environment should I deploy to?');
    expect(within(answers()).getByRole('radio', { name: 'Choices' })).toHaveAttribute('aria-checked', 'true');
    expect(choiceInputs().map((input) => input.value)).toEqual(['dev', 'staging', 'prod']);
    expect(screen.getByRole('button', { name: 'Default answer' })).toHaveTextContent('dev');
  });

  it('lines the choices hint up with the fields, not indented like the hint of a switch', () => {
    open('pick-env');
    const hint = screen.getByText('Alt+Up and Alt+Down move a choice.');
    expect(hint).toHaveClass('if-field__hint');
    expect(hint).not.toHaveClass('wf-insp-switch-hint');
  });

  it('starts each block from its own answers, not from what was picked on the block selected before', () => {
    const text = RELEASE_WORKFLOW_TEXT.replace('    default: Routine release\n', '').replace(
      '  - id: deploy\n',
      '  - id: approver\n    type: ask\n    question: Who signs this off?\n  - id: deploy\n',
    );
    renderInspector({ doc: docFor(text), selection: 'release-notes' });
    fireEvent.click(within(answers()).getByRole('radio', { name: 'Choices' }));
    expect(screen.getByRole('group', { name: 'Choices' })).toBeInTheDocument();
    fromHost({ type: 'focusStep', stepId: 'approver' });
    expect(screen.getByLabelText('Question')).toHaveValue('Who signs this off?');
    expect(within(answers()).getByRole('radio', { name: 'Free text' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.queryByRole('group', { name: 'Choices' })).toBeNull();
    expect(sentOps()).toEqual([]);
  });

  it('commits the question', () => {
    open('pick-env');
    fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'Where should it go?' } });
    settle();
    expect(sentOps()).toEqual([
      { op: 'updateStep', stepId: 'pick-env', set: { question: 'Where should it go?' } },
    ]);
  });

  it('asks for a question when it is cleared and writes nothing', () => {
    open('pick-env');
    fireEvent.change(screen.getByLabelText('Question'), { target: { value: '  ' } });
    settle();
    expect(screen.getByText('Enter the question to ask.')).toBeInTheDocument();
    expect(sentOps()).toEqual([]);
  });

  it('adds a choice', () => {
    open('pick-env');
    fireEvent.click(screen.getByRole('button', { name: 'Add choice' }));
    const added = choiceInputs()[3];
    expect(added).toHaveFocus();
    fireEvent.change(added, { target: { value: 'qa' } });
    settle();
    expect(sentOps()).toEqual([
      { op: 'updateStep', stepId: 'pick-env', set: { choices: ['dev', 'staging', 'prod', 'qa'] } },
    ]);
  });

  it('removes the default together with its choice', () => {
    open('pick-env');
    fireEvent.click(screen.getByRole('button', { name: 'Remove choice dev' }));
    expect(sentOps()).toEqual([
      { op: 'updateStep', stepId: 'pick-env', set: { choices: ['staging', 'prod'] }, unset: ['default'] },
    ]);
  });

  it('renames the default together with its choice', () => {
    open('pick-env');
    fireEvent.change(choiceInputs()[0], { target: { value: 'development' } });
    settle();
    expect(sentOps()).toEqual([
      {
        op: 'updateStep',
        stepId: 'pick-env',
        set: { choices: ['development', 'staging', 'prod'], default: 'development' },
      },
    ]);
  });

  it('marks a choice that is listed twice and writes nothing', () => {
    open('pick-env');
    fireEvent.change(choiceInputs()[1], { target: { value: 'dev' } });
    settle();
    expect(screen.getByText("'dev' is listed twice.")).toBeInTheDocument();
    expect(sentOps()).toEqual([]);
  });

  it('moves a choice with Alt+Up and Alt+Down and keeps the focus on it', () => {
    open('pick-env');
    const dev = choiceInputs()[0];
    dev.focus();
    fireEvent.keyDown(dev, { key: 'ArrowDown', altKey: true });
    act(() => vi.runOnlyPendingTimers());
    expect(sentOps()).toEqual([
      { op: 'updateStep', stepId: 'pick-env', set: { choices: ['staging', 'dev', 'prod'] } },
    ]);
    expect(choiceInputs()[1]).toHaveValue('dev');
    expect(choiceInputs()[1]).toHaveFocus();
    fireEvent.keyDown(choiceInputs()[0], { key: 'ArrowUp', altKey: true });
    expect(sentOps()).toHaveLength(1);
  });

  it('chooses the default from the choices or none', () => {
    open('pick-env');
    fireEvent.click(screen.getByRole('button', { name: 'Default answer' }));
    fireEvent.click(screen.getByRole('option', { name: 'prod' }));
    fireEvent.click(screen.getByRole('button', { name: 'Default answer' }));
    fireEvent.click(screen.getByRole('option', { name: 'No default' }));
    expect(sentOps()).toEqual([
      { op: 'updateStep', stepId: 'pick-env', set: { default: 'prod' } },
      { op: 'updateStep', stepId: 'pick-env', set: {}, unset: ['default'] },
    ]);
  });

  it('switches to free text by removing the choices', () => {
    open('pick-env');
    fireEvent.click(within(answers()).getByRole('radio', { name: 'Free text' }));
    expect(sentOps()).toEqual([{ op: 'updateStep', stepId: 'pick-env', set: {}, unset: ['choices'] }]);
  });

  it('edits the default of a free text question', () => {
    open('release-notes');
    expect(within(answers()).getByRole('radio', { name: 'Free text' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    const input = screen.getByLabelText('Default answer');
    expect(input).toHaveValue('Routine release');
    fireEvent.change(input, { target: { value: '' } });
    settle();
    expect(sentOps()).toEqual([{ op: 'updateStep', stepId: 'release-notes', set: {}, unset: ['default'] }]);
  });

  it('turns the default into the first choice when switching to choices', () => {
    open('release-notes');
    fireEvent.click(within(answers()).getByRole('radio', { name: 'Choices' }));
    expect(sentOps()).toEqual([
      { op: 'updateStep', stepId: 'release-notes', set: { choices: ['Routine release'] } },
    ]);
  });

  it('switches to free text and back to choices, keeping the default as the first choice', () => {
    open('pick-env');
    fireEvent.click(within(answers()).getByRole('radio', { name: 'Free text' }));
    expect(screen.getByLabelText('Default answer')).toHaveValue('dev');
    fireEvent.click(within(answers()).getByRole('radio', { name: 'Choices' }));
    expect(choiceInputs().map((input) => input.value)).toEqual(['dev']);
    expect(sentOps()).toEqual([
      { op: 'updateStep', stepId: 'pick-env', set: {}, unset: ['choices'] },
      { op: 'updateStep', stepId: 'pick-env', set: { choices: ['dev'] } },
    ]);
  });

  it('starts an empty choice list without writing anything', () => {
    renderInspector({
      doc: docFor(RELEASE_WORKFLOW_TEXT.replace('    default: Routine release\n', '')),
      selection: 'release-notes',
    });
    fireEvent.click(within(answers()).getByRole('radio', { name: 'Choices' }));
    expect(choiceInputs()).toHaveLength(1);
    expect(choiceInputs()[0]).toHaveFocus();
    expect(sentOps()).toEqual([]);
    fireEvent.change(choiceInputs()[0], { target: { value: 'Yes' } });
    settle();
    expect(sentOps()).toEqual([{ op: 'updateStep', stepId: 'release-notes', set: { choices: ['Yes'] } }]);
  });

  it('explains the timeout in the advanced settings', () => {
    open('pick-env');
    fireEvent.click(screen.getByRole('button', { name: /Advanced/ }));
    const timeout = screen.getByLabelText('Timeout');
    expect(timeout).toHaveValue('300');
    expect(
      screen.getByText('Without an answer in time the default is used; without a default the block fails.'),
    ).toBeInTheDocument();
    fireEvent.change(timeout, { target: { value: '120' } });
    settle();
    expect(sentOps()).toEqual([{ op: 'updateStep', stepId: 'pick-env', set: { timeout: 120 } }]);
  });
});
