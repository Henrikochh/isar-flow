import { describe, expect, it } from 'vitest';
import type { RunOrigin, RunView } from '@isar-flow/core';
import { finishNotice, noticeDuration, type FinishNoticeInput } from '../../../src/run/finishNotice';

function view(overrides: Partial<RunView> = {}): RunView {
  return {
    runId: 'run-1',
    workflowName: 'Build',
    status: 'success',
    startedAt: 0,
    durationMs: 123_000,
    inputs: {},
    usage: { inputTokens: 0, outputTokens: 0 },
    steps: {},
    ...overrides,
  };
}

const FAILED = view({ status: 'failure', error: "Block 'tests' failed: exit code 1" });
const CANCELLED = view({ status: 'cancelled' });

function notice(input: Partial<FinishNoticeInput> & { origin?: RunOrigin }) {
  return finishNotice({
    name: 'Build',
    view: view(),
    origin: { kind: 'manual' },
    simulated: false,
    changed: 0,
    editorVisible: false,
    ...input,
  });
}

const info = (message: string, ...buttons: string[]) => ({ kind: 'info', message, buttons });
const error = (message: string, ...buttons: string[]) => ({ kind: 'error', message, buttons });

describe('finishNotice', () => {
  describe.each([
    ['manual', { kind: 'manual' }],
    ['selection', { kind: 'selection' }],
  ] as const)('%s runs without a visible editor', (_label, origin) => {
    it('says a run succeeded and how long it took', () => {
      expect(notice({ origin })).toEqual(info('Build succeeded in 2m 3s.', 'Open run'));
    });

    it('says how many files a successful run changed', () => {
      expect(notice({ origin, changed: 3 })).toEqual(
        info('Build succeeded in 2m 3s and changed 3 files.', 'Review changes', 'Open run'),
      );
    });

    it('names the failed block and its error', () => {
      expect(notice({ origin, view: FAILED })).toEqual(
        error('Build failed at tests: exit code 1', 'Open run'),
      );
    });

    it('stays quiet about cancelled runs', () => {
      expect(notice({ origin, view: CANCELLED })).toBeUndefined();
    });
  });

  it('names the innermost block of nested failures and falls back to the run error', () => {
    const nested = view({
      status: 'failure',
      error: "Block 'loop' failed: Block 'inner' failed: boom\nmore",
    });
    expect(notice({ view: nested })?.message).toBe('Build failed at inner: boom more');
    const budget = view({ status: 'failure', error: 'The run used more than 1,000 tokens.' });
    expect(notice({ view: budget })?.message).toBe('Build failed: The run used more than 1,000 tokens.');
    expect(notice({ view: view({ status: 'failure' }) })?.message).toBe('Build failed.');
  });

  it('cuts long errors', () => {
    const long = view({ status: 'failure', error: `Block 'a' failed: ${'x'.repeat(400)}` });
    const message = notice({ view: long })?.message ?? '';
    expect(message.length).toBeLessThan(260);
    expect(message.endsWith('…')).toBe(true);
  });

  it('trigger runs notify only failures and changes', () => {
    const origin: RunOrigin = { kind: 'trigger', trigger: 'save', file: 'src/a.ts' };
    expect(notice({ origin })).toBeUndefined();
    expect(notice({ origin, changed: 1 })).toEqual(
      info('Build succeeded in 2m 3s and changed 1 file.', 'Review changes', 'Open run'),
    );
    expect(notice({ origin, view: FAILED })).toEqual(error('Build failed at tests: exit code 1', 'Open run'));
    expect(notice({ origin, view: CANCELLED })).toBeUndefined();
  });

  it('Copilot runs notify only changed files (the chat shows the rest)', () => {
    const origin: RunOrigin = { kind: 'copilot' };
    expect(notice({ origin })).toBeUndefined();
    expect(notice({ origin, view: FAILED })).toBeUndefined();
    expect(notice({ origin, changed: 3 })).toEqual(info('Build changed 3 files.', 'Review changes'));
  });

  it('simulated runs say they finished or where they failed', () => {
    expect(notice({ simulated: true })).toEqual(info('Simulated run of Build finished.', 'Open run'));
    expect(notice({ simulated: true, view: FAILED })).toEqual(
      error('Simulated run of Build failed at tests.', 'Open run'),
    );
    expect(notice({ simulated: true, view: view({ status: 'failure' }) })?.message).toBe(
      'Simulated run of Build failed.',
    );
    expect(notice({ simulated: true, view: CANCELLED })).toBeUndefined();
  });

  it('with a visible editor only reports changed files', () => {
    expect(notice({ editorVisible: true })).toBeUndefined();
    expect(notice({ editorVisible: true, view: FAILED })).toBeUndefined();
    expect(notice({ editorVisible: true, changed: 2 })).toEqual(
      info('Build changed 2 files.', 'Review changes'),
    );
    expect(notice({ editorVisible: true, simulated: true })).toBeUndefined();
  });

  it('keeps the changed files notice for cancelled runs that changed files', () => {
    expect(notice({ view: CANCELLED, changed: 2 })).toEqual(info('Build changed 2 files.', 'Review changes'));
  });
});

describe('noticeDuration', () => {
  it.each([
    [400, '0.4s'],
    [9_400, '9.4s'],
    [42_300, '42s'],
    [123_000, '2m 3s'],
    [120_000, '2m'],
    [3_900_000, '1h 5m'],
    [7_200_000, '2h'],
  ])('%i ms is %s', (ms, text) => {
    expect(noticeDuration(ms)).toBe(text);
  });
});
