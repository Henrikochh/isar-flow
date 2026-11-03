import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AgentDefinition } from '@isar-flow/core';
import { createEngineHost } from '../../../src/run/engineHost';
import { flush } from './fakes';
import { setup, untilAborted } from './managerSetup';

// The real engine host, recorded so tests can check what the manager configures it with.
vi.mock('../../../src/run/engineHost', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/run/engineHost')>();
  return { ...real, createEngineHost: vi.fn(real.createEngineHost) };
});

describe('createRunManager', () => {
  it('runs a console workflow end to end', async () => {
    const t = setup();
    const runId = await t.manager.start(t.uri);
    expect(runId).toMatch(/^run-[0-9a-z]+/);
    expect(t.manager.active(t.uri.toString())).toHaveLength(1);

    const view = await t.manager.whenFinished(runId as string);
    expect(view?.status).toBe('success');
    expect(view?.steps.build.status).toBe('success');
    expect(t.events.map((e) => e.type)).toEqual([
      'run-start',
      'step-start',
      'step-log',
      'step-end',
      'run-end',
    ]);
    expect(t.commands[0]).toMatchObject({ command: 'npm run build', shell: 'auto' });
    expect(t.deps.terminalFor).toHaveBeenCalledWith('Build');
    expect(t.terminal.text).toContain('▶ build');
    expect(t.manager.active()).toEqual([]);
    expect(t.runsChanged).toHaveBeenCalledTimes(2);

    const [record] = t.manager.history.list(t.uri.toString());
    expect(record).toMatchObject({ runId, status: 'success', workflowName: 'Build' });
    expect(t.manager.history.get(runId as string)?.steps.build.status).toBe('success');

    expect(t.logLines.some((l) => l.startsWith('info:') && l.includes(runId as string))).toBe(true);
    expect(t.logLines.some((l) => l.includes('succeeded'))).toBe(true);
  });

  it('shows a status bar item while running that opens the workflow editor', async () => {
    const t = setup({ runCommand: untilAborted });
    const runId = (await t.manager.start(t.uri)) as string;
    const [item] = t.statusItems;
    expect(item.shown).toBe(true);
    expect(item.text).toMatch(/^\$\(sync~spin\) Build 0:0\d$/);
    expect(item.command).toMatchObject({
      command: 'vscode.openWith',
      arguments: [t.uri, 'isarFlow.workflowEditor'],
    });
    t.manager.cancel(runId);
    await t.manager.whenFinished(runId);
    expect(item.disposed).toBe(true);
  });

  it('refuses to run in untrusted workspaces', async () => {
    const t = setup({ trusted: false, click: 'Manage Workspace Trust' });
    expect(await t.manager.start(t.uri)).toBeUndefined();
    await flush();
    expect(t.notifications[0]).toMatchObject({ kind: 'warning', buttons: ['Manage Workspace Trust'] });
    expect(t.notifications[0].message).toMatch(/trust/i);
    expect(t.ui.executeCommand).toHaveBeenCalledWith('workbench.trust.manage');
    expect(t.ui.readText).not.toHaveBeenCalled();
    expect(t.commands).toHaveLength(0);
  });

  it('refuses a second run of the same workflow while one is live', async () => {
    const t = setup({ runCommand: untilAborted });
    const runId = (await t.manager.start(t.uri)) as string;
    expect(await t.manager.start(t.uri)).toBeUndefined();
    await flush();
    expect(t.notifications).toContainEqual({
      kind: 'info',
      message: 'This workflow is already running.',
      buttons: [],
    });
    t.manager.cancel(runId);
    await t.manager.whenFinished(runId);
  });

  it('stops runs on shutdown and resolves once they are saved to the history', async () => {
    const t = setup({ runCommand: untilAborted });
    const runId = (await t.manager.start(t.uri)) as string;
    await flush();
    await t.manager.shutdown();
    expect(t.manager.history.list(t.uri.toString()).map((r) => [r.runId, r.status])).toEqual([
      [runId, 'cancelled'],
    ]);
    expect(t.manager.active()).toEqual([]);
    expect(await t.manager.start(t.uri)).toBeUndefined();
  });

  it('ends a cancelled run as cancelled and saves it', async () => {
    const t = setup({ runCommand: untilAborted });
    const runId = (await t.manager.start(t.uri)) as string;
    await flush();
    expect(t.manager.active(t.uri.toString())[0].view.activeStepId).toBe('build');

    t.manager.cancel(runId);
    const view = await t.manager.whenFinished(runId);
    expect(view?.status).toBe('cancelled');
    const end = t.events.at(-1);
    expect(end).toMatchObject({ type: 'run-end', status: 'cancelled' });
    expect(t.manager.history.list()[0]).toMatchObject({ runId, status: 'cancelled' });
    expect(t.manager.active()).toEqual([]);
  });

  it('blocks runs of invalid workflows and points to the problems', async () => {
    const t = setup({
      text: 'version: 1\nname: Bad\nsteps:\n  - id: a\n    type: console\n',
      click: 'Show problems',
    });
    expect(await t.manager.start(t.uri)).toBeUndefined();
    await flush();
    expect(t.notifications[0]).toMatchObject({
      kind: 'error',
      message: 'Fix 1 problem in build.workflow.yaml before running.',
      buttons: ['Show problems'],
    });
    expect(t.ui.executeCommand).toHaveBeenCalledWith('workbench.actions.view.problems');
    expect(t.commands).toHaveLength(0);
  });

  it('counts YAML syntax errors and unknown agents as problems', async () => {
    const syntax = setup({ text: 'version: 1\nname: [oops\n' });
    expect(await syntax.manager.start(syntax.uri)).toBeUndefined();
    await flush();
    expect(syntax.notifications[0].message).toMatch(
      /^Fix \d+ problems? in build\.workflow\.yaml before running\.$/,
    );

    const agentText = `version: 1
name: Ask
steps:
  - id: ask
    type: agent
    agent: coder
    prompt: Hi
  - id: ask2
    type: agent
    agent: missing
    prompt: Hi
`;
    const unknownAgent = setup({ text: agentText, agents: { coder: { name: 'Coder', model: 'x/y' } } });
    expect(await unknownAgent.manager.start(unknownAgent.uri)).toBeUndefined();
    await flush();
    expect(unknownAgent.notifications[0].message).toBe(
      'Fix 1 problem in build.workflow.yaml before running.',
    );

    const known = setup({
      text: agentText.replace('agent: missing', 'agent: coder'),
      agents: { coder: { name: 'Coder', model: 'x/y' } },
    });
    const runId = await known.manager.start(known.uri);
    expect(runId).toBeDefined();
    expect((await known.manager.whenFinished(runId as string))?.status).toBe('failure');
  });

  it('asks for inputs only when none are given', async () => {
    const text = `version: 1
name: Greet
inputs:
  who: { type: string, required: true }
steps:
  - id: hello
    type: console
    run: echo \${{ inputs.who }}
`;
    const asked = setup({ text, inputs: { who: 'world' } });
    const runId = (await asked.manager.start(asked.uri)) as string;
    await asked.manager.whenFinished(runId);
    expect(asked.ui.promptInputs).toHaveBeenCalledTimes(1);
    expect(asked.commands[0].command).toBe('echo world');

    const given = setup({ text });
    const second = (await given.manager.start(given.uri, { who: 'you' })) as string;
    await given.manager.whenFinished(second);
    expect(given.ui.promptInputs).not.toHaveBeenCalled();
    expect(given.commands[0].command).toBe('echo you');

    const cancelled = setup({ text, inputs: undefined });
    expect(await cancelled.manager.start(cancelled.uri)).toBeUndefined();
    expect(cancelled.commands).toHaveLength(0);
  });

  it('confirms console commands unless remembered or disabled', async () => {
    const declined = setup({ confirm: undefined });
    expect(await declined.manager.start(declined.uri)).toBeUndefined();
    expect(declined.commands).toHaveLength(0);
    const [message, detail] = (declined.ui.confirmCommands as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      string,
    ];
    expect(message).toBe("Run 'Build'? It runs these commands in your workspace:");
    expect(detail).toContain('npm run build');

    const remembered = setup({ confirm: 'Run and remember' });
    await remembered.manager.whenFinished((await remembered.manager.start(remembered.uri)) as string);
    await remembered.manager.whenFinished((await remembered.manager.start(remembered.uri)) as string);
    expect(remembered.ui.confirmCommands).toHaveBeenCalledTimes(1);

    const disabled = setup({ settings: { confirmCommands: false } });
    await disabled.manager.whenFinished((await disabled.manager.start(disabled.uri)) as string);
    expect(disabled.ui.confirmCommands).not.toHaveBeenCalled();
  });

  describe('agents that act without asking', () => {
    const text = `version: 1
name: Implement
steps:
  - id: implement
    type: agent
    agent: coder
    prompt: Implement it
`;
    const coder = (permissions: AgentDefinition['permissions']): Record<string, AgentDefinition> => ({
      coder: { name: 'Coder', model: 'x/y', tools: ['readFile', 'editFile', 'runCommand'], permissions },
    });
    const calls = (t: ReturnType<typeof setup>) =>
      (t.ui.confirmCommands as ReturnType<typeof vi.fn>).mock.calls as [string, string, string[]][];

    it('are confirmed before a workflow without console blocks runs', async () => {
      const declined = setup({
        text,
        agents: coder({ edits: 'auto', commands: 'auto' }),
        confirm: undefined,
      });
      expect(await declined.manager.start(declined.uri)).toBeUndefined();
      const [[message, detail]] = calls(declined);
      expect(message).toBe("Run 'Implement'? These agents can change your workspace without asking:");
      expect(detail).toContain(
        "agent 'coder' in block 'implement': edits files and runs commands without asking",
      );
      expect(declined.manager.active()).toEqual([]);
      expect(declined.events).toEqual([]);
    });

    it('are listed after the console commands', async () => {
      const both = text + '  - id: test\n    type: console\n    run: npm test\n';
      const t = setup({ text: both, agents: coder({ edits: 'auto' }), confirm: undefined });
      await t.manager.start(t.uri);
      const [[message, detail]] = calls(t);
      expect(message).toBe(
        "Run 'Implement'? It runs these commands and lets agents change your workspace without asking:",
      );
      expect(detail).toMatch(
        /npm test\n\nAgents that act without asking:\n• agent 'coder' in block 'implement': edits files without asking/,
      );
    });

    it('need approval again when their permissions change', async () => {
      const agents = coder({ edits: 'auto' });
      const t = setup({ text, agents, confirm: 'Run and remember' });
      await t.manager.whenFinished((await t.manager.start(t.uri)) as string);
      await t.manager.whenFinished((await t.manager.start(t.uri)) as string);
      expect(calls(t)).toHaveLength(1);

      agents.coder = { ...agents.coder, permissions: { edits: 'auto', commands: 'auto' } };
      await t.manager.whenFinished((await t.manager.start(t.uri)) as string);
      expect(calls(t)).toHaveLength(2);
      expect(calls(t)[1][1]).toContain('edits files and runs commands without asking');
    });

    it('run with the agent files the question was about', async () => {
      const t = setup({ text, agents: coder({ edits: 'auto' }) });
      // The agent file is deleted while the question is open: the run still uses what was confirmed.
      (t.ui.confirmCommands as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
        t.deps.agents.definitions = () => ({});
        return 'Run';
      });
      const view = await t.manager.whenFinished((await t.manager.start(t.uri)) as string);
      expect(calls(t)).toHaveLength(1);
      expect(view?.steps.implement.error).toBeDefined();
      expect(view?.steps.implement.error).not.toContain("Agent 'coder' not found");
    });

    it('are not asked about when they ask first or confirmation is off', async () => {
      const asking = setup({ text, agents: coder({ edits: 'ask', commands: 'ask' }) });
      await asking.manager.whenFinished((await asking.manager.start(asking.uri)) as string);
      expect(asking.ui.confirmCommands).not.toHaveBeenCalled();

      const disabled = setup({
        text,
        agents: coder({ edits: 'auto', commands: 'auto' }),
        settings: { confirmCommands: false },
      });
      await disabled.manager.whenFinished((await disabled.manager.start(disabled.uri)) as string);
      expect(disabled.ui.confirmCommands).not.toHaveBeenCalled();
    });
  });

  it('passes settings, secrets and the process environment to the engine', async () => {
    const text = `version: 1
name: Env
steps:
  - id: show
    type: console
    run: echo \${{ env.GREETING }} \${{ secrets.TOKEN }}
`;
    const t = setup({ text, settings: { defaultShell: 'bash' }, env: { GREETING: 'hi', EMPTY: undefined } });
    await t.secrets.set('TOKEN', 's3cret');
    const runId = (await t.manager.start(t.uri)) as string;
    await t.manager.whenFinished(runId);
    expect(t.commands[0]).toMatchObject({ command: 'echo hi s3cret', shell: 'bash' });
  });

  it.each([
    [undefined, 24_000],
    [32_000, 32_000],
    [500, 2000],
    ['lots', 24_000],
  ])('gives agents the context size from isarFlow.agentContextTokens (%s)', async (value, expected) => {
    const host = vi.mocked(createEngineHost);
    host.mockClear();
    const t = setup(value === undefined ? {} : { settings: { agentContextTokens: value } });
    const runId = (await t.manager.start(t.uri)) as string;
    await t.manager.whenFinished(runId);
    expect(host).toHaveBeenCalledTimes(1);
    expect(host.mock.calls[0][0].contextTokens).toBe(expected);
  });

  it("works in the workflow's own workspace folder", async () => {
    const text = `version: 1
name: Folder
steps:
  - id: build
    type: console
    run: npm run build
    cwd: app
  - id: ask
    type: agent
    agent: coder
    prompt: Hi
    context:
      files: [README.md]
`;
    const agents = { coder: { name: 'Coder', model: 'x/y' } };
    const t = setup({ text, agents, folder: '/second', root: '/second' });
    const runId = (await t.manager.start(t.uri)) as string;
    await t.manager.whenFinished(runId);
    expect(t.ui.workspaceFolder).toHaveBeenCalledWith(t.uri);
    expect(t.commands[0].cwd).toBe(path.resolve('/second', 'app'));
    expect(t.deps.tools).toHaveBeenCalledWith(runId, '/second', { journal: t.safety.journal });
    expect(t.contextReads).toEqual([{ root: '/second', globs: ['README.md'] }]);
  });

  it('keeps agent tools and context files out of the folder of a workflow outside all folders', async () => {
    const text = `version: 1
name: Loose
steps:
  - id: build
    type: console
    run: npm run build
  - id: ask
    type: agent
    agent: coder
    prompt: Hi
    context:
      files: [README.md]
`;
    const t = setup({
      text,
      agents: { coder: { name: 'Coder', model: 'x/y' } },
      folder: null,
      root: '/loose',
    });
    const runId = (await t.manager.start(t.uri)) as string;
    await t.manager.whenFinished(runId);
    // Console commands run beside the file; tools and context files use the default (first) folder.
    expect(t.commands[0].cwd).toBe(path.resolve('/loose'));
    expect(t.deps.tools).toHaveBeenCalledWith(runId, undefined, { journal: t.safety.journal });
    expect(t.contextReads).toEqual([{ root: undefined, globs: ['README.md'] }]);
  });

  it('logs failed blocks and saves failed runs', async () => {
    const t = setup({
      runCommand: async () => ({ exitCode: 2, stdout: '', stderr: 'nope', output: 'nope', timedOut: false }),
    });
    const runId = (await t.manager.start(t.uri)) as string;
    const view = await t.manager.whenFinished(runId);
    expect(view?.status).toBe('failure');
    expect(
      t.logLines.some((l) => l.startsWith('warn:') && l.includes("'build'") && l.includes('code 2')),
    ).toBe(true);
    expect(t.manager.history.list()[0].status).toBe('failure');
  });

  it('routes approvals to an attached editor and cancels them with the run', async () => {
    const text = `version: 1
name: Gate
steps:
  - id: gate
    type: approval
    message: Ship it?
`;
    const t = setup({ text });
    const resolved = vi.fn();
    t.manager.approvals.onDidResolve(resolved);
    const requests: string[] = [];
    t.manager.approvals.onDidRequest((r) => requests.push(r.requestId));
    t.manager.approvals.attach(t.uri.toString());

    const approvedRun = (await t.manager.start(t.uri)) as string;
    await flush();
    t.manager.approvals.respond(requests[0], { approved: true });
    expect((await t.manager.whenFinished(approvedRun))?.status).toBe('success');

    const cancelledRun = (await t.manager.start(t.uri)) as string;
    await flush();
    expect(requests).toHaveLength(2);
    t.manager.cancel(cancelledRun);
    expect((await t.manager.whenFinished(cancelledRun))?.status).toBe('cancelled');
    expect(resolved).toHaveBeenCalledTimes(2);
  });

  it('aborts live runs on dispose', async () => {
    const t = setup({ runCommand: untilAborted });
    const runId = (await t.manager.start(t.uri)) as string;
    const finished = t.manager.whenFinished(runId);
    t.manager.dispose();
    expect((await finished)?.status).toBe('cancelled');
  });
});

