import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { parseWorkflowText, type RunRecordSummary } from '@isar-flow/core';
import type { AgentStore, RunHistory } from '../../../src/contracts';
import { createWorkflowStore, type IndexedWorkflowStore } from '../../../src/store/workflowStore';
import { fakeContext, fakeLog, installFakeWorkspace } from './fakeWorkspace';

const flow = (name: string, agent = 'coder') =>
  `version: 1\nname: ${name}\nsteps:\n  - id: a\n    type: agent\n    agent: ${agent}\n    prompt: Hi\n`;

function fakeHistory() {
  const changed = new vscode.EventEmitter<void>();
  const runs: RunRecordSummary[] = [];
  const history: RunHistory = {
    onDidChange: changed.event,
    list: (uri?: string) => runs.filter((r) => uri === undefined || r.workflowUri === uri),
    get: () => undefined,
    getAsync: async () => undefined,
    save: async () => undefined,
  };
  return { history, runs, changed };
}

function fakeAgents() {
  const ensure = vi.fn(async (_ids: ('coder' | 'reviewer')[]) => undefined);
  return { agents: { ensure } as unknown as AgentStore, ensure };
}

let store: IndexedWorkflowStore | undefined;
afterEach(() => store?.dispose());

async function open(history = fakeHistory().history, agents = fakeAgents().agents) {
  store = createWorkflowStore({ context: fakeContext(), log: fakeLog().log, agents, history });
  await store.ready;
  return store;
}

