import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import type { RunEvent } from '@isar-flow/core';
import type { IsarFlowApi } from '../../../src/extension';
import {
  activateApi,
  closeAllEditors,
  runToEnd,
  stepEnd,
  waitFor,
  workflowUri,
  workspaceFolder,
} from '../helpers';

const COUNTER = 'counter.txt';
const THIRD = 'third.txt';
const LOOP_LOG = 'loop.txt';
const RESUME_PATH = '.isarflow/workflows/build-faster-resume.workflow.yaml';
const LOOP_PATH = '.isarflow/workflows/build-faster-loop.workflow.yaml';

// Commands work in PowerShell, cmd, bash and sh. "first" leaves a side effect, so a second execution shows.
const RESUME_FLOW = `# Created by the build faster integration test.
version: 1
name: Build faster resume
inputs:
  fail: { type: boolean, default: false }
steps:
  - id: first
    type: console
    run: node -e "require('fs').appendFileSync('${COUNTER}', 'run' + String.fromCharCode(10)); console.log('first-output')"
  - id: second
    type: console
    run: 'exit \${{ inputs.fail ? 1 : 0 }}'
  - id: third
    type: console
    run: node -e "require('fs').writeFileSync('${THIRD}', process.env.FIRST)"
    env:
      FIRST: '\${{ steps.first.output }}'
`;

// "count" logs each iteration it runs in; "check" fails in the iteration named by failAt.
const LOOP_FLOW = `# Created by the build faster integration test.
version: 1
name: Build faster loop
inputs:
  failAt: { type: number, default: 0 }
steps:
  - id: rounds
    type: loop
    until: { value: '\${{ loop.iteration }}', op: gte, to: 3 }
    maxIterations: 5
    steps:
      - id: count
        type: console
        run: node -e "require('fs').appendFileSync('${LOOP_LOG}', '\${{ loop.iteration }}' + String.fromCharCode(10))"
      - id: check
        type: console
        run: 'exit \${{ inputs.failAt == loop.iteration ? 1 : 0 }}'
`;

const encode = (text: string) => new TextEncoder().encode(text);

const ofType = <T extends RunEvent['type']>(events: RunEvent[], type: T) =>
  events.filter((e): e is Extract<RunEvent, { type: T }> => e.type === type);

