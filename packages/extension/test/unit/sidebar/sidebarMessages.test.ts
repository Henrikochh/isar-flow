import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import type { SidebarToHost } from '@isar-flow/core';
import { createSidebarHandler, type SidebarHandlerDeps } from '../../../src/sidebar/sidebarMessages';

const AGENT_URI = 'file:///ws/.isarflow/agents/coder.agent.yaml';
const FLOW_URI = 'file:///ws/a.workflow.yaml';

const describeArg = (arg: unknown) =>
  typeof arg === 'object' && arg !== null && !(arg instanceof vscode.Uri) ? JSON.stringify(arg) : String(arg);

function setup(folder: vscode.Uri | undefined | 'dismissed' = vscode.Uri.file('/ws')) {
  const calls: string[] = [];
  const log = (entry: string) => void calls.push(entry);
  const deps: SidebarHandlerDeps = {
    agents: {
      create: vi.fn(async (name: string, scope: string, kind?: string, options?: { folder?: vscode.Uri }) => {
        log(`agents.create ${name} ${scope} ${kind}${options?.folder ? ` in ${options.folder.path}` : ''}`);
        return vscode.Uri.file('/ws/.isarflow/agents/new.agent.yaml');
      }),
      delete: vi.fn(async (uri: vscode.Uri) => log(`agents.delete ${uri.toString()}`)),
    },
    workflows: {
      create: vi.fn(async (name: string, template: string, folder?: vscode.Uri) => {
        log(`workflows.create ${name} ${template}${folder ? ` in ${folder.path}` : ''}`);
        return vscode.Uri.file('/ws/.isarflow/workflows/new.workflow.yaml');
      }),
    },
    runs: {
      start: vi.fn(async (uri: vscode.Uri) => {
        log(`runs.start ${uri.toString()}`);
        return 'run-1';
      }),
      cancel: vi.fn((runId: string) => log(`runs.cancel ${runId}`)),
    },
    executeCommand: vi.fn(async (command: string, ...args: unknown[]) => {
      log(`${command} ${args.map(describeArg).join(' ')}`.trim());
      return undefined;
    }),
    setTab: vi.fn(async (tab: string) => log(`setTab ${tab}`)),
    pushState: vi.fn(() => log('push')),
    schedulePush: vi.fn(() => log('schedulePush')),
    pickFolder: vi.fn(async (placeHolder: string) => {
      log(`pickFolder ${placeHolder}`);
      return folder;
    }),
  };
  return { handle: createSidebarHandler(deps), calls, deps };
}

