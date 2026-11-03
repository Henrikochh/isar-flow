import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import type { AgentStore, ModelRegistry, RunConsoleCommand, RunManagerDeps } from '../../../src/contracts';
import { createRunHistory } from '../../../src/run/history';
import { createRunManager, type RunManagerUi } from '../../../src/run/runManager';
import { gitIn, hasGit, initRepo, removeTempDirs, tempDir } from '../safety/gitRepo';
import { FakeMemento, FakeSecretStorage, FakeTerminal, fakeSimulations, flush, memoryStore } from './fakes';

const describeGit = hasGit ? describe : describe.skip;

const WORKFLOW = `version: 1
name: Build
steps:
  - id: build
    type: console
    run: write the file
`;

afterAll(removeTempDirs);

describeGit('run manager with the safety net', { timeout: 60_000 }, () => {
  it('snapshots the folder by default and reviews what a console command changed', async () => {
    const repo = initRepo({ 'a.txt': 'a\n' });
    const storage = tempDir('isar-storage-');
    const writeFile: RunConsoleCommand = async (options) => {
      fs.writeFileSync(path.join(options.cwd, 'a.txt'), 'changed\n');
      return { exitCode: 0, stdout: '', stderr: '', output: '', timedOut: false };
    };
    const deps: RunManagerDeps = {
      context: {
        workspaceState: new FakeMemento(),
        globalState: new FakeMemento(),
        secrets: new FakeSecretStorage(),
        subscriptions: [],
        storageUri: vscode.Uri.file(storage),
      } as unknown as vscode.ExtensionContext,
      models: { catalog: () => ({ models: [], providers: [], loading: false }) } as unknown as ModelRegistry,
      agents: { definitions: () => ({}) } as unknown as AgentStore,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as vscode.LogOutputChannel,
      runCommand: writeFile,
      tools: vi.fn(() => ({ execute: async () => ({ content: '' }) })),
      terminalFor: () => new FakeTerminal(),
      readContextFiles: async () => [],
    };
    const notifications: string[] = [];
    const ui: Partial<RunManagerUi> = {
      isTrusted: () => true,
      readText: async () => WORKFLOW,
      setting: <T>(_key: string, fallback: T) => fallback,
      workspaceFolder: () => repo,
      workspaceRoot: () => repo,
      confirmCommands: async () => 'Run',
      showInfo: async (message: string) => {
        notifications.push(message);
        return undefined;
      },
      createStatusItem: () => ({ text: '', show: () => undefined, dispose: () => undefined }),
    };
    const history = createRunHistory(memoryStore(), new FakeMemento(), () => 50);
    const manager = createRunManager(deps, { ui, history, env: {}, simulations: fakeSimulations() });
    const uri = vscode.Uri.file(path.join(repo, 'build.workflow.yaml'));
    const finished: string[][] = [];
    manager.onDidFinish((run) => finished.push(run.changedFiles));

    const runId = (await manager.start(uri)) as string;
    expect((await manager.whenFinished(runId))?.status).toBe('success');
    const review = await manager.reviews?.get(runId);
    expect(review?.files).toEqual([
      {
        path: 'a.txt',
        status: 'modified',
        additions: 1,
        deletions: 1,
        stepIds: [],
        decision: 'pending',
        revertible: true,
      },
    ]);
    expect(history.list()[0].review).toEqual({ total: 1, kept: 0, reverted: 0, pending: 1 });
    await flush();
    // No editor of the workflow is visible, so the notification tells the whole outcome.
    expect(notifications.some((m) => /^Build succeeded in \S+ and changed 1 file\.$/.test(m))).toBe(true);
    expect(finished).toEqual([[path.join(repo, 'a.txt')]]);
    expect(gitIn(repo, 'for-each-ref', '--format=%(refname)', 'refs/isarflow/')).toContain(`${runId}/before`);
    manager.dispose();
  });
});
