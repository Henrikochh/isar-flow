import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConsoleResult, GitContext } from '@isar-flow/core';
import type { ConsoleRunOptions } from '@isar-flow/core/node';
import { runCli } from '../src/run';
import { captureStream, makeTempDir, removeDir, scriptedInput, testIo, writeFile } from './helpers';

let root: string;

beforeEach(() => {
  root = makeTempDir('isar cli run-');
  fs.mkdirSync(path.join(root, '.isarflow', 'workflows'), { recursive: true });
});
afterEach(() => removeDir(root));

const workflow = (name: string, text: string) =>
  writeFile(root, `.isarflow/workflows/${name}.workflow.yaml`, text);

/** A console runner that prints `output` and exits with `exitCode`, recording each call. */
function fakeRunner(exitCode = 0, output = (options: ConsoleRunOptions) => `ran ${options.command}\n`) {
  const calls: ConsoleRunOptions[] = [];
  const run = async (options: ConsoleRunOptions): Promise<ConsoleResult> => {
    calls.push(options);
    const text = output(options);
    options.onData('stdout', text);
    return { exitCode, stdout: text, stderr: '', output: text, timedOut: false };
  };
  return { run, calls };
}

const HELLO = [
  'version: 1',
  'name: Hello',
  'inputs:',
  '  name: { type: string, required: true }',
  '  count: { type: number, default: 2 }',
  '  loud: { type: boolean }',
  'steps:',
  '  - id: greet',
  '    type: console',
  '    run: echo Hello ${{ inputs.name }} ${{ inputs.count }} ${{ inputs.loud }}',
  '',
].join('\n');

describe('runCli basics', () => {
  it('prints help, the version and usage errors', async () => {
    const help = testIo(root);
    expect(await runCli(['--help'], help)).toBe(0);
    expect(help.stdout.text()).toContain('Usage: isar-flow run <file>');

    const version = testIo(root);
    expect(await runCli(['--version'], version)).toBe(0);
    expect(version.stdout.text()).toMatch(/^\d+\.\d+\.\d+\n$/);

    const usage = testIo(root);
    expect(await runCli(['mcp'], usage)).toBe(1);
    expect(usage.stderr.text()).toBe(
      "Unknown command 'mcp'. Use isar-flow run <file>.\nRun isar-flow --help to see the options.\n",
    );
    expect(usage.stdout.text()).toBe('');
  });

  it('says how to find a workflow that does not exist', async () => {
    const io = testIo(root);
    expect(await runCli(['run', 'fix-tests'], io)).toBe(1);
    expect(io.stderr.text()).toContain("Could not find 'fix-tests'.");
  });

  it('lists the errors of an invalid workflow with file:line:col', async () => {
    workflow(
      'broken',
      'version: 1\nname: Broken\nsteps:\n  - id: a\n    type: console\n    run: x\n    colour: red\n',
    );
    const io = testIo(root);
    expect(await runCli(['run', 'broken'], io)).toBe(1);
    expect(io.stderr.text()).toMatch(
      new RegExp(`${['.isarflow', 'workflows', 'broken.workflow.yaml'].join('[\\\\/]')}:7:\\d+ error `),
    );
    expect(io.stderr.text()).toContain('The workflow has 1 error. Fix it and run again.');
  });
});

