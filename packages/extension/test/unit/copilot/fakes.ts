import { vi } from 'vitest';
import * as vscode from 'vscode';
import type { RunEvent, RunView, WorkflowSummary } from '@isar-flow/core';
import type { RunStartOptions } from '../../../src/contracts';
import type { CopilotDeps } from '../../../src/copilot/copilotRun';
import { fakeReviews, fakeServices } from '../editors/fakes';
import { fakeGenerator, finishedView } from '../report/fakes';

export const RELEASE_URI = 'file:///w/.isarflow/workflows/release.workflow.yaml';
export const DOCS_URI = 'file:///w/docs.workflow.yaml';
export const HIDDEN_URI = 'file:///w/.isarflow/workflows/hidden.workflow.yaml';
export const BROKEN_URI = 'file:///w/broken.workflow.yaml';

export const RELEASE_TEXT = [
  'version: 1',
  'name: Release',
  'description: Ships a release.',
  'expose: true',
  'inputs:',
  '  version: { type: string, required: true, description: Version to release }',
  '  dryRun: { type: boolean, default: false }',
  'steps:',
  '  - id: tests',
  '    name: Unit tests',
  '    type: console',
  '    run: npm test',
  '  - id: publish',
  '    type: console',
  '    run: npm publish',
  '',
].join('\n');

const DOCS_TEXT = [
  'version: 1',
  'name: Docs',
  'expose: true',
  'steps:',
  '  - id: a',
  '    type: stop',
  '',
].join('\n');

const summary = (uri: string, name: string, overrides: Partial<WorkflowSummary> = {}): WorkflowSummary => ({
  uri,
  name,
  relativePath: uri.replace('file:///w/', ''),
  valid: true,
  stepCount: 1,
  exposed: true,
  ...overrides,
});

/** Run manager fakes for Copilot runs: start records its options, whenFinished answers from `finals`. */
export function copilotSetup() {
  const fake = fakeServices();
  const reviews = fakeReviews();
  const events = fake.emitters.runEvents;
  const finals: Record<string, RunView> = {};
  const behavior = {
    refusal: undefined as { reason: string; message: string } | undefined,
    runId: 'run-1',
    /** Fired between start and the end of the run. */
    during: [] as RunEvent[],
  };
  fake.state.workflows = [
    summary(RELEASE_URI, 'Release', { description: 'Ships a release.' }),
    summary(DOCS_URI, 'Docs'),
    summary(HIDDEN_URI, 'Hidden', { exposed: undefined }),
    summary(BROKEN_URI, 'Broken', { valid: false }),
  ];
  const texts: Record<string, string> = { [RELEASE_URI]: RELEASE_TEXT, [DOCS_URI]: DOCS_TEXT };
  const finished = new Map<string, (view: RunView | undefined) => void>();
  const runs = fake.services.runs;
  runs.start.mockImplementation(
    async (uri: vscode.Uri, _inputs?: Record<string, unknown>, options?: RunStartOptions) => {
      if (behavior.refusal) {
        options?.onRefused?.(behavior.refusal as never);
        return undefined;
      }
      const runId = behavior.runId;
      events.fire({
        workflowUri: uri.toString(),
        event: { type: 'run-start', runId, workflowName: 'Release', startedAt: 1, inputs: {} },
      });
      return runId;
    },
  );
  const whenFinished = vi.fn(
    (runId: string) =>
      new Promise<RunView | undefined>((resolve) => {
        finished.set(runId, resolve);
        queueMicrotask(() => {
          for (const event of behavior.during) events.fire({ workflowUri: RELEASE_URI, event });
          if (finals[runId]) resolve(finals[runId]);
        });
      }),
  );
  Object.assign(runs, { whenFinished, reviews: reviews.service });
  finals['run-1'] = finishedView('run-1');
  fake.state.history = [
    {
      runId: 'run-1',
      workflowUri: RELEASE_URI,
      workflowName: 'Release',
      status: 'success',
      startedAt: finishedView().startedAt,
      origin: { kind: 'copilot' },
    },
  ];
  const { generator, calls } = fakeGenerator();
  const trust = { trusted: true };
  const deps: CopilotDeps = {
    readText: vi.fn(async (uri: vscode.Uri) => {
      const text = texts[uri.toString()];
      if (text === undefined) throw new Error('ENOENT');
      return text;
    }),
    isTrusted: () => trust.trusted,
    generator,
  };
  /** Ends a run that whenFinished is waiting for. */
  const finish = (runId: string, view: RunView | undefined) => finished.get(runId)?.(view);
  return { ...fake, reviews, finals, behavior, texts, deps, calls, generator, trust, finish };
}

export function fakeToken() {
  const source = new vscode.CancellationTokenSource();
  return { token: source.token as unknown as vscode.CancellationToken, cancel: () => source.cancel() };
}

/** A chat response stream that records what the handler wrote. */
export function fakeStream() {
  const parts: { kind: 'markdown' | 'progress' | 'button'; value: unknown }[] = [];
  const stream = {
    markdown: vi.fn((value: string | vscode.MarkdownString) =>
      parts.push({ kind: 'markdown', value: typeof value === 'string' ? value : value.value }),
    ),
    progress: vi.fn((value: string) => parts.push({ kind: 'progress', value })),
    button: vi.fn((command: vscode.Command) => parts.push({ kind: 'button', value: command })),
  };
  const text = () =>
    parts
      .filter((part) => part.kind === 'markdown')
      .map((part) => String(part.value))
      .join('');
  const buttons = () =>
    parts.filter((part) => part.kind === 'button').map((part) => part.value as vscode.Command);
  const progress = () => parts.filter((part) => part.kind === 'progress').map((part) => String(part.value));
  return { stream, parts, text, buttons, progress };
}
