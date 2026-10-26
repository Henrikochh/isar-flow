import type * as vscode from 'vscode';

export type IsarFileKind = 'workflow' | 'agent';

/** Schemes of documents the user edits; git diffs and other read-only views are skipped. */
const TRACKED_SCHEMES = new Set(['file', 'untitled', 'vscode-remote', 'vscode-userdata']);

export function isTrackedScheme(scheme: string): boolean {
  return TRACKED_SCHEMES.has(scheme);
}

/** Classifies `*.workflow.y(a)ml` and `*.agent.y(a)ml` paths (as matched by the custom editor selectors). */
export function fileKind(path: string): IsarFileKind | undefined {
  if (/\.workflow\.ya?ml$/.test(path)) return 'workflow';
  if (/\.agent\.ya?ml$/.test(path)) return 'agent';
  return undefined;
}

export function fileNameOf(uri: vscode.Uri): string {
  return uri.path.slice(uri.path.lastIndexOf('/') + 1);
}

/** Agent id from the file name, used when the agent store does not know the file. */
export function agentIdFromFileName(fileName: string): string {
  return fileName.replace(/\.agent\.ya?ml$/, '');
}