const WORKTREE_WORKFLOW = `version: 1
name: Fix
isolation: worktree
setup: [npm ci]
steps:
  - id: build
    type: console
    run: npm run build
  - id: ask
    type: agent
    agent: coder
    prompt: Hi
    context:
      files: [README.md]
`;

describe('createRunManager safety net', () => {
  it('snapshots the folder, journals agent writes and publishes the review after saving the run', async () => {
    const t = setup();
    expect(t.manager.reviews).toBe(t.safety.safety.reviews);
    expect(t.safety.safety.cleanup).toHaveBeenCalledTimes(1);
    const runId = (await t.manager.start(t.uri)) as string;
    await t.manager.whenFinished(runId);
    const [session] = t.safety.sessions;
    expect(session.options).toEqual({
      runId,
      workflowUri: t.uri.toString(),
      folder: '/ws',
      isolation: 'workspace',
    });
    expect(session.finish).toHaveBeenCalledWith({ skipSnapshot: false });
    expect(t.safety.order).toEqual(['begin', 'finish', 'publish']);
    expect(t.deps.tools).toHaveBeenCalledWith(runId, '/ws', { journal: t.safety.journal });
    expect(t.notifications.filter((n) => n.message.includes('changed'))).toEqual([]);
  });

  it('says how many files a run changed and opens the review', async () => {
    const t = setup({ safety: { changed: 3 }, click: 'Review changes' });
    const runId = (await t.manager.start(t.uri)) as string;
    await t.manager.whenFinished(runId);
    await flush();
    expect(t.notifications).toContainEqual({
      kind: 'info',
      message: 'Build changed 3 files.',
      buttons: ['Review changes'],
    });
    expect(t.ui.executeCommand).toHaveBeenCalledWith('isarFlow.internal.showRun', t.uri.toString(), runId);
    expect(t.history.list()[0].runId).toBe(runId);

    const one = setup({ safety: { changed: 1 } });
    await one.manager.whenFinished((await one.manager.start(one.uri)) as string);
    await flush();
    expect(one.notifications.map((n) => n.message)).toContain('Build changed 1 file.');
  });

  it('skips the after snapshot when VS Code closes during the run', async () => {
    const t = setup({ runCommand: untilAborted });
    const runId = (await t.manager.start(t.uri)) as string;
    await flush();
    await t.manager.shutdown();
    expect(t.safety.sessions[0].finish).toHaveBeenCalledWith({ skipSnapshot: true });
    expect(t.history.list()[0]).toMatchObject({ runId, status: 'cancelled' });
  });

  it('keeps running without the safety net when the snapshot fails unexpectedly', async () => {
    const t = setup({ safety: { beginError: 'disk full' } });
    const view = await t.manager.whenFinished((await t.manager.start(t.uri)) as string);
    expect(view?.status).toBe('success');
    expect(t.logLines.some((l) => l.startsWith('warn:') && l.includes('disk full'))).toBe(true);
  });

  it('runs worktree workflows in the worktree: setup, commands, agent tools and context files', async () => {
    const t = setup({ text: WORKTREE_WORKFLOW, agents: { coder: { name: 'Coder', model: 'x/y' } } });
    const runId = (await t.manager.start(t.uri)) as string;
    await t.manager.whenFinished(runId);
    const root = `/storage/worktrees/${runId}`;
    expect(t.safety.sessions[0].options.isolation).toBe('worktree');
    expect(t.commands.map((c) => [c.command, c.cwd])).toEqual([
      ['npm ci', root],
      ['npm run build', path.resolve(root)],
    ]);
    expect(t.terminal.text).toContain('▶ setup:');
    expect(t.deps.tools).toHaveBeenCalledWith(runId, root, { journal: t.safety.journal });
    expect(t.contextReads).toEqual([{ root, globs: ['README.md'] }]);
    const [, detail] = (t.ui.confirmCommands as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect(detail).toContain('Setup: npm ci');
  });

  it('refuses worktree runs outside git repositories', async () => {
    const t = setup({
      text: WORKTREE_WORKFLOW,
      safety: { canIsolate: false },
      agents: { coder: { name: 'C', model: 'x/y' } },
    });
    expect(await t.manager.start(t.uri)).toBeUndefined();
    await flush();
    expect(t.notifications).toContainEqual({
      kind: 'error',
      message:
        'Isolation "worktree" needs a git repository. Run git init in /ws, or set isolation to workspace.',
      buttons: [],
    });
    expect(t.safety.safety.begin).not.toHaveBeenCalled();
    expect(t.commands).toEqual([]);
  });

  it('ends the run when the worktree cannot be created', async () => {
    const t = setup({
      text: WORKTREE_WORKFLOW,
      safety: { beginError: 'Could not create a git worktree for this run: no space.' },
      agents: { coder: { name: 'C', model: 'x/y' } },
    });
    const view = await t.manager.whenFinished((await t.manager.start(t.uri)) as string);
    expect(view).toMatchObject({
      status: 'failure',
      error: 'Could not create a git worktree for this run: no space.',
    });
    expect(t.events.map((e) => e.type)).toEqual(['run-start', 'run-end']);
    expect(t.commands).toEqual([]);
  });

  it('ends the run and drops the worktree when a setup command fails', async () => {
    const t = setup({
      text: WORKTREE_WORKFLOW,
      agents: { coder: { name: 'C', model: 'x/y' } },
      runCommand: async (o) => ({
        exitCode: o.command === 'npm ci' ? 1 : 0,
        stdout: '',
        stderr: '',
        output: '',
        timedOut: false,
      }),
    });
    const runId = (await t.manager.start(t.uri)) as string;
    const view = await t.manager.whenFinished(runId);
    expect(view).toMatchObject({
      status: 'failure',
      error: 'Setup command "npm ci" failed with exit code 1. See the terminal for its output.',
    });
    expect(t.events.map((e) => e.type)).toEqual(['run-start', 'run-end']);
    expect(t.commands.map((c) => c.command)).toEqual(['npm ci']);
    expect(t.safety.order).toEqual(['begin', 'discard']);
    expect(t.history.list()[0]).toMatchObject({ runId, status: 'failure' });
  });

  it('ends a run cancelled during setup as cancelled', async () => {
    const t = setup({
      text: WORKTREE_WORKFLOW,
      agents: { coder: { name: 'C', model: 'x/y' } },
      runCommand: untilAborted,
    });
    const runId = (await t.manager.start(t.uri)) as string;
    await flush();
    t.manager.cancel(runId);
    const view = await t.manager.whenFinished(runId);
    expect(view?.status).toBe('cancelled');
    expect(t.safety.order).toEqual(['begin', 'discard']);
  });
});
