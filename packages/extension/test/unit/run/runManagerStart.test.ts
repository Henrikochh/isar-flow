import { describe, expect, it, vi } from 'vitest';
import type { RunOrigin } from '@isar-flow/core';
import type { RunRefusal, RunStartOptions } from '../../../src/contracts';
import { flush } from './fakes';
import { CONSOLE_WORKFLOW, setup, untilAborted, type Setup } from './managerSetup';

const TRIGGER: RunOrigin = { kind: 'trigger', trigger: 'save', file: 'src/a.ts' };
const ORIGINS: [string, RunOrigin][] = [
  ['manual', { kind: 'manual' }],
  ['selection', { kind: 'selection' }],
  ['trigger', TRIGGER],
  ['copilot', { kind: 'copilot' }],
];
const PROMPTING: [string, RunOrigin][] = ORIGINS.slice(0, 2);
const UNATTENDED: [string, RunOrigin][] = ORIGINS.slice(2);

const INPUT_WORKFLOW = `version: 1
name: Greet
inputs:
  who:
    type: string
    required: true
  greeting:
    type: string
    required: true
    default: Hello
steps:
  - id: say
    type: console
    run: echo \${{ inputs.greeting }} \${{ inputs.who }}
`;

const NO_COMMANDS = `version: 1
name: Gate
steps:
  - id: gate
    type: approval
    message: Ship it?
`;

/** Nothing to confirm: no console blocks and no agents that act without asking. */
const QUIET_WORKFLOW = `version: 1
name: Quiet
steps:
  - id: done
    type: stop
    outcome: success
`;

/** Starts with onRefused and returns the run id and the refusals it reported. */
async function start(
  t: ReturnType<typeof setup>,
  inputs: Record<string, unknown> | undefined,
  options: RunStartOptions = {},
) {
  const refusals: RunRefusal[] = [];
  const runId = await t.manager.start(t.uri, inputs, { ...options, onRefused: (r) => refusals.push(r) });
  await flush();
  return { runId, refusals };
}

const quiet = (overrides: Setup = {}) => setup({ settings: { confirmCommands: false }, ...overrides });

