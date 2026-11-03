import { describe, expect, it, vi } from 'vitest';
import { createRunView, type RunEvent } from '@isar-flow/core';
import type { RunConsoleCommand } from '../../../src/contracts';
import { flush } from './fakes';
import { setup, untilAborted, type Setup } from './managerSetup';

const WORKFLOW = `version: 1
name: Build
inputs:
  fail: { type: boolean, default: false }
steps:
  - id: first
    type: console
    run: count
  - id: second
    type: console
    run: check \${{ inputs.fail }}
`;

const WORKTREE_WORKFLOW = WORKFLOW.replace(
  'name: Build\n',
  'name: Build\nisolation: worktree\nsetup: [npm ci]\n',
);

/** `check true` fails; everything else succeeds. */
const failOnTrue: RunConsoleCommand = async (o) => ({
  exitCode: o.command === 'check true' ? 1 : 0,
  stdout: '',
  stderr: '',
  output: '',
  timedOut: false,
});

const GONE = 'That run is no longer in the history. Run the workflow instead.';

/** A manager with one finished run of WORKFLOW (inputs `fail: true`, so `second` failed). */
async function withSourceRun(options: Setup = {}) {
  const t = setup({ text: WORKFLOW, runCommand: failOnTrue, ...options });
  const source = (await t.manager.start(t.uri, { fail: true })) as string;
  expect((await t.manager.whenFinished(source))?.status).toBe('failure');
  t.commands.length = 0;
  t.events.length = 0;
  vi.mocked(t.ui.promptInputs).mockClear();
  vi.mocked(t.ui.confirmCommands).mockClear();
  return { ...t, source };
}

const ofRun = (events: RunEvent[], runId: string) => events.filter((e) => e.runId === runId);

