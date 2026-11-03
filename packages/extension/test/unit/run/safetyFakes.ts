import { vi } from 'vitest';
import * as vscode from 'vscode';
import type { RunEditJournal } from '../../../src/safety/editJournal';
import type { RunReviewService } from '../../../src/safety/reviewService';
import type { BeginOptions, RunSafety, SafetySession } from '../../../src/safety/runSafety';

export interface FakeSafetyOptions {
  canIsolate?: boolean;
  /** Files the run "changed" (the count finish resolves with). */
  changed?: number;
  /** begin rejects with this message. */
  beginError?: string;
}

/** Run safety without git or files: records the calls the run manager makes. */
export function fakeSafety(options: FakeSafetyOptions = {}) {
  const journal = {
    runId: '',
    ready: Promise.resolve(),
    beforeWrite: vi.fn(async () => undefined),
    entries: () => [],
    original: async () => undefined,
    seal: async () => undefined,
    sealedHash: () => undefined,
    isSymlink: () => false,
    hadUnsavedChanges: () => false,
  } satisfies RunEditJournal;
  const reviews = {
    onDidChange: new vscode.EventEmitter<{ runId: string; workflowUri: string }>().event,
    get: vi.fn(async () => undefined),
    decide: vi.fn(async () => undefined),
    openDiff: vi.fn(async () => undefined),
    contentProvider: { provideTextDocumentContent: () => '' },
  } as unknown as RunReviewService;
  const sessions: (SafetySession & { options: BeginOptions })[] = [];
  const order: string[] = [];
  const safety = {
    reviews,
    canIsolate: vi.fn(async () => options.canIsolate ?? true),
    begin: vi.fn(async (begin: BeginOptions) => {
      order.push('begin');
      if (options.beginError) throw new Error(options.beginError);
      const session = {
        options: begin,
        runId: begin.runId,
        root: begin.isolation === 'worktree' ? `/storage/worktrees/${begin.runId}` : begin.folder,
        journal,
        finish: vi.fn(async (_finish?: { skipSnapshot?: boolean }) => {
          order.push('finish');
          return options.changed ?? 0;
        }),
        publish: vi.fn(async () => void order.push('publish')),
        discard: vi.fn(async () => void order.push('discard')),
      };
      sessions.push(session);
      return session;
    }),
    cleanup: vi.fn(async () => undefined),
    whenIdle: async () => undefined,
    dispose: vi.fn(),
  } satisfies RunSafety;
  return { safety, journal, sessions, order };
}
