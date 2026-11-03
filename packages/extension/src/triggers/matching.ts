import type * as vscode from 'vscode';
import { IGNORE_PATH_CASE } from '../store/paths';
import { globMatcher } from '../tools/glob';

/** Files in these folders (at any depth) never trigger, unless a positive pattern names the folder. */
const QUIET_FOLDERS = ['.git', 'node_modules', '.isarflow'];

/** The `files` of a save or change trigger. */
export interface FileMatcher {
  /** Positive patterns, normalized; the change trigger watches each of them. */
  readonly patterns: string[];
  /** Whether a workspace-relative path (forward slashes) triggers. */
  matches(relativePath: string): boolean;
}

const normalize = (pattern: string) =>
  pattern
    .trim()
    .replace(/\\/g, '/')
    .replace(/^(?:\.\/)+/, '');

/** Positive patterns include, `!` patterns exclude. */
export function compileFiles(files: readonly string[]): FileMatcher {
  const positive: string[] = [];
  const negative: string[] = [];
  for (const file of files) {
    const pattern = normalize(file);
    if (pattern.startsWith('!')) {
      const excluded = normalize(pattern.slice(1));
      if (excluded) negative.push(excluded);
    } else if (pattern) {
      positive.push(pattern);
    }
  }
  const include = positive.map((pattern) => globMatcher(pattern));
  const exclude = negative.map((pattern) => globMatcher(pattern));
  const quiet = QUIET_FOLDERS.filter((folder) => !positive.some((p) => p.split('/').includes(folder)));
  return {
    patterns: positive,
    matches(relativePath) {
      const folders = relativePath.split('/').slice(0, -1);
      if (folders.some((folder) => quiet.includes(folder))) return false;
      return include.some((match) => match(relativePath)) && !exclude.some((match) => match(relativePath));
    },
  };
}

/** `file` relative to `folder` with forward slashes; undefined when it is not inside the folder. */
export function relativeIn(folder: vscode.Uri, file: vscode.Uri): string | undefined {
  if (folder.scheme !== file.scheme || folder.authority !== file.authority) return undefined;
  const base = `${folder.path.replace(/\/+$/, '')}/`;
  const inside = IGNORE_PATH_CASE
    ? file.path.toLowerCase().startsWith(base.toLowerCase())
    : file.path.startsWith(base);
  return inside && file.path.length > base.length ? file.path.slice(base.length) : undefined;
}

/** Comparable form of an absolute file path (forward slashes; lower case where file systems ignore case). */
export function pathKey(fsPath: string): string {
  const slashes = fsPath.replace(/\\/g, '/');
  return IGNORE_PATH_CASE ? slashes.toLowerCase() : slashes;
}
