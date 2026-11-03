import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AskPrompt } from '@isar-flow/core';
import { RELEASE_WORKFLOW_TEXT } from '../../../harness/fixtures';
import { card, clearPosted, docFor, host, posted, renderEditor, stubLayout } from '../canvas/helpers';

vi.mock('../../../src/views/workflow/inspector/Inspector', () => ({
  Inspector: () => <aside aria-label="Inspector" />,
}));

beforeAll(stubLayout);
afterEach(() => vi.useRealTimers());

const PICK: AskPrompt = {
  requestId: 'ask-1',
  runId: 'run-1',
  stepId: 'pick-env',
  question: 'Which environment should I deploy to?',
  choices: ['dev', 'staging', 'prod'],
  default: 'dev',
};

const NOTES: AskPrompt = {
  requestId: 'ask-2',
  runId: 'run-1',
  stepId: 'release-notes',
  question: 'What should the release notes say?\nOne line is enough.',
  default: 'Routine release',
};

const open = () => renderEditor(docFor(RELEASE_WORKFLOW_TEXT));
const banner = (name = /^Question/) => screen.getByRole('status', { name });

describe('ask block on the canvas', () => {
  it('shows the question and the choices on the card, the default marked', () => {
    const { container } = open();
    const pick = card(container, 'pick-env');
    expect(within(pick).getByText('Ask')).toBeInTheDocument();
    expect(within(pick).getByText('Which environment should I deploy to?')).toBeInTheDocument();
    const chips = Array.from(pick.querySelectorAll('.wf-card__chips .if-chip')).map((c) => c.textContent);
    expect(chips).toEqual(['dev, default', 'staging', 'prod']);
    expect(within(pick).getByTitle('Default answer')).toHaveTextContent('dev');
    const notes = card(container, 'release-notes');
    expect(within(notes).getByText('Default: Routine release')).toBeInTheDocument();
  });

  it('shows four choices and counts the rest', () => {
    const text = RELEASE_WORKFLOW_TEXT.replace(
      '      - prod\n',
      '      - prod\n      - qa\n      - preview\n      - canary\n',
    );
    const { container } = renderEditor(docFor(text));
    const chips = Array.from(card(container, 'pick-env').querySelectorAll('.wf-card__chips .if-chip'));
    expect(chips.map((c) => c.textContent)).toEqual(['dev, default', 'staging', 'prod', 'qa', '+2 more']);
  });
});

