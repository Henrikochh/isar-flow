import { describe, expect, it } from 'vitest';
import type { ConsoleRunOptions, RunConsoleCommand } from '../../../src/contracts';
import { runSetupCommands } from '../../../src/run/setupCommands';
import { FakeTerminal } from './fakes';

const result = (exitCode: number) => ({ exitCode, stdout: '', stderr: '', output: '', timedOut: false });

function setup(runCommand: RunConsoleCommand) {
  const terminal = new FakeTerminal();
  const calls: ConsoleRunOptions[] = [];
  const controller = new AbortController();
  const run = (commands: string[]) =>
    runSetupCommands({
      commands,
      cwd: '/wt/app',
      shell: 'bash',
      runCommand: (options) => {
        calls.push(options);
        return runCommand(options);
      },
      terminal,
      signal: controller.signal,
      now: () => 0,
    });
  return { terminal, calls, controller, run };
}

describe('runSetupCommands', () => {
  it('runs the commands one after the other in the worktree and mirrors them to the terminal', async () => {
    const t = setup(async (options) => {
      options.onData('stdout', `ran ${options.command}\n`);
      return result(0);
    });
    expect(await t.run(['npm ci', 'npm run build'])).toBeUndefined();
    expect(t.calls.map((c) => [c.command, c.cwd, c.shell])).toEqual([
      ['npm ci', '/wt/app', 'bash'],
      ['npm run build', '/wt/app', 'bash'],
    ]);
    expect(t.terminal.text).toContain('▶ setup:');
    expect(t.terminal.text).toContain('npm ci\r\nran npm ci\r\n');
    expect(t.terminal.text).toContain('✓ exit 0');
    expect(t.terminal.shown).toBe(1);
  });

  it('stops at the first failing command', async () => {
    const t = setup(async (options) => result(options.command === 'npm ci' ? 1 : 0));
    expect(await t.run(['npm ci', 'npm run build'])).toEqual({
      error: 'Setup command "npm ci" failed with exit code 1. See the terminal for its output.',
    });
    expect(t.calls).toHaveLength(1);
    expect(t.terminal.text).toContain('✗ exit 1');
  });

  it('reports commands that cannot start and cancelled setups', async () => {
    const broken = setup(async () => Promise.reject(new Error('spawn bash ENOENT')));
    expect(await broken.run(['npm ci'])).toEqual({
      error: 'Setup command "npm ci" could not run: spawn bash ENOENT.',
    });

    const t = setup(
      (options) =>
        new Promise((resolve) => options.signal.addEventListener('abort', () => resolve(result(1)))),
    );
    const running = t.run(['npm ci', 'npm test']);
    t.controller.abort();
    expect(await running).toEqual({ cancelled: true });
    expect(t.calls).toHaveLength(1);
  });
});
