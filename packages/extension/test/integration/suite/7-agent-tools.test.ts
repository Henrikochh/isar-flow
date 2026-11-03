import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import type { AgentPermissions, StepIO } from '@isar-flow/core';
import type { IsarFlowApi } from '../../../src/extension';
import { activateApi, closeAllEditors, waitFor, workspaceFolder } from '../helpers';

const AUTO: AgentPermissions = { edits: 'auto', commands: 'none' };

const io = (): StepIO => ({
  runId: 'run-agent-tools',
  stepId: 'edit',
  signal: new AbortController().signal,
  log: () => undefined,
});

const samePath = (a: string, b: string) => {
  const key = (p: string) =>
    process.platform === 'win32' ? path.normalize(p).toLowerCase() : path.normalize(p);
  return key(a) === key(b);
};

describe('Agent tools in VS Code', function () {
  this.timeout(60_000);

  let api: IsarFlowApi;
  let folder: string;

  before(async () => {
    api = await activateApi();
    folder = path.join(workspaceFolder().fsPath, 'agent-tools');
    fs.mkdirSync(folder, { recursive: true });
  });

  after(async () => {
    await closeAllEditors();
    fs.rmSync(folder, { recursive: true, force: true });
  });

  it('applies a patch to an open document and saves it', async () => {
    const file = path.join(folder, 'open.ts');
    fs.writeFileSync(file, 'const a = 1;\nconst b = 2;\n');
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    await vscode.window.showTextDocument(document);

    const patch =
      '--- a/open.ts\n+++ b/open.ts\n@@ -1,2 +1,2 @@\n const a = 1;\n-const b = 2;\n+const b = 3;\n';
    const result = await api
      .tools('run-patch', folder)
      .execute({ name: 'applyPatch', args: { patch } }, io(), AUTO);

    assert.equal(result.isError, undefined, result.content);
    assert.equal(result.content, 'Patched 1 file: open.ts (+1 −1).');
    assert.equal(document.getText(), 'const a = 1;\nconst b = 3;\n');
    assert.equal(document.isDirty, false);
    assert.equal(fs.readFileSync(file, 'utf8'), 'const a = 1;\nconst b = 3;\n');
  });

  it('deletes files through a workspace edit, which VS Code can undo', async () => {
    const file = path.join(folder, 'gone.txt');
    fs.writeFileSync(file, 'bye\n');
    const deleted: string[] = [];
    // onDidDeleteFiles only fires for workspace edits (undoable), not for plain file system calls.
    const subscription = vscode.workspace.onDidDeleteFiles((event) =>
      deleted.push(...event.files.map((uri) => uri.fsPath)),
    );
    try {
      const patch = '--- a/gone.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye\n';
      const result = await api
        .tools('run-delete', folder)
        .execute({ name: 'applyPatch', args: { patch } }, io(), AUTO);
      assert.equal(result.isError, undefined, result.content);
      assert.equal(result.content, 'Patched 1 file: gone.txt (deleted, −1).');
      assert.equal(fs.existsSync(file), false);
      await waitFor(() => deleted.some((p) => samePath(p, file)), 'the delete event of gone.txt');
    } finally {
      subscription.dispose();
    }
  });

  it('finds, searches and edits files in a folder outside the workspace', async () => {
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'isar-worktree-')));
    try {
      for (const [rel, text] of [
        ['src/a.ts', 'export const marker = 1;\n'],
        ['node_modules/x/b.ts', 'export const marker = 2;\n'],
        ['README.md', 'marker\n'],
      ]) {
        fs.mkdirSync(path.dirname(path.join(outside, rel)), { recursive: true });
        fs.writeFileSync(path.join(outside, rel), text);
      }
      const host = api.tools('run-outside', outside);

      const list = await host.execute({ name: 'listFiles', args: { glob: '**/*.ts' } }, io(), AUTO);
      assert.equal(list.content, 'src/a.ts');
      const search = await host.execute({ name: 'searchText', args: { query: 'marker' } }, io(), AUTO);
      assert.equal(search.content, 'README.md:1: marker\nsrc/a.ts:1: export const marker = 1;');

      const edit = await host.execute(
        { name: 'editFile', args: { path: 'src/a.ts', oldText: 'marker = 1', newText: 'marker = 3' } },
        io(),
        AUTO,
      );
      assert.equal(edit.isError, undefined, edit.content);
      assert.equal(fs.readFileSync(path.join(outside, 'src', 'a.ts'), 'utf8'), 'export const marker = 3;\n');
    } finally {
      await closeAllEditors();
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
