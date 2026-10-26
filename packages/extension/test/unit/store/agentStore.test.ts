import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { createAgentStore, type IndexedAgentStore } from '../../../src/store/agentStore';
import { fakeContext, fakeLog, installFakeWorkspace } from './fakeWorkspace';

const agentText = (name: string, model = 'a/b') => `name: ${name}\nmodel: ${model}\n`;

let store: IndexedAgentStore | undefined;
afterEach(() => store?.dispose());

async function open(): Promise<IndexedAgentStore> {
  store = createAgentStore({ context: fakeContext(), log: fakeLog().log });
  await store.ready;
  return store;
}

describe('agent store', () => {
  it('indexes workspace and user agents with shadowing', async () => {
    const ws = installFakeWorkspace(['/ws']);
    ws.fs
      .add('/ws/.isarflow/agents/coder.agent.yaml', agentText('Coder', 'ws/model'))
      .add('/ws/.isarflow/agents/notes.txt', 'ignored')
      .add('/global/agents/coder.agent.yaml', agentText('My coder', 'user/model'))
      .add('/global/agents/helper.agent.yml', agentText('Helper'));
    const agents = await open();

    expect(agents.list().map((a) => [a.scope, a.id, a.shadowed ?? false])).toEqual([
      ['workspace', 'coder', false],
      ['user', 'helper', false],
      ['user', 'coder', true],
    ]);
    expect(agents.definitions().coder.model).toBe('ws/model');
    expect(agents.get('coder')?.summary.scope).toBe('workspace');
    expect(agents.get('helper')?.definition?.name).toBe('Helper');
    expect(agents.get('missing')).toBeUndefined();
  });

  it('identifies agent files by location, also before they exist', async () => {
    installFakeWorkspace(['/ws']);
    const agents = await open();
    expect(agents.identify(vscode.Uri.file('/ws/.isarflow/agents/new.agent.yaml'))).toEqual({
      id: 'new',
      scope: 'workspace',
    });
    expect(agents.identify(vscode.Uri.file('/global/agents/mine.agent.yml'))).toEqual({
      id: 'mine',
      scope: 'user',
    });
    expect(agents.identify(vscode.Uri.file('/ws/other/new.agent.yaml'))).toBeUndefined();
  });

  it('creates workspace agents at a unique slug, creating folders', async () => {
    const ws = installFakeWorkspace(['/ws']);
    ws.fs.add('/global/agents/reviewer.agent.yaml', agentText('Reviewer'));
    const agents = await open();

    const first = await agents.create('Code Reviewer', 'workspace', 'reviewer');
    expect(first.path).toBe('/ws/.isarflow/agents/code-reviewer.agent.yaml');
    expect(ws.fs.files.get(first.path)).toContain('name: Code Reviewer');
    const second = await agents.create('Code reviewer', 'workspace');
    expect(second.path).toBe('/ws/.isarflow/agents/code-reviewer-2.agent.yaml');
    const third = await agents.create('Reviewer', 'workspace', 'reviewer');
    expect(third.path).toBe('/ws/.isarflow/agents/reviewer-2.agent.yaml');
    expect(agents.list().map((a) => a.id)).toContain('code-reviewer-2');
  });

  it('creates user agents without a workspace folder and explains workspace agents need one', async () => {
    installFakeWorkspace([]);
    const agents = await open();
    const uri = await agents.create('Ünïcode', 'user', 'coder');
    expect(uri.path).toBe('/global/agents/uenicode.agent.yaml');
    expect(agents.list()).toMatchObject([{ id: 'uenicode', scope: 'user', valid: true }]);
    await expect(agents.create('x', 'workspace')).rejects.toThrow(/Open a folder first/);
  });

  it('does not take agent paths on another host (UNC) for agent files', async () => {
    const ws = installFakeWorkspace(['/ws']);
    ws.fs.add('/ws/.isarflow/agents/coder.agent.yaml', agentText('Coder'));
    const agents = await open();
    const remote = vscode.Uri.parse('file://evil/ws/.isarflow/agents/coder.agent.yaml');
    expect(agents.identify(remote)).toBeUndefined();
    await expect(agents.delete(remote)).rejects.toThrow(/not an agent file/);
    expect(ws.fs.deleted).toEqual([]);
  });

  it('deletes agent files to the trash and refuses other files', async () => {
    const ws = installFakeWorkspace(['/ws']);
    ws.fs.add('/ws/.isarflow/agents/coder.agent.yaml', agentText('Coder')).add('/ws/src/app.ts', '');
    const agents = await open();
    await agents.delete(vscode.Uri.file('/ws/.isarflow/agents/coder.agent.yaml'));
    expect(ws.fs.deleted).toEqual([{ path: '/ws/.isarflow/agents/coder.agent.yaml', useTrash: true }]);
    expect(agents.list()).toEqual([]);
    await expect(agents.delete(vscode.Uri.file('/ws/src/app.ts'))).rejects.toThrow(/not an agent file/);
    expect(ws.fs.files.has('/ws/src/app.ts')).toBe(true);
  });

  it('ensures missing starter agents in the first workspace folder only', async () => {
    const ws = installFakeWorkspace(['/ws', '/two']);
    ws.fs.add('/global/agents/reviewer.agent.yaml', agentText('Reviewer'));
    const agents = await open();
    await agents.ensure(['coder', 'reviewer']);
    expect(ws.fs.files.get('/ws/.isarflow/agents/coder.agent.yaml')).toContain('name: Coder');
    expect(ws.fs.files.has('/ws/.isarflow/agents/reviewer.agent.yaml')).toBe(false);
    expect(agents.definitions().coder.name).toBe('Coder');

    ws.fs.files.set('/ws/.isarflow/agents/coder.agent.yaml', '# mine\n');
    await agents.ensure(['coder']);
    expect(ws.fs.files.get('/ws/.isarflow/agents/coder.agent.yaml')).toBe('# mine\n');
  });

  it('matches ids exactly across scopes but never overwrites a file that differs only in case', async () => {
    const ws = installFakeWorkspace(['/ws']);
    ws.fs
      .add('/global/agents/Coder.agent.yaml', agentText('User coder'))
      .add('/ws/.isarflow/agents/Reviewer.agent.yaml', agentText('Mine'));
    const agents = await open();
    await agents.ensure(['coder', 'reviewer']);
    expect(ws.fs.files.has('/ws/.isarflow/agents/coder.agent.yaml')).toBe(true);
    expect(ws.fs.files.has('/ws/.isarflow/agents/reviewer.agent.yaml')).toBe(false);
  });

  it('creates an agent with the exact id a workflow refers to, in the given workspace folder', async () => {
    const ws = installFakeWorkspace(['/ws', '/two']);
    const agents = await open();
    const uri = await agents.create('MyAgent', 'workspace', 'blank', {
      id: 'MyAgent',
      folder: vscode.Uri.file('/two'),
    });
    expect(uri.path).toBe('/two/.isarflow/agents/MyAgent.agent.yaml');
    expect(ws.fs.files.get(uri.path)).toContain('name: MyAgent');
    expect(agents.get('MyAgent')?.summary.scope).toBe('workspace');
  });

  it('creates in the first workspace folder when the given folder is not one of them', async () => {
    installFakeWorkspace(['/ws', '/two']);
    const agents = await open();
    const uri = await agents.create('Helper', 'workspace', 'blank', {
      folder: vscode.Uri.file('/elsewhere'),
    });
    expect(uri.path).toBe('/ws/.isarflow/agents/helper.agent.yaml');
  });

  it('refuses an exact id that is taken, differs only in case or cannot be a file name', async () => {
    const ws = installFakeWorkspace(['/ws']);
    ws.fs.add('/ws/.isarflow/agents/myagent.agent.yaml', agentText('Mine'));
    const agents = await open();
    await expect(agents.create('MyAgent', 'workspace', 'blank', { id: 'MyAgent' })).rejects.toThrow(
      /myagent/,
    );
    await expect(agents.create('x', 'workspace', 'blank', { id: 'myagent' })).rejects.toThrow(/already/);
    await expect(agents.create('x', 'workspace', 'blank', { id: '../evil' })).rejects.toThrow(
      /letters, digits/,
    );
    expect(ws.fs.files.get('/ws/.isarflow/agents/myagent.agent.yaml')).toBe(agentText('Mine'));
    expect([...ws.fs.files.keys()]).toEqual(['/ws/.isarflow/agents/myagent.agent.yaml']);
  });

  it('ensures missing starter agents in the given workspace folder', async () => {
    const ws = installFakeWorkspace(['/ws', '/two']);
    const agents = await open();
    await agents.ensure(['coder'], vscode.Uri.file('/two'));
    expect(ws.fs.files.has('/two/.isarflow/agents/coder.agent.yaml')).toBe(true);
    expect(ws.fs.files.has('/ws/.isarflow/agents/coder.agent.yaml')).toBe(false);
  });

  it('does nothing in ensure without a workspace folder', async () => {
    const ws = installFakeWorkspace([]);
    const agents = await open();
    await agents.ensure(['coder']);
    expect([...ws.fs.files.keys()]).toEqual([]);
  });

  it('rescans once, debounced, after file events', async () => {
    const ws = installFakeWorkspace(['/ws']);
    const agents = await open();
    const changed = vi.fn();
    agents.onDidChange(changed);
    ws.fs.add('/ws/.isarflow/agents/a.agent.yaml', agentText('A'));
    ws.fs.add('/ws/.isarflow/agents/b.agent.yaml', agentText('B'));
    const watcher = ws.watchers[0];
    watcher.create.fire(vscode.Uri.file('/ws/.isarflow/agents/a.agent.yaml'));
    watcher.create.fire(vscode.Uri.file('/ws/.isarflow/agents/b.agent.yaml'));
    await vi.waitFor(() => expect(agents.list()).toHaveLength(2));
    expect(changed).toHaveBeenCalledTimes(1);

    ws.fs.remove('/ws/.isarflow/agents/a.agent.yaml');
    watcher.delete.fire(vscode.Uri.file('/ws/.isarflow'));
    await vi.waitFor(() => expect(agents.list().map((a) => a.id)).toEqual(['b']));
  });

  it('disposes its watchers', async () => {
    const ws = installFakeWorkspace(['/ws']);
    const agents = await open();
    agents.dispose();
    store = undefined;
    expect(ws.watchers.length).toBeGreaterThan(0);
    expect(ws.watchers.every((w) => w.disposed)).toBe(true);
  });
});
