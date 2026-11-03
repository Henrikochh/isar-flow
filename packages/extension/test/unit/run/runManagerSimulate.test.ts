import * as vscode from 'vscode';
import { describe, expect, it, vi } from 'vitest';
import type { RunEvent } from '@isar-flow/core';
import type { RunManagerDeps } from '../../../src/contracts';
import { createRunHistory } from '../../../src/run/history';
import { createRunManager, SIMULATION_DELAY_MS } from '../../../src/run/runManager';
import { FakeMemento, FakeSecretStorage, fakeSimulations, flush, memoryStore } from './fakes';
import { setup } from './managerSetup';
import { fakeSafety } from './safetyFakes';

const MOCKS = { blocks: { build: [{ exitCode: 0, output: 'pretend' }] } };
const SECRET_WORKFLOW = `version: 1
name: Build
steps:
  - id: build
    type: console
    run: deploy \${{ secrets.TOKEN }}
`;
const BROKEN = 'Fix .isarflow/simulations/build.sim.yaml before simulating: Use a list of results (line 3).';

const runStart = (events: RunEvent[]) =>
  events.find((e): e is Extract<RunEvent, { type: 'run-start' }> => e.type === 'run-start');

describe('run manager: simulate', () => {
  it('runs with the mocks: no commands, confirmation, snapshot, terminal or notification', async () => {
    const t = setup({ simulations: fakeSimulations(MOCKS), safety: { changed: 2 } });
    const runId = (await t.manager.start(t.uri, undefined, { simulate: true })) as string;
    const view = await t.manager.whenFinished(runId);

    expect(view).toMatchObject({ status: 'success', simulated: true });
    expect(view?.steps.build.output).toMatchObject({ exitCode: 0, output: 'pretend' });
    expect(t.simulations.load).toHaveBeenCalledWith(t.uri);
    expect(t.ui.promptInputs).toHaveBeenCalledTimes(1);
    expect(t.commands).toEqual([]);
    expect(t.ui.confirmCommands).not.toHaveBeenCalled();
    expect(t.safety.safety.begin).not.toHaveBeenCalled();
    expect(t.deps.terminalFor).not.toHaveBeenCalled();
    expect(t.deps.tools).not.toHaveBeenCalled();
    await flush();
    expect(t.notifications).toEqual([]);
    expect(t.history.list(t.uri.toString())[0]).toMatchObject({ runId, simulated: true, status: 'success' });
    expect(t.logLines).toContain(`info: Simulated run ${runId} of 'Build' started (${t.uri.fsPath}).`);
    expect(t.logLines).toContainEqual(expect.stringMatching(/^info: Simulated run .+ of 'Build' succeeded/));
  });

  it('reaches no real host service with any block type, also in an isolated workflow', async () => {
    const text = `version: 1
name: Build
isolation: worktree
setup:
  - npm ci
steps:
  - id: build
    type: console
    run: npm run build
  - id: plan
    type: agent
    model: p/m
    prompt: Plan
    context:
      files: [src/**]
  - id: ship
    type: approval
    message: Ship it?
`;
    const t = setup({ text, safety: { canIsolate: false } });
    const resolve = vi.spyOn(t.deps.models, 'resolve');
    const asked = vi.fn();
    t.approvals.attach(t.uri.toString());
    t.approvals.onDidRequest(asked);
    const runId = (await t.manager.start(t.uri, {}, { simulate: true })) as string;
    const view = await t.manager.whenFinished(runId);

    expect(view?.status).toBe('success');
    expect(Object.values(view?.steps ?? {}).map((step) => step.status)).toEqual([
      'success',
      'success',
      'success',
    ]);
    expect(t.commands).toEqual([]);
    expect(t.contextReads).toEqual([]);
    expect(resolve).not.toHaveBeenCalled();
    expect(asked).not.toHaveBeenCalled();
    expect(t.deps.tools).not.toHaveBeenCalled();
    expect(t.deps.terminalFor).not.toHaveBeenCalled();
    expect(t.safety.safety.canIsolate).not.toHaveBeenCalled();
    expect(t.safety.safety.begin).not.toHaveBeenCalled();
    expect(t.ui.confirmCommands).not.toHaveBeenCalled();
  });

  it('pauses briefly at each simulated call, so the canvas can show the flow', async () => {
    const t = setup({ simulations: fakeSimulations(MOCKS), defaultSimulationDelay: true });
    const started = Date.now();
    const runId = (await t.manager.start(t.uri, {}, { simulate: true })) as string;
    expect((await t.manager.whenFinished(runId))?.status).toBe('success');
    expect(Date.now() - started).toBeGreaterThanOrEqual(SIMULATION_DELAY_MS - 5);
  });

  it('shows a simulation status item while it runs', async () => {
    const t = setup({ simulationDelayMs: 60_000 });
    const runId = (await t.manager.start(t.uri, {}, { simulate: true })) as string;
    const [item] = t.statusItems;
    expect(item.shown).toBe(true);
    expect(item.text).toMatch(/^\$\(beaker\) Build \(simulated\) 0:0\d$/);
    expect(item.tooltip).toBe('Simulating Build. Click to show the workflow.');
    expect(item.command).toMatchObject({
      command: 'vscode.openWith',
      arguments: [t.uri, 'isarFlow.workflowEditor'],
    });
    t.manager.cancel(runId);
    expect((await t.manager.whenFinished(runId))?.status).toBe('cancelled');
    expect(item.disposed).toBe(true);
    expect(t.history.list()[0]).toMatchObject({ runId, status: 'cancelled', simulated: true });
  });

  it('takes the given inputs without asking', async () => {
    const t = setup();
    const runId = (await t.manager.start(t.uri, { who: 'you' }, { simulate: true })) as string;
    expect((await t.manager.whenFinished(runId))?.inputs).toEqual({ who: 'you' });
    expect(t.ui.promptInputs).not.toHaveBeenCalled();
  });

  it('stops when the input prompt is cancelled', async () => {
    const t = setup({ inputs: undefined });
    expect(await t.manager.start(t.uri, undefined, { simulate: true })).toBeUndefined();
    expect(t.events).toEqual([]);
  });

  it('works in Restricted Mode, without secrets', async () => {
    const t = setup({ text: SECRET_WORKFLOW, trusted: false });
    await t.secrets.set('TOKEN', 's3cret-value');
    const runId = (await t.manager.start(t.uri, {}, { simulate: true })) as string;
    expect(runId).toBeDefined();
    await t.manager.whenFinished(runId);
    expect(runStart(t.events)?.context?.secrets).toEqual([]);
    expect(t.notifications).toEqual([]);
  });

  it('passes the secrets in trusted workspaces', async () => {
    const t = setup({ text: SECRET_WORKFLOW });
    await t.secrets.set('TOKEN', 's3cret-value');
    await t.manager.whenFinished((await t.manager.start(t.uri, {}, { simulate: true })) as string);
    expect(runStart(t.events)?.context?.secrets).toEqual(['TOKEN']);
    expect(JSON.stringify(t.events)).not.toContain('s3cret-value');
  });

  it('refuses a simulation file with errors and offers to open it', async () => {
    const simulations = fakeSimulations(new Error(BROKEN));
    const t = setup({ simulations, click: 'Open simulation file' });
    expect(await t.manager.start(t.uri, undefined, { simulate: true })).toBeUndefined();
    await flush();
    expect(t.notifications).toEqual([{ kind: 'error', message: BROKEN, buttons: ['Open simulation file'] }]);
    expect(simulations.open).toHaveBeenCalledWith(t.uri);
    expect(t.ui.promptInputs).not.toHaveBeenCalled();
    expect(t.events).toEqual([]);
  });

  it('says so when the simulation file cannot be opened', async () => {
    const simulations = fakeSimulations(new Error(BROKEN));
    simulations.open.mockRejectedValue(new Error('No permission'));
    const t = setup({ simulations, click: 'Open simulation file' });
    await t.manager.start(t.uri, undefined, { simulate: true });
    await flush();
    expect(t.notifications.map((n) => n.message)).toContain(
      'Could not open the simulation file: No permission',
    );
  });

  it('is refused while the workflow runs', async () => {
    const t = setup({ simulationDelayMs: 60_000 });
    const live = (await t.manager.start(t.uri, {}, { simulate: true })) as string;
    expect(await t.manager.start(t.uri, {}, { simulate: true })).toBeUndefined();
    expect(await t.manager.start(t.uri, {})).toBeUndefined();
    await flush();
    expect(t.notifications.filter((n) => n.message === 'This workflow is already running.')).toHaveLength(2);
    t.manager.cancel(live);
    await t.manager.whenFinished(live);
  });

  it('is refused for workflows with problems', async () => {
    const t = setup({ text: 'version: 1\nname: Bad\nsteps:\n  - id: a\n    type: console\n' });
    expect(await t.manager.start(t.uri, undefined, { simulate: true })).toBeUndefined();
    await flush();
    expect(t.notifications[0].message).toBe('Fix 1 problem in build.workflow.yaml before running.');
    expect(t.simulations.load).not.toHaveBeenCalled();
  });

  it("can't be combined with run from here", async () => {
    const t = setup();
    expect(
      await t.manager.start(t.uri, undefined, {
        simulate: true,
        resume: { runId: 'run-1', stepId: 'build' },
      }),
    ).toBeUndefined();
    await flush();
    expect(t.notifications).toEqual([
      {
        kind: 'error',
        message: "Run from here can't be simulated. Simulate the whole workflow instead.",
        buttons: [],
      },
    ]);
    expect(t.ui.readText).not.toHaveBeenCalled();
  });

  it('stops simulations on shutdown and saves them', async () => {
    const t = setup({ simulationDelayMs: 60_000 });
    const runId = (await t.manager.start(t.uri, {}, { simulate: true })) as string;
    await flush();
    await t.manager.shutdown();
    expect(t.history.list()[0]).toMatchObject({ runId, status: 'cancelled', simulated: true });
    expect(t.simulations.dispose).toHaveBeenCalledTimes(1);
  });
});

describe('run manager: simulation store', () => {
  it('creates and disposes its own simulation store', () => {
    const textChanges = vi.fn(() => ({ dispose: () => undefined }));
    Object.assign(vscode.workspace, { onDidChangeTextDocument: textChanges });
    const context = {
      workspaceState: new FakeMemento(),
      globalState: new FakeMemento(),
      secrets: new FakeSecretStorage(),
      subscriptions: [],
    };
    const deps = {
      context,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as unknown as RunManagerDeps;
    const manager = createRunManager(deps, {
      safety: fakeSafety().safety,
      history: createRunHistory(memoryStore(), new FakeMemento(), () => 50),
      ui: { isTrusted: () => false },
    });
    const uri = vscode.Uri.file('/loose/build.workflow.yaml');
    expect(manager.simulations.uriFor(uri).path).toBe('/loose/.isarflow/simulations/build.sim.yaml');
    expect(textChanges).toHaveBeenCalledTimes(1);
    manager.dispose();
  });
});
