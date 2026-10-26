import fs from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import type { ToolWorkspace } from './types';

const EXCLUDE = '{**/node_modules/**,**/.git/**}';

/**
 * File access for agent tools through VS Code: reads see unsaved editor changes, writes go through
 * WorkspaceEdit (undoable) and are saved right away so console commands run later see them on disk.
 * `root` is the folder findFiles searches (default: the first workspace folder); pass the same folder
 * as the tool host's workspaceRoot.
 */
export function createVscodeWorkspaceAdapter(root?: string): ToolWorkspace {
  const searchRoot = (): string => {
    const folder = root ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!folder) throw new Error('No workspace folder is open.');
    return folder;
  };

  return {
    async readFile(absPath) {
      const document = openDocument(absPath);
      if (document) return document.getText();
      return new TextDecoder('utf-8').decode(await fs.promises.readFile(absPath));
    },

    async writeFile(absPath, content) {
      const uri = vscode.Uri.file(absPath);
      const edit = new vscode.WorkspaceEdit();
      if (!(await exists(absPath))) {
        edit.createFile(uri, { overwrite: false, contents: new TextEncoder().encode(content) });
        if (!(await vscode.workspace.applyEdit(edit))) {
          throw new Error(`VS Code could not create ${absPath}.`);
        }
        return;
      }
      const document = await vscode.workspace.openTextDocument(uri);
      const end = document.positionAt(document.getText().length);
      edit.replace(uri, new vscode.Range(new vscode.Position(0, 0), end), content);
      if (!(await vscode.workspace.applyEdit(edit))) throw new Error(`VS Code could not change ${absPath}.`);
      // save() reports false for a document without changes, which is fine here.
      if (document.isDirty && !(await document.save())) throw new Error(`VS Code could not save ${absPath}.`);
    },

    async findFiles(glob, max) {
      const base = searchRoot();
      const pattern = new vscode.RelativePattern(vscode.Uri.file(base), glob);
      const uris = await vscode.workspace.findFiles(pattern, EXCLUDE, max);
      return uris.map((uri) => path.relative(base, uri.fsPath).split(path.sep).join('/'));
    },

    realPath: (absPath) => fs.promises.realpath(absPath),

    exists,

    async fileSize(absPath) {
      const document = openDocument(absPath);
      if (document?.isDirty) return Buffer.byteLength(document.getText(), 'utf8');
      return fs.promises.stat(absPath).then(
        (stat) => stat.size,
        () => undefined,
      );
    },
  };
}

function exists(absPath: string): Promise<boolean> {
  return fs.promises.stat(absPath).then(
    () => true,
    () => false,
  );
}

function openDocument(absPath: string): vscode.TextDocument | undefined {
  const key = pathKey(absPath);
  return vscode.workspace.textDocuments.find(
    (doc) => doc.uri.scheme === 'file' && pathKey(doc.uri.fsPath) === key,
  );
}

function pathKey(fsPath: string): string {
  const normalized = path.normalize(fsPath);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
