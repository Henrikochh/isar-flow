import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import type { AgentSummary, SidebarToHost } from '@isar-flow/core';
import { createSidebarHandler, type SidebarHandlerDeps } from '../../../src/sidebar/sidebarMessages';

const AGENT_URI = 'file:///ws/.isarflow/agents/coder.agent.yaml';
const FLOW_URI = 'file:///ws/a.workflow.yaml';

const coder: AgentSummary = {
  id: 'coder',
  name: 'Coder',
  model: 'm',
  tools: [],
  scope: 'workspace',
  uri: AGENT_URI,
  valid: true,
};

function setup(confirmed = true) {
  const calls: string[] = [];
  const log = (entry: string) => void calls.push(entry);
  const deps: SidebarHandlerDeps = {
    agents: {
      list: () => [coder],
      create: vi.fn(async (name: string, scope: string) => {
        log(`agents.create ${name} ${scope}`);
        return vscode.Uri.file('/ws/.isarflow/agents/new.agent.yaml');
      }),
      delete: vi.fn(async (uri: vscode.Uri) => log(`agents.delete ${uri.toString()}`)),
    },
    workflows: {
      create: vi.fn(async (name: string, template: string) => {
        log(`workflows.create ${name} ${template}`);
        return vscode.Uri.file('/ws/.isarflow/workflows/new.workflow.yaml');
      }),
      usersOfAgent: (id: string) => (id === 'coder' ? ['a.workflow.yaml', 'b.workflow.yaml'] : []),
    },
    runs: {
      start: vi.fn(async (uri: vscode.Uri) => {
        log(`runs.start ${uri.toString()}`);
        return 'run-1';
      }),
      cancel: vi.fn((runId: string) => log(`runs.cancel ${runId}`)),
    },
    executeCommand: vi.fn(async (command: string, ...args: unknown[]) => {
      log(`${command} ${args.map((a) => String(a)).join(' ')}`.trim());
      return undefined;
    }),
    confirm: vi.fn(async (message: string, action: string, detail?: string) => {
      log(`confirm ${message} [${action}] ${detail ?? ''}`.trim());
      return confirmed;
    }),
    setTab: vi.fn(async (tab: string) => log(`setTab ${tab}`)),
    pushState: vi.fn(() => log('push')),
    schedulePush: vi.fn(() => log('schedulePush')),
  };
  return { handle: createSidebarHandler(deps), calls, deps };
}

async function run(message: SidebarToHost, confirmed = true) {
  const { handle, calls } = setup(confirmed);
  await handle(message);
  return calls;
}

describe('sidebar messages', () => {
  it('pushes the full state on ready', async () => {
    expect(await run({ type: 'ready' })).toEqual(['push']);
  });

  it('stores known tabs only', async () => {
    expect(await run({ type: 'setTab', tab: 'workflows' })).toEqual(['setTab workflows', 'schedulePush']);
    expect(await run({ type: 'setTab', tab: 'runs' } as unknown as SidebarToHost)).toEqual([]);
  });

  it('opens agents and workflows in their editors', async () => {
    expect(await run({ type: 'openAgent', uri: AGENT_URI })).toEqual([
      `vscode.openWith ${AGENT_URI} isarFlow.agentEditor`,
    ]);
    expect(await run({ type: 'openWorkflow', uri: FLOW_URI })).toEqual([
      `vscode.openWith ${FLOW_URI} isarFlow.workflowEditor`,
    ]);
  });

  it('creates and opens agents and workflows', async () => {
    expect(await run({ type: 'createAgent', name: 'Helper', scope: 'user' })).toEqual([
      'agents.create Helper user',
      'vscode.openWith file:///ws/.isarflow/agents/new.agent.yaml isarFlow.agentEditor',
    ]);
    expect(await run({ type: 'createWorkflow', name: 'Loop', template: 'review-loop' })).toEqual([
      'workflows.create Loop review-loop',
      'vscode.openWith file:///ws/.isarflow/workflows/new.workflow.yaml isarFlow.workflowEditor',
    ]);
    const odd = { type: 'createWorkflow', name: 'X', template: 'weird' } as unknown as SidebarToHost;
    expect((await run(odd))[0]).toBe('workflows.create X blank');
  });

  it('deletes an agent only after confirmation and names its workflows', async () => {
    const confirmed = await run({ type: 'deleteAgent', uri: AGENT_URI });
    expect(confirmed).toEqual([
      "confirm Delete agent 'Coder'? Workflows that use it will stop working. [Delete] Used by a.workflow.yaml, b.workflow.yaml.",
      `agents.delete ${AGENT_URI}`,
    ]);
    const cancelled = await run({ type: 'deleteAgent', uri: AGENT_URI }, false);
    expect(cancelled).toHaveLength(1);
  });

  it('falls back to the file name for unknown agents', async () => {
    const calls = await run({ type: 'deleteAgent', uri: 'file:///global/agents/old.agent.yaml' });
    expect(calls[0]).toBe(
      "confirm Delete agent 'old.agent.yaml'? Workflows that use it will stop working. [Delete]",
    );
  });

  it('opens the workflow before starting a run', async () => {
    expect(await run({ type: 'runWorkflow', uri: FLOW_URI })).toEqual([
      `vscode.openWith ${FLOW_URI} isarFlow.workflowEditor`,
      `runs.start ${FLOW_URI}`,
    ]);
  });

  it('cancels and shows runs', async () => {
    expect(await run({ type: 'cancelRun', runId: 'r1' })).toEqual(['runs.cancel r1']);
    expect(await run({ type: 'openRun', runId: 'r1', workflowUri: FLOW_URI })).toEqual([
      `isarFlow.internal.showRun ${FLOW_URI} r1`,
    ]);
  });

  it('forwards provider actions to the model commands', async () => {
    expect(await run({ type: 'addProvider' })).toEqual(['isarFlow.addProvider']);
    expect(await run({ type: 'editProvider', providerId: 'litellm' })).toEqual([
      'isarFlow.editProvider litellm',
    ]);
    expect(await run({ type: 'setProviderKey', providerId: 'litellm' })).toEqual([
      'isarFlow.setProviderKey litellm',
    ]);
    expect(await run({ type: 'removeProvider', providerId: 'litellm' })).toEqual([
      'isarFlow.removeProvider litellm',
    ]);
    expect(await run({ type: 'refreshModels' })).toEqual(['isarFlow.refreshModels']);
  });
});
