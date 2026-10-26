import { describe, expect, it, vi } from 'vitest';
import type { AgentDefinition } from '@isar-flow/core';
import {
  CommandApprovals,
  confirmCommands,
  consoleCommandsOf,
  hashCommands,
  unattendedAgentsOf,
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

const AGENT_WORKFLOW = `version: 1
name: Implement
steps:
  - id: plan
    type: agent
    agent: planner
    prompt: Plan
  - id: implement
    type: agent
    agent: coder
    model: other/model
    prompt: Implement
  - id: fix
    type: loop
    maxIterations: 3
    steps:
      - id: review
        type: agent
        agent:
          model: x/y
          tools: [readFile, runCommand]
          permissions: { commands: auto }
        prompt: Review
      - id: retry
        type: agent
        agent: coder
        prompt: Fix it
      - id: tidy
        type: agent
        agent: tidier
        prompt: Tidy
  - id: chat
    type: agent
    agent:
      model: x/y
    prompt: Hi
`;

const AGENTS: Record<string, AgentDefinition> = {
  planner: {
    name: 'Planner',
    model: 'x/y',
    tools: ['readFile', 'editFile', 'runCommand'],
    permissions: { edits: 'ask', commands: 'none' },
  },
  coder: {
    name: 'Coder',
    model: 'x/y',
    tools: ['readFile', 'editFile', 'runCommand'],
    permissions: { edits: 'auto', commands: 'auto' },
  },
  tidier: {
    name: 'Tidier',
    model: 'x/y',
    tools: ['writeFile'],
    permissions: { edits: 'auto', commands: 'ask' },
  },
};

describe('unattendedAgentsOf', () => {
  it('lists agent files and inline agents that act without asking, once per agent, in document order', () => {
    expect(unattendedAgentsOf(workflowOf(AGENT_WORKFLOW), AGENTS)).toEqual([
      "agent 'coder' in blocks 'implement' and 'retry': edits files and runs commands without asking",
      "inline agent in block 'review': runs commands without asking",
      "agent 'tidier' in block 'tidy': edits files without asking",
    ]);
  });

  it('names every block that uses the agent', () => {
    const wf = workflowOf(
      ['a', 'b', 'c']
        .map((id) => `  - id: ${id}\n    type: agent\n    agent: coder\n    prompt: Go\n`)
        .join('')
        .replace(/^/, 'version: 1\nname: x\nsteps:\n'),
    );
    expect(unattendedAgentsOf(wf, AGENTS)).toEqual([
      "agent 'coder' in blocks 'a', 'b' and 'c': edits files and runs commands without asking",
    ]);
  });

  it('needs both the auto level and a tool it allows', () => {
    const only = (agent: Partial<AgentDefinition>) =>
      unattendedAgentsOf(
        workflowOf(
          'version: 1\nname: x\nsteps:\n  - id: a\n    type: agent\n    agent: coder\n    prompt: Go\n',
        ),
        { coder: { name: 'Coder', model: 'x/y', ...agent } },
      );
    expect(
      only({ tools: ['readFile', 'gitDiff'], permissions: { edits: 'auto', commands: 'auto' } }),
    ).toEqual([]);
    expect(only({ tools: ['editFile', 'writeFile', 'runCommand'] })).toEqual([]);
    expect(
      only({ tools: ['editFile', 'runCommand'], permissions: { edits: 'ask', commands: 'none' } }),
    ).toEqual([]);
    expect(only({ tools: ['runCommand'], permissions: { edits: 'auto' } })).toEqual([]);
    expect(only({ tools: ['editFile'], permissions: { commands: 'auto' } })).toEqual([]);
    expect(only({ tools: ['runCommand'], permissions: { edits: 'auto', commands: 'auto' } })).toEqual([
      "agent 'coder' in block 'a': runs commands without asking",
    ]);
    expect(only({ tools: ['writeFile'], permissions: { edits: 'auto' } })).toEqual([
      "agent 'coder' in block 'a': edits files without asking",
    ]);
  });

  it('skips agents that are not defined and returns nothing for workflows without agents', () => {
    expect(unattendedAgentsOf(workflowOf(AGENT_WORKFLOW), {})).toEqual([
      "inline agent in block 'review': runs commands without asking",
    ]);
    expect(unattendedAgentsOf(workflowOf(WORKFLOW), AGENTS)).toEqual([]);
  });

  it("changes when an agent's permissions or tools change", () => {
    const wf = workflowOf(AGENT_WORKFLOW);
    const before = unattendedAgentsOf(wf, AGENTS);
    const commandsOnly = unattendedAgentsOf(wf, {
      ...AGENTS,
      coder: { ...AGENTS.coder, permissions: { edits: 'ask', commands: 'auto' } },
    });
    const withoutRunCommand = unattendedAgentsOf(wf, {
      ...AGENTS,
      coder: { ...AGENTS.coder, tools: ['readFile', 'editFile'] },
    });
    expect(commandsOnly).not.toEqual(before);
    expect(withoutRunCommand).not.toEqual(before);
    expect(withoutRunCommand).not.toEqual(commandsOnly);
    expect(hashCommands([], commandsOnly)).not.toBe(hashCommands([], before));
  });
});

describe('hashCommands', () => {
  it('keeps the hash of a command list without agents, so earlier approvals still apply', () => {
    expect(hashCommands(['npm ci'], [])).toBe(hashCommands(['npm ci']));
  });

  it('covers the agents that act without asking', () => {
    const agents = ["agent 'coder' in block 'a': edits files without asking"];
    expect(hashCommands(['npm ci'], agents)).not.toBe(hashCommands(['npm ci']));
    expect(hashCommands(['npm ci'], agents)).toBe(hashCommands(['npm ci'], [...agents]));
    expect(hashCommands([], agents)).not.toBe(hashCommands(agents));
    expect(hashCommands(['npm ci'], agents)).not.toBe(hashCommands(['npm ci', ...agents]));
  });

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

  describe('with agents that act without asking', () => {
    const CODER = "agent 'coder' in block 'implement': edits files and runs commands without asking";
    const REVIEW = "inline agent in block 'review': runs commands without asking";

    it('asks about the agents of a workflow without console blocks', async () => {
      const ask = vi.fn(async () => 'Run');
      expect(await confirmCommands({ ...base(ask), commands: [], agents: [CODER, REVIEW] })).toBe(true);
      const [message, detail, buttons] = ask.mock.calls[0] as unknown as [string, string, string[]];
      expect(message).toBe("Run 'Build and test'? These agents can change your workspace without asking:");
      expect(detail).toBe(
        `• ${CODER}\n• ${REVIEW}\n\n"Run and remember" skips this question until anything listed here changes.`,
      );
      expect(buttons).toEqual(['Run', 'Run and remember']);
    });

    it('lists the commands first, then the agents', async () => {
      const ask = vi.fn(async () => 'Run');
      await confirmCommands({ ...base(ask), agents: [CODER] });
      const [message, detail] = ask.mock.calls[0] as unknown as [string, string];
      expect(message).toBe(
        "Run 'Build and test'? It runs these commands and lets agents change your workspace without asking:",
      );
      expect(detail).toBe(
        [
          '• npm ci',
          '• npm test',
          '',
          'Agents that act without asking:',
          `• ${CODER}`,
          '',
          '"Run and remember" skips this question until anything listed here changes.',
        ].join('\n'),
      );
    });

    it('keeps the commands-only question when no agent acts without asking', async () => {
      const ask = vi.fn(async () => 'Run');
      await confirmCommands({ ...base(ask), agents: [] });
      const [message, detail] = ask.mock.calls[0] as unknown as [string, string];
      expect(message).toBe("Run 'Build and test'? It runs these commands in your workspace:");
      expect(detail).toBe(
        '• npm ci\n• npm test\n\n"Run and remember" skips this question until the commands change.',
      );
    });

    it('remembers commands and agents together and asks again when the agents change', async () => {
      const ask = vi.fn(async () => 'Run and remember');
      const options = { ...base(ask), agents: [CODER] };
      expect(await confirmCommands(options)).toBe(true);
      expect(options.approvals.isApproved(options.workflowUri, hashCommands(options.commands, [CODER]))).toBe(
        true,
      );
      expect(await confirmCommands(options)).toBe(true);
      expect(ask).toHaveBeenCalledTimes(1);

      const editsOnly = "agent 'coder' in block 'implement': edits files without asking";
      expect(await confirmCommands({ ...options, agents: [editsOnly] })).toBe(true);
      expect(ask).toHaveBeenCalledTimes(2);
    });

    it('asks again when an agent that acts without asking joins approved commands', async () => {
      const ask = vi.fn(async () => 'Run and remember');
      const options = base(ask);
      await confirmCommands(options);
      expect(await confirmCommands(options)).toBe(true);
      expect(ask).toHaveBeenCalledTimes(1);
      expect(await confirmCommands({ ...options, agents: [CODER] })).toBe(true);
      expect(ask).toHaveBeenCalledTimes(2);
    });

    it('returns false when dismissed and skips the question when disabled', async () => {
      expect(await confirmCommands({ ...base(async () => undefined), commands: [], agents: [CODER] })).toBe(
        false,
      );
      const ask = vi.fn(async () => undefined);
      expect(await confirmCommands({ ...base(ask), commands: [], agents: [CODER], enabled: false })).toBe(
        true,
      );
      expect(await confirmCommands({ ...base(ask), commands: [], agents: [] })).toBe(true);
      expect(ask).not.toHaveBeenCalled();
    });
  });
});
