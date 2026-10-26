import { describe, expect, it } from 'vitest';
import { applyWorkflowOps, type WorkflowOp } from '@isar-flow/core';
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