describe('runCli console workflows', () => {
  it('runs a workflow with inputs converted from text and exits with 0', async () => {
    workflow('hello', HELLO);
    const runner = fakeRunner();
    const io = testIo(root, { runCommand: runner.run });
    const code = await runCli(['run', 'hello', '--input', 'name=World', '--input', 'loud=yes'], io);
    expect(io.stderr.text()).toBe('');
    expect(code).toBe(0);
    expect(runner.calls[0]).toMatchObject({ command: 'echo Hello World 2 true', cwd: root, shell: 'auto' });
    const out = io.stdout.text();
    expect(out).toContain(`Running Hello (.isarflow/workflows/hello.workflow.yaml)\n`);
    expect(out).toContain(
      '▶ greet (Console)\n    $ echo Hello World 2 true\n    ran echo Hello World 2 true\n',
    );
    expect(out).toMatch(/✓ greet succeeded in \d+ ms/);
    expect(out).toMatch(/\nSucceeded in .+: 1 block succeeded\.\n$/);
    expect(out).not.toContain('\x1b[');
  });

  it('exits with 1 when a block fails', async () => {
    workflow('hello', HELLO);
    const io = testIo(root, { runCommand: fakeRunner(3).run });
    expect(await runCli(['run', 'hello', '--input', 'name=x'], io)).toBe(1);
    expect(io.stdout.text()).toMatch(/✗ greet failed in .+\n\nFailed in /);
  });

  it('refuses missing required inputs and values of the wrong type before running', async () => {
    workflow('hello', HELLO);
    const runner = fakeRunner();
    const missing = testIo(root, { runCommand: runner.run });
    expect(await runCli(['run', 'hello'], missing)).toBe(1);
    expect(missing.stderr.text()).toBe("Input 'name' is required. Pass --input name=value.\n");
    const wrong = testIo(root, { runCommand: runner.run });
    expect(await runCli(['run', 'hello', '--input', 'name=a', '--input', 'count=lots'], wrong)).toBe(1);
    expect(wrong.stderr.text()).toContain("Input 'count' must be a number, but got 'lots'.");
    expect(runner.calls).toHaveLength(0);
  });

  it('runs commands for real in the workspace folder, also with spaces in its path', async () => {
    workflow(
      'real',
      'version: 1\nname: Real\nsteps:\n  - id: sum\n    type: console\n    run: node -e "console.log(40+2)"\n',
    );
    const io = testIo(path.join(root, '.isarflow'));
    expect(await runCli(['run', 'workflows/real.workflow.yaml'], io)).toBe(0);
    expect(io.stdout.text()).toContain('    42\n');
  }, 30_000);

  it('masks secrets from ISARFLOW_SECRET_ variables in the output', async () => {
    workflow(
      'secret',
      'version: 1\nname: S\nsteps:\n  - id: show\n    type: console\n    run: echo ${{ secrets.api_token }}\n',
    );
    const runner = fakeRunner();
    const io = testIo(root, { runCommand: runner.run, env: { ISARFLOW_SECRET_API_TOKEN: 'tok-12345' } });
    expect(await runCli(['run', 'secret'], io)).toBe(0);
    expect(runner.calls[0].command).toBe('echo tok-12345');
    expect(io.stdout.text()).not.toContain('tok-12345');
    expect(io.stdout.text()).toContain('ran echo ••••••');
  });

  it('refuses workflows that run in a separate worktree', async () => {
    workflow(
      'wt',
      'version: 1\nname: WT\nisolation: worktree\nsteps:\n  - id: a\n    type: console\n    run: x\n',
    );
    const io = testIo(root, { runCommand: fakeRunner().run });
    expect(await runCli(['run', 'wt'], io)).toBe(1);
    expect(io.stderr.text()).toContain("The command line can't run workflows in a separate worktree");
  });

  it('captures git values only for workflows that read them', async () => {
    const git: GitContext = { branch: 'feature/x', changedFiles: ['a.ts'], diff: '' };
    const captureGit = vi.fn(async () => git);
    workflow(
      'branch',
      'version: 1\nname: B\nsteps:\n  - id: a\n    type: console\n    run: echo ${{ git.branch }}\n',
    );
    workflow('hello', HELLO);
    const runner = fakeRunner();
    expect(await runCli(['run', 'branch'], testIo(root, { runCommand: runner.run, captureGit }))).toBe(0);
    expect(runner.calls[0].command).toBe('echo feature/x');
    expect(captureGit).toHaveBeenCalledWith(
      root,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    captureGit.mockClear();
    await runCli(['run', 'hello', '--input', 'name=a'], testIo(root, { runCommand: runner.run, captureGit }));
    expect(captureGit).not.toHaveBeenCalled();
  });
});

describe('runCli --json', () => {
  it('prints exactly one JSON document on stdout and the progress on stderr', async () => {
    workflow('hello', HELLO);
    const io = testIo(root, { runCommand: fakeRunner().run });
    expect(await runCli(['run', 'hello', '--json', '--input', 'name=World'], io)).toBe(0);
    const result = JSON.parse(io.stdout.text()) as Record<string, unknown>;
    expect(result).toMatchObject({
      workflow: { name: 'Hello', file: '.isarflow/workflows/hello.workflow.yaml' },
      status: 'success',
      origin: { kind: 'cli' },
      inputs: { name: 'World', count: 2 },
      steps: { greet: { status: 'success', output: { exitCode: 0, stdout: 'ran echo Hello World 2 \n' } } },
    });
    expect(result.runId).toMatch(/^run-/);
    expect(io.stderr.text()).toContain('Running Hello');
  });

  it('prints a JSON failure when the run cannot start', async () => {
    const io = testIo(root);
    expect(await runCli(['run', 'nope', '--json'], io)).toBe(1);
    expect(JSON.parse(io.stdout.text())).toMatchObject({
      status: 'failure',
      error: expect.stringContaining("'nope'"),
    });
  });
});

describe('runCli --simulate', () => {
  it('uses the mocks of the simulation file and executes nothing', async () => {
    workflow('hello', HELLO);
    writeFile(
      root,
      '.isarflow/simulations/hello.sim.yaml',
      'blocks:\n  greet:\n    - exitCode: 4\n      output: pretend\n',
    );
    writeFile(root, '.isarflow/config.yaml', 'providers: [oops]\n');
    const runner = fakeRunner();
    const io = testIo(root, { runCommand: runner.run });
    expect(await runCli(['run', 'hello', '--simulate', '--json', '--input', 'name=a'], io)).toBe(1);
    expect(runner.calls).toHaveLength(0);
    const result = JSON.parse(io.stdout.text()) as { simulated: boolean; steps: Record<string, unknown> };
    expect(result.simulated).toBe(true);
    expect(result.steps.greet).toMatchObject({ status: 'failure', output: { exitCode: 4 } });
    expect(io.stderr.text()).toContain('Simulated run: nothing is executed; results come from');
    expect(io.stderr.text()).toContain('pretend');
  });

  it('never runs git, also for workflows that read git values', async () => {
    const captureGit = vi.fn(async (): Promise<GitContext> => ({
      branch: 'main',
      changedFiles: [],
      diff: '',
    }));
    workflow(
      'branch',
      'version: 1\nname: B\nsteps:\n  - id: a\n    type: console\n    run: echo ${{ git.branch }}\n',
    );
    const runner = fakeRunner();
    const io = testIo(root, { runCommand: runner.run, captureGit });
    expect(await runCli(['run', 'branch', '--simulate'], io)).toBe(0);
    expect(captureGit).not.toHaveBeenCalled();
    expect(runner.calls).toHaveLength(0);
    expect(io.stdout.text()).toContain(
      'Simulated run: nothing is executed; every block gets its default result.\n',
    );
    expect(io.stdout.text()).toContain("git.* is empty: simulated runs don't run git.\n");
  });

  it('refuses a simulation file with errors', async () => {
    workflow('hello', HELLO);
    writeFile(root, '.isarflow/simulations/hello.sim.yaml', 'blocks:\n  greet:\n    - exitCode: x\n');
    const io = testIo(root);
    expect(await runCli(['run', 'hello', '--simulate', '--input', 'name=a'], io)).toBe(1);
    expect(io.stderr.text()).toContain('The simulation file has 1 error.');
  });
});

describe('runCli config', () => {
  it('refuses an API key in the config file', async () => {
    workflow('hello', HELLO);
    writeFile(
      root,
      '.isarflow/config.yaml',
      'providers:\n  - id: a\n    baseUrl: http://x\n    apiKey: sk-1\n',
    );
    const io = testIo(root, { runCommand: fakeRunner().run });
    expect(await runCli(['run', 'hello', '--input', 'name=a'], io)).toBe(1);
    expect(io.stderr.text()).toContain('apiKeyEnv');
    expect(io.stderr.text()).toContain('The config file has 1 error.');
  });
});

describe('runCli asks and approvals', () => {
  const SHIP = [
    'version: 1',
    'name: Ship',
    'steps:',
    '  - id: target',
    '    type: ask',
    '    question: Where to?',
    '    choices: [dev, prod]',
    '    default: dev',
    '  - id: ok',
    '    type: approval',
    '    message: Ship to ${{ steps.target.answer }}?',
    '  - id: ship',
    '    type: console',
    '    run: echo shipped to ${{ steps.target.answer }}',
    '',
  ].join('\n');

  it('asks in the terminal', async () => {
    workflow('ship', SHIP);
    const runner = fakeRunner();
    const io = testIo(root, { runCommand: runner.run, stdin: scriptedInput(['2', 'y', 'go']) });
    expect(await runCli(['run', 'ship'], io)).toBe(0);
    expect(runner.calls[0].command).toBe('echo shipped to prod');
    expect(io.stderr.text()).toContain('Question from target: Where to?\n  1) dev (default)\n  2) prod\n');
    expect(io.stderr.text()).toContain('Approval needed in ok: Ship to prod?');
    expect(io.stdout.text()).toContain('✓ ok succeeded in');
    expect(io.stdout.text()).toContain('(approved: go)');
  });

  it('approves and uses defaults with --yes, also without a terminal', async () => {
    workflow('ship', SHIP);
    const runner = fakeRunner();
    const io = testIo(root, { runCommand: runner.run });
    expect(await runCli(['run', 'ship', '--yes'], io)).toBe(0);
    expect(runner.calls[0].command).toBe('echo shipped to dev');
    expect(io.stderr.text()).toContain('Approved (--yes)');
  });

  it("prints a block's start line before its question or approval", async () => {
    workflow('ship', SHIP);
    // One stream for both, as in a terminal: the order of the lines is what a person sees.
    const terminal = captureStream();
    const io = testIo(root, { runCommand: fakeRunner().run, stdout: terminal, stderr: terminal });
    expect(await runCli(['run', 'ship', '--yes'], io)).toBe(0);
    const text = terminal.text();
    expect(text.indexOf('▶ target (Ask)')).toBeGreaterThan(-1);
    expect(text.indexOf('▶ target (Ask)')).toBeLessThan(text.indexOf('Question from target'));
    expect(text.indexOf('▶ ok (Approval)')).toBeLessThan(text.indexOf('Approval needed in ok'));
  });

  it('refuses to ask without a terminal', async () => {
    workflow('ship', SHIP);
    const io = testIo(root, { runCommand: fakeRunner().run });
    expect(await runCli(['run', 'ship'], io)).toBe(1);
    expect(io.stdout.text()).toMatch(
      /✗ target failed in \d+ ms: No terminal to ask in\. Run with --yes to approve and use default answers\./,
    );
  });

  it('uses the default when nobody answers in time', async () => {
    workflow(
      'wait',
      'version: 1\nname: Wait\nsteps:\n  - id: pick\n    type: ask\n    question: Which?\n    choices: [a, b]\n    default: b\n    timeout: 1\n',
    );
    const io = testIo(root, { stdin: scriptedInput([]) });
    expect(await runCli(['run', 'wait'], io)).toBe(0);
    expect(io.stdout.text()).toContain('(answer: b, the default after the timeout)');
  }, 10_000);
});

describe('runCli cancellation', () => {
  it('cancels the run when the signal aborts and exits with 130', async () => {
    workflow('hello', HELLO);
    const controller = new AbortController();
    let started!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    const runCommand = (options: ConsoleRunOptions) =>
      new Promise<ConsoleResult>((resolve) => {
        started();
        options.signal.addEventListener('abort', () =>
          resolve({ exitCode: 130, stdout: '', stderr: '', output: '', timedOut: false }),
        );
      });
    const io = testIo(root, { runCommand, signal: controller.signal });
    const exit = runCli(['run', 'hello', '--input', 'name=a'], io);
    await running;
    controller.abort();
    expect(await exit).toBe(130);
    expect(io.stdout.text()).toMatch(/\nCancelled after .+\n$/);
  });

  it('stops a real command and its child processes', async () => {
    workflow(
      'sleep',
      'version: 1\nname: Sleep\nsteps:\n  - id: wait\n    type: console\n    run: node -e "setTimeout(() => {}, 60000)"\n',
    );
    const controller = new AbortController();
    const io = testIo(root, { signal: controller.signal });
    const started = Date.now();
    const exit = runCli(['run', 'sleep'], io);
    setTimeout(() => controller.abort(), 1500);
    expect(await exit).toBe(130);
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 30_000);

  it('exits with 130 when cancelled before the run starts', async () => {
    workflow('hello', HELLO);
    const controller = new AbortController();
    controller.abort();
    const io = testIo(root, { signal: controller.signal, runCommand: fakeRunner().run });
    expect(await runCli(['run', 'hello', '--input', 'name=a'], io)).toBe(130);
  });
});
