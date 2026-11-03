import path from 'node:path';
import type { Diagnostic } from '@isar-flow/core';

/** `file:line:col severity message` (1-based), the form editors and terminals turn into links. */
export function formatDiagnostic(file: string, diagnostic: Diagnostic, message = diagnostic.message): string {
  const start = diagnostic.range?.start;
  const where = start ? `${file}:${start.line + 1}:${start.character + 1}` : file;
  return `${where} ${diagnostic.severity} ${message}`;
}

/** `file` relative to `cwd` when it is inside it, else absolute. */
export function displayPath(file: string, cwd: string): string {
  const rel = path.relative(cwd, file);
  return rel === '' || rel.startsWith('..') || path.isAbsolute(rel) ? file : rel;
}

/** `file` relative to the workspace folder with forward slashes, as VS Code shows it. */
export function workspacePath(file: string, root: string): string {
  const rel = path.relative(root, file);
  return rel.startsWith('..') || path.isAbsolute(rel) ? file : rel.split(path.sep).join('/');
}

/** "The workflow has 2 errors. Fix them and run again." */
export function errorSummary(what: string, count: number): string {
  return count === 1
    ? `${what} has 1 error. Fix it and run again.`
    : `${what} has ${count} errors. Fix them and run again.`;
}
