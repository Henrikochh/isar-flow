import * as vscode from 'vscode';

// TextDecoder drops a leading UTF-8 BOM.
const decoder = new TextDecoder('utf-8');
const encoder = new TextEncoder();

export async function readText(uri: vscode.Uri): Promise<string> {
  return decoder.decode(await vscode.workspace.fs.readFile(uri));
}

export async function writeText(uri: vscode.Uri, text: string): Promise<void> {
  await vscode.workspace.fs.writeFile(uri, encoder.encode(text));
}

/** Names of the files (and links to files) in a folder, sorted; empty when the folder does not exist. */
export async function listFileNames(dir: vscode.Uri): Promise<string[]> {
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(dir);
  } catch {
    return [];
  }
  return entries
    .filter(([, type]) => (type & vscode.FileType.File) !== 0)
    .map(([name]) => name)
    .sort();
}

/** The workspace folder `folder` names, else the first one; undefined without a folder. */
export function targetFolder(folder?: vscode.Uri): vscode.Uri | undefined {
  const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri);
  const key = folder && uriKey(folder);
  return folders.find((f) => uriKey(f) === key) ?? folders[0];
}

/** Scheme, authority and path of a URI, for location comparisons (`file://host/…` is another machine). */
export function uriKey(uri: vscode.Uri): string {
  return `${uri.scheme}://${uri.authority}${uri.path}`;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
