import { describe, expect, it, vi } from 'vitest';
import {
  CommandApprovals,
  confirmCommands,
  consoleCommandsOf,
  hashCommands,
} from '../../../src/run/commandApproval';
import { FakeMemento, workflowOf } from './fakes';

const WORKFLOW = `version: 1
name: Build and test
steps:
  - id: install
    type: console
    run: npm ci
  - id: fix
    type: loop
    maxIterations: 3
    until: "\${{ steps.tests.exitCode == 0 }}"
    steps:
      - id: tests
        type: console
        run: npm test
      - id: check
        type: if
        condition: "\${{ steps.tests.exitCode != 0 }}"
        then:
          - id: then_cmd
            type: console
            run: echo then
        else:
          - id: else_cmd
            type: console
            run: |
              echo else
              echo twice
  - id: done
    type: console
    run: echo done
`;

describe('consoleCommandsOf', () => {
  it('lists raw run strings of nested console blocks in document order', () => {
    expect(consoleCommandsOf(workflowOf(WORKFLOW))).toEqual([
      'npm ci',
      'npm test',
      'echo then',
      'echo else\necho twice\n',
      'echo done',
    ]);
  });

  it('includes the shell, folder and environment a block sets, and the workflow environment', () => {
    const wf = workflowOf(
      [
        'version: 1',
        'name: x',
        'env:',
        '  CI: "1"',
        'steps:',
        '  - id: a',
        '    type: console',
        '    run: npm test',
        '    shell: bash',
        '    cwd: packages/app',
        '    env:',
        '      NODE_OPTIONS: --require ./hook.js',
        '  - id: b',
        '    type: console',
        '    run: npm run lint',
        '',
      ].join('\n'),
    );
    expect(consoleCommandsOf(wf)).toEqual([
      '(environment of all commands: CI=1)',
      'npm test\n(shell: bash, folder: packages/app, environment: NODE_OPTIONS=--require ./hook.js)',
      'npm run lint',
    ]);
  });

  it('gives a different list when only the environment of a command changes', () => {
    const wf = (env: string) =>
      workflowOf(`version: 1\nname: x\nsteps:\n  - id: a\n    type: console\n    run: npm test\n${env}`);
    const plain = hashCommands(consoleCommandsOf(wf('')));
    const hooked = hashCommands(consoleCommandsOf(wf('    env:\n      NODE_OPTIONS: --require ./x.js\n')));
    expect(hooked).not.toBe(plain);
    expect(consoleCommandsOf(wf(''))).toEqual(['npm test']);
  });

  it('returns nothing for workflows without console blocks', () => {
    const wf = workflowOf('version: 1\nname: x\nsteps:\n  - id: a\n    type: approval\n    message: ok?\n');
    expect(consoleCommandsOf(wf)).toEqual([]);
  });
});

describe('hashCommands', () => {
  it('is a stable sha256 hex digest', () => {
    const hash = hashCommands(['npm ci', 'npm test']);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashCommands(['npm ci', 'npm test'])).toBe(hash);
  });

  it('changes when commands or their order change', () => {
    const hash = hashCommands(['npm ci', 'npm test']);
    expect(hashCommands(['npm test', 'npm ci'])).not.toBe(hash);
    expect(hashCommands(['npm ci', 'npm test --watch'])).not.toBe(hash);
    expect(hashCommands(['npm ci npm test'])).not.toBe(hash);
    expect(hashCommands(['npm ci', 'npm', 'test'])).not.toBe(hash);
  });

  it('ignores line-ending differences between platforms', () => {
    expect(hashCommands(['echo a\r\necho b\r\n'])).toBe(hashCommands(['echo a\necho b\n']));
  });
});

describe('CommandApprovals', () => {
  it('remembers approved hashes per workflow in the memento', async () => {
    const memento = new FakeMemento();
    const approvals = new CommandApprovals(memento);
    expect(approvals.isApproved('file:///a.workflow.yaml', 'h1')).toBe(false);
    await approvals.approve('file:///a.workflow.yaml', 'h1');
    expect(approvals.isApproved('file:///a.workflow.yaml', 'h1')).toBe(true);
    expect(approvals.isApproved('file:///b.workflow.yaml', 'h1')).toBe(false);
    expect(new CommandApprovals(memento).isApproved('file:///a.workflow.yaml', 'h1')).toBe(true);
  });

  it('keeps only the most recent hashes per workflow', async () => {
    const approvals = new CommandApprovals(new FakeMemento());
    for (let i = 0; i < 30; i++) await approvals.approve('u', `h${i}`);
    expect(approvals.isApproved('u', 'h29')).toBe(true);
    expect(approvals.isApproved('u', 'h0')).toBe(false);
  });
});

describe('confirmCommands', () => {
  const base = (
    ask: (message: string, detail: string, buttons: string[]) => Promise<string | undefined>,
  ) => ({
    workflowUri: 'file:///w.workflow.yaml',
    workflowName: 'Build and test',
    commands: ['npm ci', 'npm test'],
    approvals: new CommandApprovals(new FakeMemento()),
    enabled: true,
    ask,
  });

  it('asks with the command list and runs once on "Run"', async () => {
    const ask = vi.fn(async () => 'Run');
    const options = base(ask);
    expect(await confirmCommands(options)).toBe(true);
    const [message, detail, buttons] = ask.mock.calls[0] as unknown as [string, string, string[]];
    expect(message).toBe("Run 'Build and test'? It runs these commands in your workspace:");
    expect(detail).toContain('npm ci');
    expect(detail).toContain('npm test');
    expect(buttons).toEqual(['Run', 'Run and remember']);
    expect(options.approvals.isApproved(options.workflowUri, hashCommands(options.commands))).toBe(false);
  });

  it('remembers the hash on "Run and remember" and does not ask again', async () => {
    const ask = vi.fn(async () => 'Run and remember');
    const options = base(ask);
    expect(await confirmCommands(options)).toBe(true);
    expect(options.approvals.isApproved(options.workflowUri, hashCommands(options.commands))).toBe(true);
    expect(await confirmCommands(options)).toBe(true);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('asks again when the commands change', async () => {
    const ask = vi.fn(async () => 'Run and remember');
    const options = base(ask);
    await confirmCommands(options);
    expect(await confirmCommands({ ...options, commands: ['npm ci', 'rm -rf build'] })).toBe(true);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('returns false when the dialog is dismissed', async () => {
    expect(await confirmCommands(base(async () => undefined))).toBe(false);
  });

  it('skips the question when disabled or when there are no commands', async () => {
    const ask = vi.fn(async () => undefined);
    expect(await confirmCommands({ ...base(ask), enabled: false })).toBe(true);
    expect(await confirmCommands({ ...base(ask), commands: [] })).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });

  it('shows at most 15 commands, then "and N more"', async () => {
    const ask = vi.fn(async () => 'Run');
    const commands = Array.from({ length: 18 }, (_, i) => `echo ${i + 1}`);
    await confirmCommands({ ...base(ask), commands });
    const detail = (ask.mock.calls[0] as unknown as [string, string])[1];
    expect(detail).toContain('echo 15');
    expect(detail).not.toContain('echo 16');
    expect(detail).toContain('and 3 more');
  });

  it('lists repeated commands once', async () => {
    const ask = vi.fn(async () => 'Run');
    await confirmCommands({ ...base(ask), commands: ['npm test', 'npm test'] });
    const detail = (ask.mock.calls[0] as unknown as [string, string])[1];
    expect(detail.match(/npm test/g)).toHaveLength(1);
  });
});