describe('workflow store', () => {
  it('indexes workflow files with relative paths and the last run', async () => {
    const ws = installFakeWorkspace(['/ws']);
    ws.fs
      .add('/ws/.isarflow/workflows/review.workflow.yaml', flow('Review'))
      .add('/ws/sub/build.workflow.yml', flow('Build', 'builder'))
      .add('/ws/node_modules/pkg/x.workflow.yaml', flow('Hidden'));
    const { history, runs } = fakeHistory();
    const run: RunRecordSummary = {
      runId: 'r1',
      workflowUri: 'file:///ws/sub/build.workflow.yml',
      workflowName: 'Build',
      status: 'success',
      startedAt: 5,
    };
    runs.push(run);
    const workflows = await open(history);

    expect(workflows.list()).toEqual([
      {
        uri: 'file:///ws/sub/build.workflow.yml',
        name: 'Build',
        relativePath: 'sub/build.workflow.yml',
        valid: true,
        stepCount: 1,
        lastRun: run,
      },
      {
        uri: 'file:///ws/.isarflow/workflows/review.workflow.yaml',
        name: 'Review',
        relativePath: '.isarflow/workflows/review.workflow.yaml',
        valid: true,
        stepCount: 1,
      },
    ]);
    expect(workflows.usersOfAgent('coder')).toEqual(['.isarflow/workflows/review.workflow.yaml']);
    expect(workflows.usersOfAgent('builder')).toEqual(['sub/build.workflow.yml']);
  });

  it('fires on history changes with the new last run', async () => {
    const ws = installFakeWorkspace(['/ws']);
    ws.fs.add('/ws/a.workflow.yaml', flow('A'));
    const { history, runs, changed } = fakeHistory();
    const workflows = await open(history);
    const listener = vi.fn();
    workflows.onDidChange(listener);
    runs.push({
      runId: 'r',
      workflowUri: 'file:///ws/a.workflow.yaml',
      workflowName: 'A',
      status: 'failure',
      startedAt: 1,
    });
    changed.fire();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(workflows.list()[0].lastRun?.runId).toBe('r');
  });

  it('follows file events, debounced, and ignores node_modules', async () => {
    const ws = installFakeWorkspace(['/ws']);
    const workflows = await open();
    const listener = vi.fn();
    workflows.onDidChange(listener);
    const watcher = ws.watchers.find((w) => w.pattern === '**/*.workflow.{yaml,yml}');
    if (!watcher) throw new Error('no workflow watcher');

    ws.fs.add('/ws/a.workflow.yaml', flow('A'));
    ws.fs.add('/ws/node_modules/b.workflow.yaml', flow('B'));
    watcher.create.fire(vscode.Uri.file('/ws/a.workflow.yaml'));
    watcher.create.fire(vscode.Uri.file('/ws/node_modules/b.workflow.yaml'));
    await vi.waitFor(() => expect(workflows.list().map((w) => w.name)).toEqual(['A']));

    ws.fs.add('/ws/a.workflow.yaml', flow('A renamed'));
    watcher.change.fire(vscode.Uri.file('/ws/a.workflow.yaml'));
    await vi.waitFor(() => expect(workflows.list().map((w) => w.name)).toEqual(['A renamed']));

    ws.fs.remove('/ws/a.workflow.yaml');
    watcher.delete.fire(vscode.Uri.file('/ws/a.workflow.yaml'));
    await vi.waitFor(() => expect(workflows.list()).toEqual([]));
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it('rescans when a folder holding workflows is deleted or moved', async () => {
    const ws = installFakeWorkspace(['/ws']);
    ws.fs.add('/ws/flows/a.workflow.yaml', flow('A')).add('/ws/flows/b.workflow.yaml', flow('B'));
    const workflows = await open();
    const deletions = ws.watchers.find((w) => w.pattern === '**/*');
    if (!deletions) throw new Error('no deletion watcher');

    ws.fs.remove('/ws/flows/a.workflow.yaml');
    ws.fs.remove('/ws/flows/b.workflow.yaml');
    ws.fs.add('/ws/moved/a.workflow.yaml', flow('A'));
    deletions.delete.fire(vscode.Uri.file('/ws/flows'));
    await vi.waitFor(() =>
      expect(workflows.list().map((w) => w.relativePath)).toEqual(['moved/a.workflow.yaml']),
    );
  });

  it('creates workflows from templates at a unique slug', async () => {
    const ws = installFakeWorkspace(['/ws']);
    ws.fs.add('/ws/.isarflow/workflows/review-until-approved.workflow.yaml', flow('Old'));
    const { agents, ensure } = fakeAgents();
    const workflows = await open(undefined, agents);

    const blank = await workflows.create('Größe check', 'blank');
    expect(blank.path).toBe('/ws/.isarflow/workflows/groesse-check.workflow.yaml');
    expect(ensure).not.toHaveBeenCalled();
    expect(parseWorkflowText(ws.fs.files.get(blank.path) ?? '').workflow?.name).toBe('Größe check');
    expect(workflows.list().map((w) => w.name)).toContain('Größe check');

    const review = await workflows.create('Review until approved', 'review-loop');
    expect(review.path).toBe('/ws/.isarflow/workflows/review-until-approved-2.workflow.yaml');
    expect(ensure).toHaveBeenCalledWith(['coder', 'reviewer'], expect.objectContaining({ path: '/ws' }));
    await workflows.create('', 'test-fix');
    expect(ws.fs.files.has('/ws/.isarflow/workflows/workflow.workflow.yaml')).toBe(true);
    expect(ensure).toHaveBeenCalledTimes(2);
  });

  it('creates workflows and their starter agents in the given workspace folder', async () => {
    const ws = installFakeWorkspace(['/ws', '/two']);
    const { agents, ensure } = fakeAgents();
    const workflows = await open(undefined, agents);

    const uri = await workflows.create('Loop', 'review-loop', vscode.Uri.file('/two'));
    expect(uri.path).toBe('/two/.isarflow/workflows/loop.workflow.yaml');
    expect(ws.fs.files.has(uri.path)).toBe(true);
    expect(ensure).toHaveBeenCalledWith(['coder', 'reviewer'], expect.objectContaining({ path: '/two' }));

    const fallback = await workflows.create('Other', 'blank', vscode.Uri.file('/elsewhere'));
    expect(fallback.path).toBe('/ws/.isarflow/workflows/other.workflow.yaml');
  });

  it('asks to open a folder when there is none', async () => {
    installFakeWorkspace([]);
    const workflows = await open();
    await expect(workflows.create('x', 'blank')).rejects.toThrow('Open a folder first to create workflows.');
  });

  it('disposes its watchers', async () => {
    const ws = installFakeWorkspace(['/ws']);
    const workflows = await open();
    workflows.dispose();
    store = undefined;
    expect(ws.watchers.length).toBeGreaterThan(0);
    expect(ws.watchers.every((w) => w.disposed)).toBe(true);
  });
});
