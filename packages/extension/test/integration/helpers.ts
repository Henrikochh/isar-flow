import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { RunEvent, RunView } from '@isar-flow/core';
import type { IsarFlowApi } from '../../src/extension';

export const EXTENSION_ID = 'isarflow.isar-flow';

/** Activates the extension under test and waits until both stores have indexed the workspace. */
export async function activateApi(): Promise<IsarFlowApi> {
  const extension = vscode.extensions.getExtension<IsarFlowApi>(EXTENSION_ID);
  assert.ok(extension, `The extension ${EXTENSION_ID} is not loaded in the test instance.`);
  const api = await extension.activate();
  await Promise.all([api.agents.ready, api.workflows.ready]);
  return api;
}

export function workspaceFolder(): vscode.Uri {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, 'The test instance has no workspace folder open.');
  return folder.uri;
}

/** URI of a workflow as the workflow store reports it (the key runs and history use). */
export async function workflowUri(api: IsarFlowApi, relativePath: string): Promise<vscode.Uri> {
  const summary = await waitFor(
    () => api.workflows.list().find((w) => w.relativePath === relativePath),
    `workflow ${relativePath} in the index`,
  );
  return vscode.Uri.parse(summary.uri);
}

/** Polls until `probe` returns a value other than undefined/false. */
export async function waitFor<T>(
  probe: () => T | undefined | false | Promise<T | undefined | false>,
  description: string,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${description}.`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export interface FinishedRun {
  runId: string;
  view: RunView;
  events: RunEvent[];
}

/** Starts a run with the given inputs and waits until it has ended and is saved to the history. */
export async function runToEnd(
  api: IsarFlowApi,
  uri: vscode.Uri,
  inputs: Record<string, unknown> = {},
  onEvent?: (event: RunEvent, runId: string | undefined) => void,
): Promise<FinishedRun> {
  const key = uri.toString();
  const events: RunEvent[] = [];
  let runId: string | undefined;
  const subscription = api.runs.onEvent(({ workflowUri, event }) => {
    if (workflowUri !== key) return;
    events.push(event);
    onEvent?.(event, runId);
  });
  try {
    runId = await api.runs.start(uri, inputs);
    assert.ok(runId, `The run of ${uri.path} did not start.`);
    const view = await api.runs.whenFinished(runId);
    assert.ok(view, `The run ${runId} has no final view.`);
    return { runId, view, events: events.filter((e) => e.runId === runId) };
  } finally {
    subscription.dispose();
  }
}

export function stepEnd(events: RunEvent[], stepId: string): Extract<RunEvent, { type: 'step-end' }> {
  const ends = events.filter(
    (e): e is Extract<RunEvent, { type: 'step-end' }> => e.type === 'step-end' && e.stepId === stepId,
  );
  assert.ok(ends.length > 0, `Block ${stepId} never ended.`);
  return ends[ends.length - 1];
}

export async function closeAllEditors(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
}