describe('ask card above the canvas', () => {
  it('answers with a choice button and marks the waiting block', () => {
    const { container } = open();
    host({ type: 'askRequest', prompt: PICK });
    const question = banner();
    expect(within(question).getByText('Which environment should I deploy to?')).toBeInTheDocument();
    expect(card(container, 'pick-env').className).toContain('wf-card--awaiting');
    expect(within(question).getByRole('button', { name: 'dev, default' })).toHaveClass('if-btn--primary');
    clearPosted();
    fireEvent.click(within(question).getByRole('button', { name: 'staging' }));
    expect(posted()).toEqual([{ type: 'answer', requestId: 'ask-1', answer: 'staging' }]);
    expect(screen.queryByRole('status', { name: /^Question/ })).toBeNull();
    expect(card(container, 'pick-env').className).not.toContain('wf-card--awaiting');
  });

  it('selects the block from the link in its title', () => {
    const { container } = open();
    host({ type: 'askRequest', prompt: PICK });
    fireEvent.click(within(banner()).getByRole('button', { name: 'pick-env' }));
    expect(card(container, 'pick-env')).toHaveAttribute('aria-pressed', 'true');
  });

  it('offers a list and Answer for more than five choices', () => {
    open();
    const choices = ['dev', 'staging', 'prod', 'qa', 'preview', 'canary'];
    host({ type: 'askRequest', prompt: { ...PICK, choices, default: 'qa' } });
    const question = banner();
    expect(within(question).queryByRole('button', { name: 'staging' })).toBeNull();
    const list = within(question).getByRole('button', { name: 'Answer from the list' });
    expect(list).toHaveTextContent('qa');
    fireEvent.click(list);
    fireEvent.click(screen.getByRole('option', { name: 'canary' }));
    clearPosted();
    fireEvent.click(within(question).getByRole('button', { name: 'Answer' }));
    expect(posted()).toEqual([{ type: 'answer', requestId: 'ask-1', answer: 'canary' }]);
  });

  it('answers free text with Enter, prefilled with the default, and keeps the question as plain text', () => {
    open();
    host({ type: 'askRequest', prompt: NOTES });
    const question = banner();
    expect(within(question).getByText(/One line is enough/)).toHaveClass('wf-banner-message');
    const input = within(question).getByRole('textbox', { name: 'Answer' });
    expect(input).toHaveValue('Routine release');
    fireEvent.change(input, { target: { value: 'Faster checkout' } });
    clearPosted();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(posted()).toEqual([{ type: 'answer', requestId: 'ask-2', answer: 'Faster checkout' }]);
  });

  it('needs an answer when there is no default', () => {
    open();
    host({ type: 'askRequest', prompt: { ...NOTES, default: undefined } });
    const question = banner();
    const input = within(question).getByRole('textbox', { name: 'Answer' });
    expect(input).toHaveValue('');
    expect(within(question).getByRole('button', { name: 'Answer' })).toBeDisabled();
    clearPosted();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(posted()).toEqual([]);
  });

  it('counts down to the timeout and says what happens then', () => {
    vi.useFakeTimers({ now: 1_000_000 });
    open();
    host({ type: 'askRequest', prompt: { ...PICK, expiresAt: 1_000_000 + 150_000 } });
    expect(within(banner()).getByText("Answer within 2:30; then 'dev' is used.")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(61_000));
    expect(within(banner()).getByText("Answer within 1:29; then 'dev' is used.")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(90_000));
    expect(within(banner()).getByText("Time is up; 'dev' is used.")).toBeInTheDocument();
  });

  it('says the block fails without a default', () => {
    vi.useFakeTimers({ now: 1_000_000 });
    open();
    host({ type: 'askRequest', prompt: { ...NOTES, default: undefined, expiresAt: 1_000_000 + 4_000_000 } });
    expect(within(banner()).getByText('Answer within 1:06:40; then the block fails.')).toBeInTheDocument();
  });

  it('marks the default choice with a check, not only a color, and names it for assistive tech', () => {
    open();
    host({ type: 'askRequest', prompt: PICK });
    const question = banner();
    const dev = within(question).getByRole('button', { name: 'dev, default' });
    expect(dev.querySelector('.codicon-check')).not.toBeNull();
    expect(within(question).getByRole('button', { name: 'staging' }).querySelector('.codicon')).toBeNull();
  });

  it('is pinned in the tone of approvals, so it matches the ring of the waiting block', () => {
    open();
    host({ type: 'askRequest', prompt: PICK });
    expect(banner()).toHaveClass('if-banner--success');
  });

  it('names the answer buttons by the question', () => {
    open();
    host({ type: 'askRequest', prompt: PICK });
    const group = within(banner()).getByRole('group', { name: 'Which environment should I deploy to?' });
    expect(within(group).getAllByRole('button')).toHaveLength(3);
  });

  it('takes the focus to the default answer when it arrives, so Enter answers with it', () => {
    open();
    host({ type: 'askRequest', prompt: PICK });
    const dev = within(banner()).getByRole('button', { name: 'dev, default' });
    expect(dev).toHaveFocus();
  });

  it('takes the focus to Answer when the choices are a list, the default already chosen', () => {
    open();
    const choices = ['dev', 'staging', 'prod', 'qa', 'preview', 'canary'];
    host({ type: 'askRequest', prompt: { ...PICK, choices, default: 'qa' } });
    const question = banner();
    expect(within(question).getByRole('button', { name: 'Answer' })).toHaveFocus();
    expect(within(question).getByRole('button', { name: 'Answer from the list' })).toHaveTextContent('qa');
  });

  it('selects the prefilled free text when it takes the focus, so typing replaces it', () => {
    open();
    host({ type: 'askRequest', prompt: NOTES });
    const input = within(banner()).getByRole<HTMLInputElement>('textbox', { name: 'Answer' });
    expect(input).toHaveFocus();
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 'Routine release'.length]);
  });

  it('leaves the focus alone while someone types elsewhere', () => {
    open();
    const field = document.createElement('input');
    document.body.append(field);
    field.focus();
    host({ type: 'askRequest', prompt: PICK });
    expect(field).toHaveFocus();
    field.remove();
  });

  it('moves the focus to the next question, then back to where it was', () => {
    const { container } = open();
    const pick = card(container, 'pick-env');
    pick.focus();
    host({ type: 'askRequest', prompt: PICK });
    host({ type: 'askRequest', prompt: NOTES });
    expect(within(banner(/^Question pick-env/)).getByRole('button', { name: 'dev, default' })).toHaveFocus();
    fireEvent.click(within(banner(/^Question pick-env/)).getByRole('button', { name: 'staging' }));
    expect(within(banner()).getByRole('textbox', { name: 'Answer' })).toHaveFocus();
    fireEvent.keyDown(within(banner()).getByRole('textbox', { name: 'Answer' }), { key: 'Enter' });
    expect(screen.queryByRole('status', { name: /^Question/ })).toBeNull();
    expect(pick).toHaveFocus();
  });

  it('shows two questions at once and removes the one the host resolved', () => {
    open();
    host({ type: 'askRequest', prompt: PICK });
    host({ type: 'askRequest', prompt: NOTES });
    expect(screen.getAllByRole('status', { name: /^Question/ })).toHaveLength(2);
    host({ type: 'askResolved', requestId: 'ask-1' });
    const left = screen.getAllByRole('status', { name: /^Question/ });
    expect(left).toHaveLength(1);
    expect(within(left[0]).getByText(/What should the release notes say/)).toBeInTheDocument();
  });
});
