import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import { type RunEvent, SIMULATED_ANSWER } from '@isar-flow/core';
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

const SIMULATED_FILE = 'simulated.txt';
const SPAWNED_FILE = 'spawned.txt';
const SIMULATE_PATH = '.isarflow/workflows/build-faster-simulate.workflow.yaml';
const MOCKS_PATH = '.isarflow/simulations/build-faster-simulate.sim.yaml';
const REVIEW_PATH = '.isarflow/workflows/build-faster-review.workflow.yaml';
const REVIEW_MOCKS_PATH = '.isarflow/simulations/build-faster-review.sim.yaml';
const ECHO_PATH = '.isarflow/workflows/build-faster-echo.workflow.yaml';

const SIMULATE_FLOW = `# Created by the simulate integration test.
version: 1
name: Build faster simulate
steps:
  - id: create
    type: console
    run: node -e "require('fs').writeFileSync('${SIMULATED_FILE}', 'created')"
`;

// The review loop of examples/review-loop.workflow.yaml; its agents are in the fixture workspace.
const REVIEW_FLOW = `# Created by the simulate integration test.
version: 1
name: Build faster review loop
inputs:
  task: { type: string, default: Add vouchers }
steps:
  - id: implement
    type: agent
    agent: coder
    prompt: 'Implement: \${{ inputs.task }}'
  - id: review_loop
    type: loop
    until:
      all:
        - { value: '\${{ steps.tests.exitCode }}', op: eq, to: 0 }
        - { value: '\${{ steps.review.json.approved }}', op: isTrue }
    maxIterations: 5
    steps:
      - id: tests
        type: console
        run: node -e "require('fs').writeFileSync('${SPAWNED_FILE}', 'tests ran')"
        continueOnError: true
      - id: review
        type: agent
        agent: reviewer
        prompt: 'The tests exited with \${{ steps.tests.exitCode }}: \${{ steps.tests.output }}'
        output:
          format: json
          schema: { approved: boolean, issues: 'string[]' }
      - id: needs_fix
        type: if
        condition: '\${{ !steps.review.json.approved || steps.tests.exitCode != 0 }}'
        then:
          - id: fix
            type: agent
            agent: coder
            prompt: 'Fix: \${{ toJSON(steps.review.json.issues) }}'
`;

// The first test run fails and the second passes; the reviewer approves in round 2.
const REVIEW_MOCKS = `version: 1
blocks:
  tests:
    - exitCode: 1
      output: 1 failed
    - exitCode: 0
      output: 32 passed
  review:
    - json: { approved: false, issues: [Add a test] }
    - json: { approved: true, issues: [] }
`;

const ECHO_FLOW = `# Created by the simulate integration test.
version: 1
name: Build faster echo
steps:
  - id: hello
    type: console
    run: echo hello
`;

const encode = (text: string) => new TextEncoder().encode(text);

const SPAWNERS = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const;

/** Records every process started in the extension host (the extension shares this module) until stop(). */
function recordProcesses() {
  const started: string[] = [];
  const module = childProcess as unknown as Record<string, (...args: unknown[]) => unknown>;
  const originals = SPAWNERS.map((name) => [name, module[name]] as const);
  for (const [name, original] of originals) {
    module[name] = function (this: unknown, ...args: unknown[]) {
      started.push(`${name} ${String(args[0])}`);
      return original.apply(this, args);
    };
  }
  return {
    started,
    stop: () => {
      for (const [name, original] of originals) module[name] = original;
    },
  };
}

/** Relative path → size and modification time of every file under `dir`. */
function fileStamps(dir: string, base = dir, stamps: Record<string, string> = {}): Record<string, string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      fileStamps(full, base, stamps);
    } else {
      const stat = fs.statSync(full);
      stamps[path.relative(base, full)] = `${stat.size} ${stat.mtimeMs}`;
    }
  }
  return stamps;
}

const ends = (events: RunEvent[], stepId: string) =>
  events.filter(
    (e): e is Extract<RunEvent, { type: 'step-end' }> => e.type === 'step-end' && e.stepId === stepId,
  );