describe('createRunManager refusals', () => {
  describe.each(ORIGINS)('started by %s', (_label, origin) => {
    it('refuses in Restricted Mode', async () => {
      const t = quiet({ trusted: false });
      const { runId, refusals } = await start(t, {}, { origin });
      expect(runId).toBeUndefined();
      expect(refusals).toEqual([
        {
          reason: 'untrusted',
          message: "Workflows don't run in Restricted Mode. Trust this workspace to run them.",
        },
      ]);
      expect(t.notifications).toEqual([]);
    });

    it('refuses while the workflow runs', async () => {
      const t = quiet({ runCommand: untilAborted });
      const first = (await t.manager.start(t.uri, {}, { origin })) as string;
      const { runId, refusals } = await start(t, {}, { origin });
      expect(runId).toBeUndefined();
      expect(refusals).toEqual([{ reason: 'running', message: 'This workflow is already running.' }]);
      t.manager.cancel(first);
      await t.manager.whenFinished(first);
    });

    it('refuses workflows with problems', async () => {
      const t = quiet({ text: 'version: 1\nname: Broken\nsteps: nope\n' });
      const { refusals } = await start(t, {}, { origin });
      expect(refusals).toEqual([
        {
          reason: 'invalid',
          message: expect.stringMatching(/^Fix \d+ problems? in build\.workflow\.yaml before running\.$/),
        },
      ]);
      expect(t.notifications).toEqual([]);
    });

    it('refuses unreadable files', async () => {
      const t = quiet();
      vi.mocked(t.ui.readText).mockRejectedValueOnce(new Error('gone'));
      const { refusals } = await start(t, {}, { origin });
      expect(refusals).toEqual([{ reason: 'invalid', message: 'Could not read build.workflow.yaml: gone' }]);
    });

    it('reports unexpected errors', async () => {
      const t = quiet();
      vi.spyOn(t.deps.agents, 'definitions').mockImplementation(() => {
        throw new Error('index broken');
      });
      const { refusals } = await start(t, {}, { origin });
      expect(refusals).toEqual([
        { reason: 'error', message: 'Could not start build.workflow.yaml: index broken' },
      ]);
      expect(t.logLines.some((line) => line.startsWith('error:') && line.includes('index broken'))).toBe(
        true,
      );
    });
  });

  describe.each(UNATTENDED)('started by %s', (_label, origin) => {
    it.each([
      ['simulate', { simulate: true }],
      ['resume', { resume: { runId: 'run-old', stepId: 'build' } }],
    ] as const)("can't %s", async (_what, extra) => {
      const t = quiet();
      const { runId, refusals } = await start(t, {}, { origin, ...extra });
      expect(runId).toBeUndefined();
      expect(refusals).toEqual([
        { reason: 'not-allowed', message: "Triggers and Copilot can't simulate or continue runs." },
      ]);
      expect(t.simulations.load).not.toHaveBeenCalled();
    });

    it('never shows input boxes and refuses missing required inputs', async () => {
      const t = quiet({ text: INPUT_WORKFLOW });
      const fix =
        origin.kind === 'trigger'
          ? "Triggers can't ask for values: give it a default."
          : 'Pass it when you run the workflow.';
      const missing = await start(t, undefined, { origin });
      const blank = await start(t, { who: '  ' }, { origin });
      expect([...missing.refusals, ...blank.refusals]).toEqual([
        { reason: 'inputs', message: `Input 'who' is required. ${fix}` },
        { reason: 'inputs', message: `Input 'who' is required. ${fix}` },
      ]);
      expect(t.ui.promptInputs).not.toHaveBeenCalled();

      const runId = (await t.manager.start(t.uri, { who: 'Ada' }, { origin })) as string;
      await t.manager.whenFinished(runId);
      expect(t.commands.map((c) => c.command)).toEqual(['echo Hello Ada']);
      expect(t.ui.promptInputs).not.toHaveBeenCalled();
    });
  });

  describe.each(PROMPTING)('started by %s', (_label, origin) => {
    it('prompts for inputs and reports a cancelled prompt', async () => {
      const t = quiet({ text: INPUT_WORKFLOW, inputs: undefined });
      const { refusals } = await start(t, undefined, { origin });
      expect(t.ui.promptInputs).toHaveBeenCalledTimes(1);
      expect(refusals).toEqual([
        { reason: 'cancelled', message: 'The run was cancelled before it started.' },
      ]);
    });

    it('can simulate and refuses simulating and continuing at once', async () => {
      const t = quiet();
      const { refusals } = await start(
        t,
        {},
        { origin, simulate: true, resume: { runId: 'r', stepId: 'build' } },
      );
      expect(refusals).toEqual([
        {
          reason: 'not-allowed',
          message: "Run from here can't be simulated. Simulate the whole workflow instead.",
        },
      ]);
      const runId = (await t.manager.start(t.uri, {}, { origin, simulate: true })) as string;
      expect((await t.manager.whenFinished(runId))?.simulated).toBe(true);
    });

    it('reports declined command confirmations without a notification', async () => {
      const t = setup({ confirm: undefined });
      const { refusals } = await start(t, {}, { origin });
      expect(refusals).toEqual([{ reason: 'confirmation', message: "The commands weren't confirmed." }]);
      expect(await t.manager.start(t.uri, {}, { origin })).toBeUndefined();
      expect(t.notifications).toEqual([]);
    });
  });

  it('asks Copilot runs to confirm commands like manual runs', async () => {
    const t = setup({ confirm: undefined });
    const { refusals } = await start(t, {}, { origin: { kind: 'copilot' } });
    expect(t.ui.confirmCommands).toHaveBeenCalledTimes(1);
    expect(refusals).toEqual([{ reason: 'confirmation', message: "The commands weren't confirmed." }]);
  });

  it('never shows the command confirmation for triggers: unapproved commands are refused', async () => {
    const t = setup({ confirm: 'Run and remember' });
    const { refusals } = await start(t, {}, { origin: TRIGGER });
    expect(refusals).toEqual([
      {
        reason: 'confirmation',
        message: "Run 'Build' once and choose 'Run and remember' so its triggers can start it.",
      },
    ]);
    expect(t.ui.confirmCommands).not.toHaveBeenCalled();

    await t.manager.whenFinished((await t.manager.start(t.uri)) as string);
    const runId = (await t.manager.start(t.uri, {}, { origin: TRIGGER })) as string;
    expect((await t.manager.whenFinished(runId))?.status).toBe('success');
    expect(t.ui.confirmCommands).toHaveBeenCalledTimes(1);
  });

  it('refuses triggers of a workflow with nothing to confirm until a person started it once', async () => {
    const t = setup({ text: QUIET_WORKFLOW });
    const { refusals } = await start(t, {}, { origin: TRIGGER });
    expect(refusals).toEqual([
      { reason: 'confirmation', message: "Run 'Quiet' once so its triggers can start it." },
    ]);
    const copilot = (await t.manager.start(t.uri, {}, { origin: { kind: 'copilot' } })) as string;
    await t.manager.whenFinished(copilot);
    const runId = (await t.manager.start(t.uri, {}, { origin: TRIGGER })) as string;
    expect((await t.manager.whenFinished(runId))?.status).toBe('success');
    expect(t.ui.confirmCommands).not.toHaveBeenCalled();
  });

  it('shows refusals as notifications when there is no onRefused', async () => {
    const t = setup();
    expect(await t.manager.start(t.uri, {}, { origin: TRIGGER })).toBeUndefined();
    await flush();
    expect(t.notifications).toEqual([
      {
        kind: 'warning',
        message: "Run 'Build' once and choose 'Run and remember' so its triggers can start it.",
        buttons: [],
      },
    ]);
  });

  it('reports a start that is already asking as running, silently without onRefused', async () => {
    let answer!: (values: Record<string, unknown> | undefined) => void;
    const t = quiet();
    vi.mocked(t.ui.promptInputs).mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    const first = t.manager.start(t.uri);
    await flush();
    const { refusals } = await start(t, {});
    expect(refusals).toEqual([{ reason: 'running', message: 'This workflow is already starting.' }]);
    expect(await t.manager.start(t.uri, {})).toBeUndefined();
    expect(t.notifications).toEqual([]);
    answer(undefined);
    expect(await first).toBeUndefined();
  });

  it('reports a disposed manager as an error', async () => {
    const t = quiet();
    t.manager.dispose();
    const { refusals } = await start(t, {});
    expect(refusals).toEqual([
      { reason: 'error', message: 'Isar Flow is shutting down, so the workflow did not start.' },
    ]);
  });

  it('logs why a start with onRefused did not start and survives a throwing callback', async () => {
    const t = quiet({ trusted: false });
    const runId = await t.manager.start(
      t.uri,
      {},
      {
        onRefused: () => {
          throw new Error('listener broke');
        },
      },
    );
    expect(runId).toBeUndefined();
    expect(t.logLines).toContainEqual(
      expect.stringMatching(/^info: build\.workflow\.yaml did not start: Workflows/),
    );
    expect(t.logLines).toContainEqual(expect.stringMatching(/^error: .*listener broke/));
  });
});