async function run(message: SidebarToHost, folder?: vscode.Uri | 'dismissed') {
  const { handle, calls } = setup(folder);
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
      'agents.create Helper user blank',
      'vscode.openWith file:///ws/.isarflow/agents/new.agent.yaml isarFlow.agentEditor',
    ]);
    expect(await run({ type: 'createWorkflow', name: 'Loop', template: 'review-loop' })).toEqual([
      'pickFolder Which workspace folder should the workflow be saved in?',
      'workflows.create Loop review-loop in /ws',
      'vscode.openWith file:///ws/.isarflow/workflows/new.workflow.yaml isarFlow.workflowEditor',
    ]);
    const odd = { type: 'createWorkflow', name: 'X', template: 'weird' } as unknown as SidebarToHost;
    expect((await run(odd))[1]).toBe('workflows.create X blank in /ws');
  });

  it('creates agents from the chosen starter', async () => {
    const created = async (starter: unknown) =>
      (await run({ type: 'createAgent', name: 'A', scope: 'workspace', starter } as SidebarToHost))[1];
    expect(await created('reviewer')).toBe('agents.create A workspace reviewer in /ws');
    expect(await created('coder')).toBe('agents.create A workspace coder in /ws');
    expect(await created('blank')).toBe('agents.create A workspace blank in /ws');
    expect(await created('wizard')).toBe('agents.create A workspace blank in /ws');
  });

  it('creates in the workspace folder picked in a multi-root workspace, and nothing when the pick is closed', async () => {
    const two = vscode.Uri.file('/two');
    expect((await run({ type: 'createWorkflow', name: 'L', template: 'blank' }, two))[1]).toBe(
      'workflows.create L blank in /two',
    );
    expect(await run({ type: 'createWorkflow', name: 'L', template: 'blank' }, 'dismissed')).toEqual([
      'pickFolder Which workspace folder should the workflow be saved in?',
    ]);
    expect(await run({ type: 'createAgent', name: 'A', scope: 'workspace' }, 'dismissed')).toEqual([
      'pickFolder Which workspace folder should the agent be saved in?',
    ]);
  });

  it('deletes an agent right away because the sidebar already confirmed it', async () => {
    expect(await run({ type: 'deleteAgent', uri: AGENT_URI })).toEqual([`agents.delete ${AGENT_URI}`]);
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
    expect(await run({ type: 'refreshModels' })).toEqual(['isarFlow.refreshModels']);
  });

  it('removes a provider without asking again because the sidebar already confirmed it', async () => {
    expect(await run({ type: 'removeProvider', providerId: 'litellm' })).toEqual([
      'isarFlow.removeProvider litellm {"confirmed":true}',
    ]);
  });

  it('tests a model, or lets the user pick one of an endpoint', async () => {
    expect(await run({ type: 'testModel', ref: 'litellm/gpt-4.1' })).toEqual([
      'isarFlow.testModel litellm/gpt-4.1',
    ]);
    expect(await run({ type: 'testModel', providerId: 'litellm' })).toEqual([
      'isarFlow.testModel {"providerId":"litellm"}',
    ]);
    expect(await run({ type: 'testModel', ref: '  ', providerId: 'ollama' })).toEqual([
      'isarFlow.testModel {"providerId":"ollama"}',
    ]);
    const odd = { type: 'testModel', ref: 42, providerId: ['x'] } as unknown as SidebarToHost;
    expect(await run(odd)).toEqual(['isarFlow.testModel']);
  });

  it('runs the setup check quietly because the sidebar shows the report', async () => {
    expect(await run({ type: 'checkSetup' })).toEqual(['isarFlow.checkSetup {"quiet":true}']);
  });

  it('dismisses the setup report', async () => {
    const { handle, deps } = setup();
    const dismiss = vi.fn();
    await handle({ type: 'dismissSetupCheck' });
    Object.assign(deps, { setupCheck: { dismiss } });
    await createSidebarHandler(deps)({ type: 'dismissSetupCheck' });
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it('opens the settings for a query and ignores anything else', async () => {
    expect(await run({ type: 'openSettings', query: 'isarFlow.vscodeModels' })).toEqual([
      'workbench.action.openSettings isarFlow.vscodeModels',
    ]);
    for (const query of ['', '  ', 42, 'x'.repeat(201)]) {
      expect(await run({ type: 'openSettings', query } as unknown as SidebarToHost)).toEqual([]);
    }
  });

  it('opens the project memory of a folder, the first folder by default', async () => {
    const { handle, deps } = setup();
    const openMemory = vi.fn(async (_folder?: vscode.Uri) => undefined);
    await handle({ type: 'openMemory' });
    Object.assign(deps, { memory: { open: openMemory } });
    const withMemory = createSidebarHandler(deps);
    await withMemory({ type: 'openMemory', folderUri: 'file:///ws2' });
    await withMemory({ type: 'openMemory' });
    await withMemory({ type: 'openMemory', folderUri: 42 } as unknown as SidebarToHost);
    await withMemory({ type: 'openMemory', folderUri: '' });
    expect(openMemory.mock.calls.map(([folder]) => folder?.toString())).toEqual([
      'file:///ws2',
      undefined,
      undefined,
      undefined,
    ]);
  });
});
