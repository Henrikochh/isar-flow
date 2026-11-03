import { fireEvent, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AskPrompt, RunView, StepRunView } from '@isar-flow/core';
import { RELEASE_WORKFLOW_TEXT } from '../../../harness/fixtures';
import { docFor, fromHost, posted, renderInspector, resetPosted } from '../inspector/helpers';

beforeEach(resetPosted);

const PROMPT: AskPrompt = {
  requestId: 'ask-1',
  runId: 'run-1',
  stepId: 'pick-env',
  question: 'Which environment should I deploy to?',
  choices: ['dev', 'staging', 'prod'],
  default: 'dev',
};

function runWith(
  steps: Record<string, Partial<StepRunView>>,
  status: RunView['status'] = 'running',
): RunView {
  const full: Record<string, StepRunView> = {};
  for (const [id, step] of Object.entries(steps))
    full[id] = { status: 'success', executions: 1, logs: [], ...step } as StepRunView;
  return {
    runId: 'run-1',
    workflowName: 'Release to an environment',
    status,
    startedAt: Date.now() - 5000,
    inputs: {},
    usage: { inputTokens: 0, outputTokens: 0 },
    steps: full,
  };
}

const open = (state: Parameters<typeof renderInspector>[0]) =>
  renderInspector({ doc: docFor(RELEASE_WORKFLOW_TEXT), runLive: true, ...state });

describe('ask block run output', () => {
  it('shows the waiting question with the answer buttons', () => {
    open({
      selection: 'pick-env',
      run: runWith({ 'pick-env': { status: 'running', detail: PROMPT.question, startedAt: Date.now() } }),
      asks: [PROMPT],
    });
    expect(screen.getByText('Waiting for your answer')).toBeInTheDocument();
    const question = screen.getByRole('status', { name: 'Question' });
    fireEvent.click(within(question).getByRole('button', { name: 'prod' }));
    expect(posted()).toEqual([{ type: 'answer', requestId: 'ask-1', answer: 'prod' }]);
    expect(screen.queryByRole('status', { name: 'Question' })).toBeNull();
  });

  it('shows the question and the answer of a finished block', () => {
    open({
      selection: 'pick-env',
      run: runWith(
        {
          'pick-env': {
            detail: PROMPT.question,
            durationMs: 4000,
            output: { status: 'success', answer: 'staging', timedOut: false },
          },
        },
        'success',
      ),
    });
    expect(screen.getByText('Which environment should I deploy to?')).toBeInTheDocument();
    expect(screen.getByText('staging')).toHaveClass('wf-answer');
    expect(screen.queryByText('Default used')).toBeNull();
  });

  it('says when the default was used after the timeout', () => {
    open({
      selection: 'pick-env',
      run: runWith(
        { 'pick-env': { durationMs: 300_000, output: { status: 'success', answer: 'dev', timedOut: true } } },
        'success',
      ),
    });
    expect(screen.getByText('Default used')).toHaveAttribute(
      'title',
      'Nobody answered in time, so the default was used.',
    );
  });

  it('starts the next question of the same block with its own default, not the text typed before', () => {
    const notes: AskPrompt = {
      requestId: 'ask-2',
      runId: 'run-1',
      stepId: 'release-notes',
      question: 'What should the release notes say?',
      default: 'Routine release',
    };
    open({
      selection: 'release-notes',
      run: runWith({ 'release-notes': { status: 'running', startedAt: Date.now() } }),
      asks: [notes],
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Answer' }), { target: { value: 'Half typed' } });
    // The next question can arrive before the host says the first one is resolved.
    fromHost({ type: 'askRequest', prompt: { ...notes, requestId: 'ask-3', default: 'Second round' } });
    fromHost({ type: 'askResolved', requestId: 'ask-2' });
    expect(screen.getByRole('textbox', { name: 'Answer' })).toHaveValue('Second round');
  });

  it('names the wait in the run summary', () => {
    open({
      selection: null,
      run: runWith({ 'pick-env': { status: 'running', startedAt: Date.now() } }),
      asks: [PROMPT],
    });
    expect(screen.getByRole('heading', { name: 'Waiting for your answer' })).toBeInTheDocument();
  });
});
