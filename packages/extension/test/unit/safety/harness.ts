import fs from 'node:fs';
import path from 'node:path';
import { vi } from 'vitest';
import * as vscode from 'vscode';
import type { ReviewCounts, RunRecordSummary, WorkflowIsolation } from '@isar-flow/core';
import type { RunHistory } from '../../../src/contracts';
import { createRunSafety, type RunSafety, type SafetySession } from '../../../src/safety/runSafety';
import type { ReviewUi, WorkspaceFiles } from '../../../src/safety/reviewService';
import { readIfFile } from '../../../src/safety/util';
import { silentLog, tempDir } from './gitRepo';

export const WORKFLOW_URI = 'file:///ws/.isarflow/workflows/fix.workflow.yaml';

/** History with the parts the safety services use; `add` saves a run record. */
export function fakeHistory() {
  const records: RunRecordSummary[] = [];
  const removed = new vscode.EventEmitter<{ workflowUri: string; runIds: string[] }>();
  const changed = new vscode.EventEmitter<void>();
  const setReview = vi.fn(async (runId: string, counts: ReviewCounts) => {
    const record = records.find((r) => r.runId === runId);
    if (record) record.review = counts;
  });
  const history = {
    onDidChange: changed.event,
    onDidRemove: removed.event,
    list: (workflowUri?: string) => records.filter((r) => !workflowUri || r.workflowUri === workflowUri),
    get: () => undefined,
    getAsync: async () => undefined,
    save: async () => undefined,
    setReview,
  } satisfies RunHistory;
  const add = (runId: string, workflowUri = WORKFLOW_URI) =>
    records.push({ runId, workflowUri, workflowName: 'Fix', status: 'success', startedAt: records.length });
  return { history, records, removed, setReview, add };
}

/** Workspace file access on the real disk; `dirty` simulates open editors with unsaved text. */
export function nodeFiles() {
  const dirty = new Map<string, string>();
  const failWrites = new Set<string>();
  const files: WorkspaceFiles = {
    async current(absPath) {
      const text = dirty.get(path.resolve(absPath));
      return text !== undefined ? new TextEncoder().encode(text) : readIfFile(absPath);
    },
    async write(absPath, bytes) {
      if (failWrites.has(path.resolve(absPath))) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        throw new Error('The disk is full');
      }
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      fs.writeFileSync(absPath, bytes);
      dirty.delete(path.resolve(absPath));
    },
    async delete(absPath) {
      fs.rmSync(absPath, { force: true });
    },
  };
  return { files, dirty, failWrites };
}

/** Modal answers are taken from `answers` in order (undefined = Cancel). */
export function fakeReviewUi() {
  const asked: { message: string; detail?: string; buttons: string[] }[] = [];
  const answers: (string | undefined)[] = [];
  const infos: { message: string; buttons: string[] }[] = [];
  let infoAnswer: string | undefined;
  const ui: ReviewUi = {
    ask: async (message, detail, buttons) => {
      asked.push({ message, ...(detail !== undefined && { detail }), buttons });
      return answers.shift();
    },
    showInfo: async (message, ...buttons) => {
      infos.push({ message, buttons });
      return infoAnswer;
    },
    executeCommand: vi.fn(async () => undefined),
  };
  return {
    ui,
    asked,
    answers,
    infos,
    answerInfo: (value: string | undefined) => (infoAnswer = value),
  };
}

export function safetyHarness() {
  const storageDir = tempDir('isar-storage-');
  const log = silentLog();
  const history = fakeHistory();
  const files = nodeFiles();
  const ui = fakeReviewUi();
  const safety: RunSafety = createRunSafety({
    storageDir,
    log,
    history: history.history,
    files: files.files,
    ui: ui.ui,
  });
  const changes: { runId: string; workflowUri: string }[] = [];
  safety.reviews.onDidChange((change) => changes.push(change));

  /** Runs `work` between the before and after snapshot and saves the run to the history. */
  async function run(
    folder: string,
    runId: string,
    work: (session: SafetySession) => void | Promise<void>,
    isolation: WorkflowIsolation = 'workspace',
  ) {
    const session = await safety.begin({ runId, workflowUri: WORKFLOW_URI, folder, isolation });
    await work(session);
    const count = await session.finish();
    history.add(runId);
    await session.publish();
    return { session, count };
  }

  return { storageDir, log, history, files, ui, safety, changes, run };
}
