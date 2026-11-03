import * as vscode from 'vscode';

/** Read-only documents of run snapshots for the diff editor: isarflow-snapshot:/<runId>/<side>/<path>. */
export const SNAPSHOT_SCHEME = 'isarflow-snapshot';

export type SnapshotSide = 'before' | 'after' | 'empty';

const RUN_ID = /^[A-Za-z0-9_-]{1,100}$/;

/** Run ids name folders and git refs, so anything else is refused. */
export const isRunId = (value: unknown): value is string => typeof value === 'string' && RUN_ID.test(value);

/** A forward-slash path inside a folder: no empty, '.' or '..' segments, no drive or backslash. */
export function isRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || value === '' || value.includes('\\') || value.includes('\0')) return false;
  if (/^[A-Za-z]:/.test(value)) return false;
  return value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

export function snapshotUri(runId: string, side: SnapshotSide, file: string): vscode.Uri {
  return vscode.Uri.file('/').with({ scheme: SNAPSHOT_SCHEME, path: `/${runId}/${side}/${file}` });
}

export function parseSnapshotUri(uri: {
  path: string;
}): { runId: string; side: SnapshotSide; path: string } | undefined {
  const match = /^\/([^/]+)\/(before|after|empty)\/(.+)$/.exec(uri.path);
  if (!match || !isRunId(match[1]) || !isRelativePath(match[3])) return undefined;
  return { runId: match[1], side: match[2] as SnapshotSide, path: match[3] };
}
