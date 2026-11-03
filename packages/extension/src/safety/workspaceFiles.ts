import fs from 'node:fs/promises';
import path from 'node:path';
import * as vscode from 'vscode';
import type { ReviewUi, WorkspaceFiles } from './reviewService';
import { exists, isBinary, readIfFile, sameBytes } from './util';

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * Text that can go through a WorkspaceEdit unchanged: valid UTF-8 without BOM or NUL bytes and with one kind of
 * line ending. Anything else is written as bytes.
 */
function editableText(bytes: Uint8Array): { text: string; eol?: vscode.EndOfLine } | undefined {
  if (isBinary(bytes) || (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)) return undefined;
  let text: string;
  try {
    text = strictUtf8.decode(bytes);
  } catch {
    return undefined;
  }
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length;
  if (crlf > 0 && crlf !== lf) return undefined;
  if (text.replace(/\r\n/g, '').includes('\r')) return undefined;
  if (lf === 0) return { text };
  return { text, eol: crlf > 0 ? vscode.EndOfLine.CRLF : vscode.EndOfLine.LF };
}

const samePath = (a: string, b: string) =>
  process.platform === 'win32'
    ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
    : path.resolve(a) === path.resolve(b);

function openDocument(absPath: string): vscode.TextDocument | undefined {
  return vscode.workspace.textDocuments.find(
    (doc) => doc.uri.scheme === 'file' && samePath(doc.uri.fsPath, absPath),
  );
}

/** Replaces an existing text file through VS Code, so open editors update and the change can be undone. */
async function editText(absPath: string, text: string, eol: vscode.EndOfLine | undefined): Promise<void> {
  const uri = vscode.Uri.file(absPath);
  const document = await vscode.workspace.openTextDocument(uri);
  const all = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
  const edits = [vscode.TextEdit.replace(all, text)];
  if (eol !== undefined && eol !== document.eol) edits.push(vscode.TextEdit.setEndOfLine(eol));
  const edit = new vscode.WorkspaceEdit();
  edit.set(uri, edits);
  if (!(await vscode.workspace.applyEdit(edit))) throw new Error('VS Code refused the change');
  if (document.isDirty && !(await document.save())) throw new Error('VS Code could not save the file');
}

/** Workspace file changes for keep and revert, through VS Code where editors may show the file. */
export function createVscodeWorkspaceFiles(): WorkspaceFiles {
  return {
    async current(absPath) {
      const document = openDocument(absPath);
      if (document?.isDirty) return new TextEncoder().encode(document.getText());
      return readIfFile(absPath);
    },

    async write(absPath, bytes) {
      const editable = (await exists(absPath)) ? editableText(bytes) : undefined;
      if (editable) {
        try {
          await editText(absPath, editable.text, editable.eol);
        } catch {
          // E.g. an open document that is older than the file on disk can't be saved: write the bytes instead.
        }
        // The document's encoding (a BOM, another charset) may differ from the bytes to restore.
        if (sameBytes(await readIfFile(absPath), bytes)) return;
      }
      await fs.mkdir(path.dirname(absPath), { recursive: true });
      await vscode.workspace.fs.writeFile(vscode.Uri.file(absPath), bytes);
    },

    async delete(absPath) {
      if (!(await exists(absPath))) return;
      const edit = new vscode.WorkspaceEdit();
      edit.deleteFile(vscode.Uri.file(absPath), { ignoreIfNotExists: true });
      if (await vscode.workspace.applyEdit(edit)) return;
      await fs.rm(absPath, { force: true });
    },
  };
}

export const vscodeReviewUi: ReviewUi = {
  ask: async (message, detail, buttons) =>
    vscode.window.showWarningMessage(
      message,
      { modal: true, ...(detail !== undefined && { detail }) },
      ...buttons,
    ),
  showInfo: async (message, ...buttons) => vscode.window.showInformationMessage(message, ...buttons),
  executeCommand: async (command, ...args) => vscode.commands.executeCommand(command, ...args),
};
