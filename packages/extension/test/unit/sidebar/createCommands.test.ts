import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import type { AgentStore, WorkflowStore } from '../../../src/contracts';
import { type CreateUi, newAgentFlow, newWorkflowFlow } from '../../../src/commands/create';

/** Scripted UI: answers input boxes and quick picks in order (picking items by label). */
function scriptedUi(answers: (string | undefined)[], hasWorkspace = true, folders = ['/ws']) {
  const asked: string[] = [];
  const opened: unknown[][] = [];
  const next = () => answers.shift();
  const ui: CreateUi = {
    hasWorkspace: () => hasWorkspace,
    workspaceFolders: () =>
      hasWorkspace ? folders.map((path) => ({ name: path.slice(1), uri: vscode.Uri.file(path) })) : [],
    showInputBox: async (options) => {
      asked.push(`input ${options.prompt}`);
      expect(options.validateInput?.('  ')).toBe('Enter a name.');
      expect(options.validateInput?.('ok')).toBeUndefined();
      return next();
    },
    showQuickPick: async (items, options) => {
      asked.push(
        `pick ${options.placeHolder}: ${items.map((i) => `${i.label} (${i.description})`).join(', ')}`,
      );
      const label = next();
      return items.find((i) => i.label === label);
    },
    executeCommand: async (...args) => {
      opened.push(args);
      return undefined;
    },
  };
  return { ui, asked, opened };
}

describe('new workflow command', () => {
  const workflows = () => {
    const create = vi.fn(async () => vscode.Uri.file('/ws/.isarflow/workflows/x.workflow.yaml'));
    return { store: { create } as unknown as WorkflowStore, create };
  };

  it('asks for a name and a template, then creates and opens the workflow', async () => {
    const { store, create } = workflows();
    const { ui, asked, opened } = scriptedUi([' Review  ', 'Review loop']);
    const uri = await newWorkflowFlow(ui, store);
    expect(asked).toEqual([
      'input Name of the workflow',
      'pick Start from: Blank (Start empty), Review loop (Implement, test and review until approved), ' +
        'Test and fix (Run tests and fix failures until they pass)',
    ]);
    expect(create).toHaveBeenCalledWith('Review', 'review-loop', vscode.Uri.file('/ws'));
    expect(opened).toEqual([['vscode.openWith', uri, 'isarFlow.workflowEditor']]);
  });

  it('asks which folder to use in a multi-root workspace', async () => {
    const { store, create } = workflows();
    const { ui, asked } = scriptedUi(['Review', 'Blank', 'two'], true, ['/ws', '/two']);
    await newWorkflowFlow(ui, store);
    expect(asked.at(-1)).toBe(
      'pick Which workspace folder should the workflow be saved in?: ws (/ws), two (/two)',
    );
    expect(create).toHaveBeenCalledWith('Review', 'blank', vscode.Uri.file('/two'));

    const dismissed = workflows();
    await newWorkflowFlow(
      scriptedUi(['Review', 'Blank', undefined], true, ['/ws', '/two']).ui,
      dismissed.store,
    );
    expect(dismissed.create).not.toHaveBeenCalled();
  });

  it('stops quietly when a prompt is dismissed', async () => {
    for (const answers of [[undefined], ['Name', undefined]]) {
      const { store, create } = workflows();
      const { ui, opened } = scriptedUi(answers);
      expect(await newWorkflowFlow(ui, store)).toBeUndefined();
      expect(create).not.toHaveBeenCalled();
      expect(opened).toEqual([]);
    }
  });

  it('explains that a folder is needed', async () => {
    const { store } = workflows();
    const { ui, asked } = scriptedUi([], false);
    await expect(newWorkflowFlow(ui, store)).rejects.toThrow('Open a folder first to create workflows.');
    expect(asked).toEqual([]);
  });
});

describe('new agent command', () => {
  const agents = () => {
    const create = vi.fn(async () => vscode.Uri.file('/ws/.isarflow/agents/x.agent.yaml'));
    return { store: { create } as unknown as AgentStore, create };
  };

  it('asks for name, starter and scope, then creates and opens the agent', async () => {
    const { store, create } = agents();
    const { ui, asked, opened } = scriptedUi(['Strict reviewer', 'Reviewer', 'User']);
    const uri = await newAgentFlow(ui, store);
    expect(asked.map((a) => a.split(':')[0])).toEqual([
      'input Name of the agent',
      'pick Start from',
      'pick Where should the agent be saved?',
    ]);
    expect(create).toHaveBeenCalledWith('Strict reviewer', 'user', 'reviewer', {});
    expect(opened).toEqual([['vscode.openWith', uri, 'isarFlow.agentEditor']]);
  });

  it('creates user agents without asking when no folder is open', async () => {
    const { store, create } = agents();
    const { ui, asked } = scriptedUi(['Helper', 'Blank'], false);
    await newAgentFlow(ui, store);
    expect(asked).toHaveLength(2);
    expect(create).toHaveBeenCalledWith('Helper', 'user', 'blank', {});
  });

  it('asks which folder to use for workspace agents in a multi-root workspace', async () => {
    const { store, create } = agents();
    const { ui, asked } = scriptedUi(['Helper', 'Coder', 'Workspace', 'two'], true, ['/ws', '/two']);
    await newAgentFlow(ui, store);
    expect(asked.at(-1)).toBe(
      'pick Which workspace folder should the agent be saved in?: ws (/ws), two (/two)',
    );
    expect(create).toHaveBeenCalledWith('Helper', 'workspace', 'coder', { folder: vscode.Uri.file('/two') });

    const user = agents();
    const asUser = scriptedUi(['Helper', 'Coder', 'User'], true, ['/ws', '/two']);
    await newAgentFlow(asUser.ui, user.store);
    expect(asUser.asked).toHaveLength(3);
    expect(user.create).toHaveBeenCalledWith('Helper', 'user', 'coder', {});
  });

  it('stops quietly when the scope prompt is dismissed', async () => {
    const { store, create } = agents();
    const { ui } = scriptedUi(['Helper', 'Coder', undefined]);
    expect(await newAgentFlow(ui, store)).toBeUndefined();
    expect(create).not.toHaveBeenCalled();
  });
});