describe('createRunManager confirmationState', () => {
  it('is needed for unapproved commands and approved after Run and remember', async () => {
    const t = setup({ confirm: 'Run and remember' });
    expect(await t.manager.confirmationState(t.uri)).toBe('needed');
    await t.manager.whenFinished((await t.manager.start(t.uri)) as string);
    expect(await t.manager.confirmationState(t.uri)).toBe('approved');
    expect(t.ui.confirmCommands).toHaveBeenCalledTimes(1);
  });

  it('needs one start by a person when nothing needs confirming', async () => {
    const t = setup({ text: QUIET_WORKFLOW });
    expect(await t.manager.confirmationState(t.uri)).toBe('never-run');
    // A simulation runs nothing, so it doesn't count.
    await t.manager.whenFinished((await t.manager.start(t.uri, {}, { simulate: true })) as string);
    expect(await t.manager.confirmationState(t.uri)).toBe('never-run');
    await t.manager.whenFinished((await t.manager.start(t.uri)) as string);
    expect(await t.manager.confirmationState(t.uri)).toBe('approved');
    expect(t.ui.confirmCommands).not.toHaveBeenCalled();
  });

  it('is approved when confirmation is off', async () => {
    const off = setup({ settings: { confirmCommands: false } });
    expect(await off.manager.confirmationState(off.uri)).toBe('approved');
    const quietOff = setup({ text: QUIET_WORKFLOW, settings: { confirmCommands: false } });
    expect(await quietOff.manager.confirmationState(quietOff.uri)).toBe('approved');
  });

  it('is invalid for unreadable files and files with problems, without notifications', async () => {
    const broken = setup({ text: 'version: 1\nsteps: 3\n' });
    expect(await broken.manager.confirmationState(broken.uri)).toBe('invalid');
    const unreadable = setup();
    vi.mocked(unreadable.ui.readText).mockRejectedValueOnce(new Error('gone'));
    expect(await unreadable.manager.confirmationState(unreadable.uri)).toBe('invalid');
    await flush();
    expect([...broken.notifications, ...unreadable.notifications]).toEqual([]);
    expect(broken.ui.confirmCommands).not.toHaveBeenCalled();
  });

  it('reads the current text each time', async () => {
    const t = setup();
    vi.mocked(t.ui.readText).mockResolvedValueOnce(NO_COMMANDS);
    expect(await t.manager.confirmationState(t.uri)).toBe('never-run');
    vi.mocked(t.ui.readText).mockResolvedValueOnce(CONSOLE_WORKFLOW);
    expect(await t.manager.confirmationState(t.uri)).toBe('needed');
  });
});