describe('Simulate (build faster)', function () {
  this.timeout(120_000);

  let api: IsarFlowApi;
  let root: vscode.Uri;
  const file = (name: string) => path.join(root.fsPath, name);
  const write = (relative: string, text: string) =>
    vscode.workspace.fs.writeFile(vscode.Uri.joinPath(root, ...relative.split('/')), encode(text));

  before(async () => {
    api = await activateApi();
    root = workspaceFolder();
    // Written through VS Code, so the workflow index hears about the files without waiting for the OS watcher.
    await write(SIMULATE_PATH, SIMULATE_FLOW);
    await write(REVIEW_PATH, REVIEW_FLOW);
    await write(ECHO_PATH, ECHO_FLOW);
  });

  after(async () => {
    await closeAllEditors();
    for (const name of [SIMULATED_FILE, SPAWNED_FILE, MOCKS_PATH, REVIEW_MOCKS_PATH]) {
      fs.rmSync(file(name), { force: true });
    }
  });

  it('simulates a workflow with the mocks of its simulation file and runs nothing', async () => {
    const uri = await workflowUri(api, SIMULATE_PATH);
    const simulations = api.runs.simulations;
    const mocks = simulations.uriFor(uri);
    const changed = new Promise<void>((resolve) => {
      const subscription = simulations.onDidChange((e) => {
        if (e.uri !== mocks.toString()) return;
        subscription.dispose();
        resolve();
      });
    });

    await simulations.setBlock(uri, 'create', [{ exitCode: 0, output: 'pretend output' }]);
    await changed;
    const state = await simulations.state(uri, null);
    assert.equal(state.path, MOCKS_PATH);
    assert.equal(state.exists, true);
    assert.deepEqual(state.file.blocks?.create, [{ exitCode: 0, output: 'pretend output' }]);

    const { runId, view, events } = await runToEnd(api, uri, {}, undefined, { simulate: true });
    assert.equal(view.status, 'success', `The simulation ended with: ${view.error ?? 'no error text'}`);
    assert.equal(view.simulated, true);
    assert.equal(stepEnd(events, 'create').output.output, 'pretend output');
    assert.equal(fs.existsSync(file(SIMULATED_FILE)), false, 'The simulation ran the command.');
    const record = await waitFor(
      () => api.runs.history.list(uri.toString()).find((r) => r.runId === runId),
      'the simulated run in the history',
    );
    assert.equal(record.simulated, true);
  });

  it('drives a review loop to the end with mocks, without starting a process or changing a file', async () => {
    // Control: the recorder sees the processes of a real run, so an empty list below means something.
    const echoUri = await workflowUri(api, ECHO_PATH);
    const control = recordProcesses();
    const echo = await runToEnd(api, echoUri, {}).finally(control.stop);
    assert.equal(echo.view.status, 'success', `The control run ended with: ${echo.view.error ?? 'no error'}`);
    assert.ok(
      control.started.some((call) => call.startsWith('spawn ')),
      'The recorder did not see the shell of a real run.',
    );

    await write(REVIEW_MOCKS_PATH, REVIEW_MOCKS);
    const uri = await workflowUri(api, REVIEW_PATH);
    const stamps = fileStamps(root.fsPath);
    const recorder = recordProcesses();
    const { view, events } = await runToEnd(api, uri, { task: 'Add vouchers' }, undefined, {
      simulate: true,
    }).finally(recorder.stop);
    assert.equal(view.status, 'success', `The simulation ended with: ${view.error ?? 'no error text'}`);
    assert.equal(view.simulated, true);

    assert.deepEqual(recorder.started, [], 'The simulation started processes.');
    assert.equal(fs.existsSync(file(SPAWNED_FILE)), false, 'The simulation ran the test command.');
    assert.deepEqual(fileStamps(root.fsPath), stamps, 'The simulation changed files in the workspace.');

    // Round 1: the tests fail, the reviewer rejects, fix runs. Round 2: both pass and the loop ends.
    assert.deepEqual(
      ends(events, 'tests').map((e) => [e.output.exitCode, e.output.output]),
      [
        [1, '1 failed'],
        [0, '32 passed'],
      ],
    );
    assert.deepEqual(
      ends(events, 'review').map((e) => e.output.json),
      [
        { approved: false, issues: ['Add a test'] },
        { approved: true, issues: [] },
      ],
    );
    assert.deepEqual(
      ends(events, 'fix').map((e) => e.status),
      ['success', 'skipped'],
    );
    assert.equal(stepEnd(events, 'implement').output.text, SIMULATED_ANSWER);
    const loop = stepEnd(events, 'review_loop').output;
    assert.deepEqual([loop.iterations, loop.exitReason], [2, 'condition']);
  });

  it('refuses to simulate while the simulation file has errors', async () => {
    const uri = await workflowUri(api, SIMULATE_PATH);
    const mocks = api.runs.simulations.uriFor(uri);
    await vscode.workspace.fs.writeFile(mocks, encode('version: 1\nblocks:\n  create:\n    exitCode: 1\n'));
    await assert.rejects(api.runs.simulations.load(uri), /^Error: Fix .+ before simulating: /);
    assert.equal(await api.runs.start(uri, {}, { simulate: true }), undefined);
    assert.equal(fs.existsSync(file(SIMULATED_FILE)), false);
  });
});
