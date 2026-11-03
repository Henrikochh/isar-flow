import { describe, expect, it } from 'vitest';
import {
  applyWorkflowOps,
  reduceRunEvent,
  type RunReview,
  type RunView,
  type WorkflowOp,
} from '@isar-flow/core';
import { reviewFixture } from '../../harness/reviews';
import {
  initialWorkflowUiState,
  workflowUiReducer,
  type WorkflowUiAction,
  type WorkflowUiState,
} from '../../src/views/workflow/store';
import { docFor, REVIEW_TEXT } from './canvas/helpers';

const SET_PROMPT: WorkflowOp = { op: 'updateStep', stepId: 'implement', set: { prompt: 'Ship it' } };

const run = (state: WorkflowUiState, ...actions: WorkflowUiAction[]) =>
  actions.reduce(workflowUiReducer, state);

function promptOf(state: WorkflowUiState): unknown {
  return (state.doc?.workflow?.steps.find((s) => s.id === 'implement') as { prompt?: unknown } | undefined)
    ?.prompt;
}

describe('workflow store: edits before the host answers', () => {
  const opened = run(initialWorkflowUiState, { type: 'document', doc: docFor(REVIEW_TEXT) });
  const edited = run(opened, { type: 'localOps', ops: [SET_PROMPT] });
  const editedText = applyWorkflowOps(REVIEW_TEXT, [SET_PROMPT]).text;

  it('shows an edit at once, so the next edit builds on it', () => {
    expect(promptOf(edited)).toBe('Ship it');
    expect(edited.doc?.text).toBe(editedText);
  });

  it('keeps the edit while the host re-sends the old text, and settles when the host confirms it', () => {
    const revalidated = run(edited, { type: 'document', doc: docFor(REVIEW_TEXT) });
    expect(promptOf(revalidated)).toBe('Ship it');
    const confirmed = run(revalidated, { type: 'document', doc: docFor(editedText) });
    expect(promptOf(confirmed)).toBe('Ship it');
    expect(confirmed.pending).toEqual([]);
  });

  it('shows the host document when the text changed elsewhere', () => {
    const external = REVIEW_TEXT.replace('npm test', 'npm run test:unit');
    const next = run(edited, { type: 'document', doc: docFor(external) });
    expect(next.doc?.text).toBe(external);
    expect(next.pending).toEqual([]);
  });

  it('goes back to the host document when the host could not apply the edit', () => {
    const failed = run(edited, { type: 'opsFailed', error: 'The file changed on disk.' });
    expect(failed.doc?.text).toBe(REVIEW_TEXT);
    expect(failed.opsError).toBe('The file changed on disk.');
  });

  it('selects the old id again when the host refuses a rename', () => {
    const rename: WorkflowOp = { op: 'renameStep', stepId: 'tests', newId: 'unit_tests' };
    const renamed = run(
      opened,
      { type: 'select', stepId: 'tests' },
      { type: 'localOps', ops: [rename] },
      { type: 'select', stepId: 'unit_tests' },
      { type: 'localOps', ops: [{ op: 'renameStep', stepId: 'unit_tests', newId: 'checks' }] },
      { type: 'select', stepId: 'checks' },
    );
    expect(renamed.selection).toBe('checks');
    const failed = run(renamed, { type: 'opsFailed', error: 'The file changed on disk.' });
    expect(failed.selection).toBe('tests');

    // Once the host has written the rename, a later failure keeps the new id.
    const confirmed = run(
      opened,
      { type: 'localOps', ops: [rename] },
      { type: 'select', stepId: 'unit_tests' },
      { type: 'document', doc: docFor(applyWorkflowOps(REVIEW_TEXT, [rename]).text) },
      { type: 'localOps', ops: [SET_PROMPT] },
      { type: 'opsFailed', error: 'The file changed on disk.' },
    );
    expect(confirmed.selection).toBe('unit_tests');
  });

  it('clears the selection of a block that an edit removed', () => {
    const selected = run(opened, { type: 'select', stepId: 'tests' });
    const deleted = run(selected, { type: 'localOps', ops: [{ op: 'deleteStep', stepId: 'tests' }] });
    expect(deleted.selection).toBeNull();
  });

  it('leaves the document alone for edits the webview cannot apply', () => {
    const next = run(opened, { type: 'localOps', ops: [{ op: 'deleteStep', stepId: 'nope' }] });
    expect(next.doc).toBe(opened.doc);
    expect(next.pending).toEqual([]);
  });
});

describe('workflow store: review of the shown run', () => {
  const view = (runId: string): RunView =>
    reduceRunEvent(null, { type: 'run-start', runId, workflowName: 'W', startedAt: 0, inputs: {} });
  const shown = (runId: string, live = false) =>
    run(initialWorkflowUiState, { type: 'run', run: view(runId), live });
  const review = (runId: string): RunReview => reviewFixture(runId);

  it('keeps a review for the shown run and drops it when the host sends null', () => {
    const withReview = run(shown('run-7'), { type: 'review', review: review('run-7') });
    expect(withReview.review?.runId).toBe('run-7');
    expect(run(withReview, { type: 'review', review: null }).review).toBeNull();
  });

  it('does not show a review of another run', () => {
    const next = run(shown('run-7'), { type: 'review', review: review('run-3') });
    expect(next.review).toBeNull();
  });

  it('shows a review that arrived before its run once the run is shown', () => {
    const early = run(initialWorkflowUiState, { type: 'review', review: review('run-7') });
    expect(early.review).toBeNull();
    const next = run(early, { type: 'run', run: view('run-7'), live: false });
    expect(next.review?.runId).toBe('run-7');
    // A review parked for one run is not shown for another.
    const other = run(early, { type: 'run', run: view('run-3'), live: false });
    expect(other.review).toBeNull();
  });

  it('keeps the review when the same run is sent again and clears it for another run', () => {
    const withReview = run(shown('run-7'), { type: 'review', review: review('run-7') });
    expect(run(withReview, { type: 'run', run: view('run-7'), live: false }).review?.runId).toBe('run-7');
    expect(run(withReview, { type: 'run', run: view('run-3'), live: false }).review).toBeNull();
    expect(run(withReview, { type: 'run', run: null, live: true }).review).toBeNull();
  });

  it('clears the review when a live run starts', () => {
    const withReview = run(shown('run-7'), { type: 'review', review: review('run-7') });
    const next = run(withReview, {
      type: 'runEvent',
      event: { type: 'run-start', runId: 'run-9', workflowName: 'W', startedAt: 5, inputs: {} },
    });
    expect(next.run?.runId).toBe('run-9');
    expect(next.review).toBeNull();
  });

  it('keeps the review of the live run while later events of that run arrive', () => {
    const live = run(shown('run-9', true), { type: 'review', review: review('run-9') });
    const next = run(live, {
      type: 'runEvent',
      event: {
        type: 'run-end',
        runId: 'run-9',
        status: 'success',
        durationMs: 10,
        usage: { inputTokens: 0, outputTokens: 0 },
      },
    });
    expect(next.review?.runId).toBe('run-9');
  });
});

describe('workflow store: a start asked for outside the top bar', () => {
  it('keeps the requested mode until the top bar takes it', () => {
    const asked = run(initialWorkflowUiState, { type: 'requestStart', mode: 'simulate' });
    expect(asked.startRequest).toBe('simulate');
    expect(run(asked, { type: 'clearStartRequest' }).startRequest).toBeNull();
  });
});