describe('createRunManager origin', () => {
  it('records the origin in the run, the history and the log', async () => {
    const t = quiet();
    const runId = (await t.manager.start(t.uri, {}, { origin: TRIGGER })) as string;
    const view = await t.manager.whenFinished(runId);
    expect(t.events[0]).toMatchObject({ type: 'run-start', origin: TRIGGER });
    expect(view?.origin).toEqual(TRIGGER);
    expect(t.history.list()[0].origin).toEqual(TRIGGER);
    expect(t.logLines).toContainEqual(expect.stringContaining('started on save of src/a.ts'));
  });

  it('leaves the origin out for manual runs', async () => {
    const t = quiet();
    const runId = (await t.manager.start(t.uri, {}, { origin: { kind: 'manual' } })) as string;
    await t.manager.whenFinished(runId);
    expect('origin' in t.events[0]).toBe(false);
    expect(t.history.list()[0].origin).toBeUndefined();
  });

  it('records the origin of runs that stop before the engine', async () => {
    const text = `version: 1
name: Fix
isolation: worktree
setup: [npm ci]
steps:
  - id: build
    type: console
    run: npm run build
`;
    const t = quiet({
      text,
      runCommand: async () => ({ exitCode: 1, stdout: '', stderr: 'no', output: 'no', timedOut: false }),
    });
    const runId = (await t.manager.start(t.uri, {}, { origin: { kind: 'copilot' } })) as string;
    const view = await t.manager.whenFinished(runId);
    expect(view?.status).toBe('failure');
    expect(t.events[0]).toMatchObject({ type: 'run-start', origin: { kind: 'copilot' } });
  });
});