describe('run manager: run from here', () => {
  it('continues a saved run at a block and reuses the results before it', async () => {
    const t = await withSourceRun();
    const runId = (await t.manager.start(
      t.uri,
      { fail: false },
      { resume: { runId: t.source, stepId: 'second' } },
    )) as string;
    const view = await t.manager.whenFinished(runId);

    expect(view).toMatchObject({ status: 'success', resumedFrom: { runId: t.source, stepId: 'second' } });
    expect(view?.steps.first).toMatchObject({ status: 'success', reused: true });
    // Only the target ran: no host call for the reused block.
    expect(t.commands.map((c) => c.command)).toEqual(['check false']);
    const events = ofRun(t.events, runId);
    expect(events.some((e) => e.type === 'step-start' && e.stepId === 'first')).toBe(false);
    expect(events.find((e) => e.type === 'step-end' && e.stepId === 'first')).toMatchObject({ reused: true });
    expect(events[0]).toMatchObject({
      type: 'run-start',
      resumedFrom: { runId: t.source, stepId: 'second' },
    });

    expect(t.history.list(t.uri.toString())[0]).toMatchObject({
      runId,
      resumedFrom: { runId: t.source, stepId: 'second' },
    });
    expect(t.logLines).toContain(
      `info: Run ${runId} of 'Build' started (${t.uri.fsPath}, from block 'second' of run ${t.source}).`,
    );
    expect(t.ui.promptInputs).not.toHaveBeenCalled();
    // The safety net covers resumed runs like any run: snapshot before, review after.
    const session = t.safety.sessions.find((s) => s.runId === runId);
    expect(session?.options).toMatchObject({ runId, isolation: 'workspace' });
    expect(session?.finish).toHaveBeenCalledTimes(1);
    expect(session?.publish).toHaveBeenCalledTimes(1);
  });

  it("uses the source run's inputs when none are given", async () => {
    const t = await withSourceRun();
    const runId = (await t.manager.start(t.uri, undefined, {
      resume: { runId: t.source, stepId: 'second' },
    })) as string;
    const view = await t.manager.whenFinished(runId);
    expect(view?.inputs).toEqual({ fail: true });
    expect(view?.status).toBe('failure');
    expect(t.commands.map((c) => c.command)).toEqual(['check true']);
    expect(t.ui.promptInputs).not.toHaveBeenCalled();
  });

  it('asks to confirm the commands before it continues', async () => {
    const t = await withSourceRun();
    vi.mocked(t.ui.confirmCommands).mockResolvedValueOnce(undefined);
    expect(
      await t.manager.start(t.uri, { fail: false }, { resume: { runId: t.source, stepId: 'second' } }),
    ).toBeUndefined();
    expect(t.ui.confirmCommands).toHaveBeenCalledTimes(1);
    expect(t.commands).toEqual([]);
    expect(t.events).toEqual([]);
  });

  it('refuses a run that is no longer in the history', async () => {
    const t = await withSourceRun();
    expect(
      await t.manager.start(t.uri, undefined, { resume: { runId: 'run-gone', stepId: 'second' } }),
    ).toBeUndefined();
    await flush();
    expect(t.notifications).toContainEqual({ kind: 'error', message: GONE, buttons: [] });
    expect(t.commands).toEqual([]);
    expect(t.ui.confirmCommands).not.toHaveBeenCalled();
  });

  it('refuses a run of another workflow', async () => {
    const t = await withSourceRun();
    const other = { ...createRunView('run-other', 'Other', 1), status: 'failure' as const };
    await t.history.save(other, 'file:///ws/.isarflow/workflows/other.workflow.yaml');
    expect(
      await t.manager.start(t.uri, undefined, { resume: { runId: 'run-other', stepId: 'second' } }),
    ).toBeUndefined();
    await flush();
    expect(t.notifications).toContainEqual({ kind: 'error', message: GONE, buttons: [] });
  });

  it('refuses a run whose saved data is gone', async () => {
    const t = await withSourceRun();
    vi.spyOn(t.history, 'getAsync').mockResolvedValue(undefined);
    expect(
      await t.manager.start(t.uri, undefined, { resume: { runId: t.source, stepId: 'second' } }),
    ).toBeUndefined();
    await flush();
    expect(t.notifications).toContainEqual({ kind: 'error', message: GONE, buttons: [] });
  });

  it("says why a run can't continue at a block", async () => {
    const t = await withSourceRun();
    expect(
      await t.manager.start(t.uri, undefined, { resume: { runId: t.source, stepId: 'deploy' } }),
    ).toBeUndefined();
    const simulated = {
      ...createRunView('run-sim', 'Build', 2),
      status: 'success' as const,
      simulated: true,
    };
    await t.history.save(simulated, t.uri.toString());
    expect(
      await t.manager.start(t.uri, undefined, { resume: { runId: 'run-sim', stepId: 'second' } }),
    ).toBeUndefined();
    await flush();
    expect(t.notifications.map((n) => [n.kind, n.message])).toEqual([
      ['error', "This block isn't in the workflow anymore."],
      ['error', "Simulated runs can't be continued. Run the workflow, then run from a block."],
    ]);
    expect(t.commands).toEqual([]);
  });

  it('is refused in Restricted Mode', async () => {
    const t = setup({ text: WORKFLOW, trusted: false });
    expect(
      await t.manager.start(t.uri, undefined, { resume: { runId: 'run-1', stepId: 'second' } }),
    ).toBeUndefined();
    await flush();
    expect(t.notifications[0]).toMatchObject({ kind: 'warning', buttons: ['Manage Workspace Trust'] });
    expect(t.ui.readText).not.toHaveBeenCalled();
  });

  it('is refused while the workflow runs', async () => {
    const t = setup({ text: WORKFLOW, runCommand: untilAborted });
    const live = (await t.manager.start(t.uri, { fail: true })) as string;
    expect(
      await t.manager.start(t.uri, undefined, { resume: { runId: live, stepId: 'second' } }),
    ).toBeUndefined();
    await flush();
    expect(t.notifications).toContainEqual({
      kind: 'info',
      message: 'This workflow is already running.',
      buttons: [],
    });
    t.manager.cancel(live);
    await t.manager.whenFinished(live);
  });

  it('is refused when the workflow has problems now', async () => {
    const t = await withSourceRun();
    vi.mocked(t.ui.readText).mockResolvedValue(
      'version: 1\nname: Bad\nsteps:\n  - id: a\n    type: console\n',
    );
    expect(
      await t.manager.start(t.uri, undefined, { resume: { runId: t.source, stepId: 'second' } }),
    ).toBeUndefined();
    await flush();
    expect(t.notifications[0]).toMatchObject({
      kind: 'error',
      message: 'Fix 1 problem in build.workflow.yaml before running.',
    });
  });

  it('runs in a new worktree with the setup commands first', async () => {
    const t = await withSourceRun({ text: WORKTREE_WORKFLOW });
    const runId = (await t.manager.start(
      t.uri,
      { fail: false },
      {
        resume: { runId: t.source, stepId: 'second' },
      },
    )) as string;
    const view = await t.manager.whenFinished(runId);
    expect(view?.status).toBe('success');
    expect(t.safety.sessions[1].options).toMatchObject({ runId, isolation: 'worktree' });
    expect(t.commands.map((c) => c.command)).toEqual(['npm ci', 'check false']);
    expect(t.logLines).toContain(
      `info: Run ${runId} of 'Build' started (${t.uri.fsPath}, in a git worktree, from block 'second' of run ${t.source}).`,
    );
  });

  it('marks a run that stopped during setup as resumed', async () => {
    let setupFails = false;
    const t = await withSourceRun({
      text: WORKTREE_WORKFLOW,
      runCommand: async (o) => ({
        exitCode: (setupFails && o.command === 'npm ci') || o.command === 'check true' ? 1 : 0,
        stdout: '',
        stderr: '',
        output: '',
        timedOut: false,
      }),
    });
    setupFails = true;
    const runId = (await t.manager.start(t.uri, undefined, {
      resume: { runId: t.source, stepId: 'second' },
    })) as string;
    const view = await t.manager.whenFinished(runId);
    expect(view).toMatchObject({ status: 'failure', resumedFrom: { runId: t.source, stepId: 'second' } });
    expect(ofRun(t.events, runId)[0]).toMatchObject({
      type: 'run-start',
      resumedFrom: { runId: t.source, stepId: 'second' },
    });
  });
});
