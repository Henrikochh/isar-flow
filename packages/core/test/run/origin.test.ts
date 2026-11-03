import { describe, expect, it } from 'vitest';
import type { RunEvent, RunOrigin } from '../../src/engine/types';
import { reduceRunEvent, runRecordSummary } from '../../src/run';
import { run, workflow } from '../engine/helpers';

const runStart = (extra: Partial<Extract<RunEvent, { type: 'run-start' }>> = {}): RunEvent => ({
  type: 'run-start',
  runId: 'run-1',
  workflowName: 'Docs check',
  startedAt: 100,
  inputs: {},
  ...extra,
});

describe('origin in run views and history records', () => {
  it('copies the origin of run-start into the view and the record summary', () => {
    const origin: RunOrigin = { kind: 'trigger', trigger: 'save', file: 'docs/a.md' };
    const view = reduceRunEvent(null, runStart({ origin }));
    expect(view.origin).toEqual(origin);
    const summary = runRecordSummary(view, 'file:///w/docs.workflow.yaml');
    expect(summary.origin).toEqual(origin);
    expect(summary.origin).not.toBe(view.origin);
  });

  it('keeps views and records of manual and older runs without origin', () => {
    const view = reduceRunEvent(null, runStart());
    expect(view).not.toHaveProperty('origin');
    expect(runRecordSummary(view, 'u')).not.toHaveProperty('origin');
  });

  it('keeps the origin through the run', async () => {
    const r = await run(workflow([{ id: 'a', type: 'console', run: 'echo' }]), { origin: { kind: 'cli' } });
    const view = r.events.reduce<ReturnType<typeof reduceRunEvent> | null>(reduceRunEvent, null);
    expect(view?.origin).toEqual({ kind: 'cli' });
    expect(view && runRecordSummary(view, 'u').origin).toEqual({ kind: 'cli' });
  });
});

describe('editor and git snapshot in run views', () => {
  it('keeps the recorded editor and git values in the view context', async () => {
    const r = await run(workflow([{ id: 'a', type: 'console', run: 'echo' }]), {
      editor: { selection: 'x', file: 'a.ts', language: 'typescript', line: 3 },
      git: { branch: 'main', changedFiles: ['a.ts'], diff: '' },
    });
    const view = r.events.reduce<ReturnType<typeof reduceRunEvent> | null>(reduceRunEvent, null);
    expect(view?.context?.editor).toEqual({ selection: 'x', file: 'a.ts', language: 'typescript', line: 3 });
    expect(view?.context?.git).toEqual({ branch: 'main', changedFiles: ['a.ts'], diff: '' });
  });
});