describe('Run from here (build faster)', function () {
  this.timeout(120_000);

  let api: IsarFlowApi;
  let root: vscode.Uri;
  const file = (name: string) => path.join(root.fsPath, name);
  const lines = (name: string) => fs.readFileSync(file(name), 'utf8').split(/\r?\n/).filter(Boolean);

  before(async () => {
    api = await activateApi();
    root = workspaceFolder();
    // Written through VS Code, so the workflow index hears about the files without waiting for the OS watcher.
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(root, RESUME_PATH), encode(RESUME_FLOW));
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(root, LOOP_PATH), encode(LOOP_FLOW));
  });

  after(async () => {
    await closeAllEditors();
    for (const name of [COUNTER, THIRD, LOOP_LOG]) fs.rmSync(file(name), { force: true });
  });

  it('continues a failed run at a middle block and reuses the blocks before it', async () => {
    const uri = await workflowUri(api, RESUME_PATH);
    const failed = await runToEnd(api, uri, { fail: true });
    assert.equal(failed.view.status, 'failure', 'The first run should fail at "second".');
    assert.deepEqual(lines(COUNTER), ['run']);
    assert.equal(fs.existsSync(file(THIRD)), false, '"third" ran although "second" failed.');
    const failedRecord = api.runs.history.list(uri.toString()).find((r) => r.runId === failed.runId);
    assert.equal(failedRecord?.stoppedAt, 'second', 'The history should offer "Run from second".');
    const counterWritten = fs.statSync(file(COUNTER)).mtimeMs;

    const resume = { runId: failed.runId, stepId: 'second' };
    const resumed = await runToEnd(api, uri, { fail: false }, undefined, { resume });
    assert.equal(
      resumed.view.status,
      'success',
      `The run ended with: ${resumed.view.error ?? 'no error text'}`,
    );

    // "first" was not executed again: its side effect file is untouched ...
    assert.deepEqual(lines(COUNTER), ['run'], '"first" ran again instead of reusing its result.');
    assert.equal(fs.statSync(file(COUNTER)).mtimeMs, counterWritten, `${COUNTER} was written again.`);
    assert.ok(!resumed.events.some((e) => e.type === 'step-start' && e.stepId === 'first'));
    assert.equal(stepEnd(resumed.events, 'first').reused, true);
    assert.equal(resumed.view.steps.first?.reused, true);
    // ... but its output from the failed run feeds the blocks after the target.
    assert.equal(fs.readFileSync(file(THIRD), 'utf8').trim(), 'first-output');
    assert.equal(stepEnd(resumed.events, 'second').reused, undefined);

    assert.deepEqual(resumed.view.resumedFrom, resume);
    const record = await waitFor(
      () => api.runs.history.list(uri.toString()).find((r) => r.runId === resumed.runId),
      'the resumed run in the history',
    );
    assert.deepEqual(record.resumedFrom, resume, 'The history should say "Resumed from second".');
  });

  it('continues a loop at the iteration where the block last ran', async () => {
    const uri = await workflowUri(api, LOOP_PATH);
    const failed = await runToEnd(api, uri, { failAt: 2 });
    assert.equal(failed.view.status, 'failure', 'The first run should fail at "check" in round 2.');
    assert.deepEqual(lines(LOOP_LOG), ['1', '2']);

    const resumed = await runToEnd(api, uri, { failAt: 0 }, undefined, {
      resume: { runId: failed.runId, stepId: 'check' },
    });
    assert.equal(
      resumed.view.status,
      'success',
      `The run ended with: ${resumed.view.error ?? 'no error text'}`,
    );

    // Round 2 continued at "check" ("count" of round 2 was reused), then round 3 ran normally.
    assert.deepEqual(
      ofType(resumed.events, 'loop-iteration').map((e) => e.iteration),
      [2, 3],
      'The loop should continue at round 2 instead of starting over.',
    );
    assert.deepEqual(lines(LOOP_LOG), ['1', '2', '3'], '"count" ran again in round 2 or the loop restarted.');
    assert.deepEqual(
      ofType(resumed.events, 'step-start').map((e) => [e.stepId, e.iteration]),
      [
        ['rounds', undefined],
        ['check', 2],
        ['count', 3],
        ['check', 3],
      ],
    );
    assert.equal(stepEnd(resumed.events, 'rounds').output.iterations, 3);
  });

  it('runs from the block under the cursor with the Run from here command', async () => {
    const uri = await workflowUri(api, RESUME_PATH);
    const newest = api.runs.history.list(uri.toString())[0];
    assert.ok(newest, 'The test needs an earlier run of the workflow.');
    const editor = await vscode.window.showTextDocument(uri);
    const at = editor.document.positionAt(editor.document.getText().indexOf('id: third'));
    editor.selection = new vscode.Selection(at, at);

    const runId = await vscode.commands.executeCommand<string | undefined>('isarFlow.runFromHere');
    assert.ok(runId, 'The command did not start a run.');
    const view = await api.runs.whenFinished(runId);
    assert.equal(view?.status, 'success', `The run ended with: ${view?.error ?? 'no error text'}`);
    assert.deepEqual(view?.resumedFrom, { runId: newest.runId, stepId: 'third' });
    assert.equal(view?.steps.second?.reused, true);
    assert.deepEqual(lines(COUNTER), ['run'], '"first" ran again.');
  });

  it('refuses to continue a run that is not in the history', async () => {
    const uri = await workflowUri(api, RESUME_PATH);
    const runId = await api.runs.start(uri, {}, { resume: { runId: 'run-gone', stepId: 'second' } });
    assert.equal(runId, undefined);
  });
});
