import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { RunEvent } from '@isar-flow/core';
import type { IsarFlowApi } from '../../../src/extension';
import { activateApi, runToEnd, stepEnd, waitFor, workflowUri } from '../helpers';

const text = (value: unknown) => (typeof value === 'string' ? value : '');

describe('Runs', function () {
  this.timeout(180_000);

  let api: IsarFlowApi;
  let consoleWorkflow: vscode.Uri;
  let consoleRunId: string | undefined;
  let slowRunId: string | undefined;

  before(async () => {
    api = await activateApi();
    consoleWorkflow = await workflowUri(api, '.isarflow/workflows/console.workflow.yaml');
  });

  it('runs the console workflow to success with the expected outputs', async () => {
    const { runId, view, events } = await runToEnd(api, consoleWorkflow, {});
    consoleRunId = runId;
    assert.equal(view.status, 'success', `The run ended with: ${view.error ?? 'no error text'}`);
    assert.equal(events[0]?.type, 'run-start');
    assert.equal(events.at(-1)?.type, 'run-end');

    const greet = stepEnd(events, 'greet');
    assert.equal(greet.status, 'success');
    assert.equal(greet.output.exitCode, 0);
    assert.equal(text(greet.output.stdout).trim(), 'hello-isar');

    const fails = stepEnd(events, 'fails');
    assert.equal(fails.status, 'failure');
    assert.equal(fails.output.exitCode, 3);

    const loop = stepEnd(events, 'retry_loop');
    assert.equal(loop.status, 'success');
    assert.equal(loop.output.iterations, 3);
    assert.equal(loop.output.exitReason, 'condition');
    const attempts = events.filter((e) => e.type === 'step-start' && e.stepId === 'attempt');
    assert.equal(attempts.length, 3);
    assert.equal(stepEnd(events, 'attempt').output.exitCode, 0);

    const check = stepEnd(events, 'check');
    assert.equal(check.output.branch, 'then');
    assert.equal(text(stepEnd(events, 'then_echo').output.stdout).trim(), 'branch-then');
    assert.ok(!events.some((e) => e.type === 'step-start' && e.stepId === 'else_echo'));

    assert.equal(view.steps.greet?.status, 'success');
    assert.equal(api.runs.active(consoleWorkflow.toString()).length, 0);
  });

  it('refuses to run an invalid workflow', async () => {
    const invalid = await workflowUri(api, '.isarflow/workflows/invalid.workflow.yaml');
    const historyBefore = api.runs.history.list(invalid.toString()).length;
    const runId = await api.runs.start(invalid, {});
    assert.equal(runId, undefined);
    assert.equal(api.runs.active(invalid.toString()).length, 0);
    assert.equal(api.runs.history.list(invalid.toString()).length, historyBefore);
  });

  it('stops a running command through the Run and Stop commands', async () => {
    const slow = await workflowUri(api, '.isarflow/workflows/slow.workflow.yaml');
    const started: Extract<RunEvent, { type: 'step-start' }>[] = [];
    const subscription = api.runs.onEvent(({ workflowUri, event }) => {
      if (workflowUri === slow.toString() && event.type === 'step-start') started.push(event);
    });
    try {
      const runId = await vscode.commands.executeCommand<string | undefined>('isarFlow.runWorkflow', slow);
      assert.ok(runId, 'isarFlow.runWorkflow did not return a run id.');
      slowRunId = runId;
      await waitFor(
        () => started.some((e) => e.runId === runId && e.stepId === 'wait'),
        'the slow command to start',
      );
      // Give the shell time to start the node process, so the whole process tree has to be stopped.
      await new Promise((resolve) => setTimeout(resolve, 1500));

      const stoppedAt = Date.now();
      await vscode.commands.executeCommand('isarFlow.cancelRun', runId);
      const view = await api.runs.whenFinished(runId);
      assert.equal(view?.status, 'cancelled');
      assert.ok(Date.now() - stoppedAt < 20_000, 'Stopping the run took longer than 20 s.');
      assert.equal(api.runs.active().length, 0);
    } finally {
      subscription.dispose();
    }
  });

  it('keeps finished runs in the history', async () => {
    assert.ok(consoleRunId && slowRunId, 'An earlier test did not record its run.');
    const consoleRuns = api.runs.history.list(consoleWorkflow.toString());
    const record = consoleRuns.find((r) => r.runId === consoleRunId);
    assert.ok(record, 'The console run is not in the history of its workflow.');
    assert.equal(record.status, 'success');
    assert.equal(record.workflowName, 'Console basics');

    const all = api.runs.history.list();
    assert.equal(all.find((r) => r.runId === slowRunId)?.status, 'cancelled');

    const view = api.runs.history.get(consoleRunId) ?? (await api.runs.history.getAsync(consoleRunId));
    assert.equal(view?.steps.retry_loop?.output?.iterations, 3);
  });
});
