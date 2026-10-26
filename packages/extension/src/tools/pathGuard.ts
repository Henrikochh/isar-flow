import fs from 'node:fs';
import path from 'node:path';

/** A path an agent may not use; the message is written for the model and shows up in the run log. */
export class WorkspacePathError extends Error {}

const HINT = 'Use a path relative to the workspace root, for example "src/app.ts".';
const RESERVED_WINDOWS_NAME = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

/**
 * Resolves `input` (relative to `root`, or absolute) and checks lexically that it stays inside `root`:
 * no `..` escapes, no other drives, no network or device paths. Case-insensitive on Windows.
 * Returns the absolute path; throws WorkspacePathError otherwise.
 */
export function resolveInWorkspace(
  root: string,
  input: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const win = platform === 'win32';
  const p = win ? path.win32 : path.posix;
  if (input.trim() === '') throw new WorkspacePathError(`The path is empty. ${HINT}`);
  if (input.includes('\0'))
    throw new WorkspacePathError(`The path "${printable(input)}" contains a NUL character.`);
  if (win) checkWindowsForm(input);

  const rootAbs = p.resolve(root);
  const target = p.resolve(rootAbs, input);
  if (!isInside(rootAbs, target, p)) throw outside(input);
  return target;
}

export interface RealPathOptions {
  platform?: NodeJS.Platform;
  /** True when the path itself is a symbolic link or junction (checked with lstat by default). */
  isLink?: (absPath: string) => Promise<boolean>;
}

/**
 * Like resolveInWorkspace, and also follows symbolic links and junctions: the real path of the nearest
 * existing ancestor (or the path itself) must lie inside the real workspace root. A broken link on the
 * way is refused because writing through it could create a file anywhere.
 */
export async function resolveInWorkspaceReal(
  root: string,
  input: string,
  realPath: (absPath: string) => Promise<string>,
  options: RealPathOptions = {},
): Promise<string> {
  const platform = options.platform ?? process.platform;
  const p = platform === 'win32' ? path.win32 : path.posix;
  const isLink = options.isLink ?? isSymbolicLink;
  const target = resolveInWorkspace(root, input, platform);
  const realRoot = await realPath(p.resolve(root)).catch(() => p.resolve(root));

  let current = target;
  const missing: string[] = [];
  for (;;) {
    const real = await realPath(current).catch(() => undefined);
    if (real !== undefined) {
      if (!isInside(realRoot, p.join(real, ...missing), p)) {
        throw new WorkspacePathError(
          `The path "${printable(input)}" is outside the workspace: it leads there through a symbolic link or junction. ${HINT}`,
        );
      }
      return target;
    }
    if (await isLink(current)) {
      throw new WorkspacePathError(
        `The path "${printable(input)}" goes through a broken symbolic link or junction.`,
      );
    }
    const parent = p.dirname(current);
    if (parent === current) return target;
    missing.unshift(p.basename(current));
    current = parent;
  }
}

function isInside(root: string, target: string, p: typeof path.posix): boolean {
  const rel = p.relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${p.sep}`) && !p.isAbsolute(rel));
}

function checkWindowsForm(input: string): void {
  const notAllowed = (what: string) =>
    new WorkspacePathError(`${what} like "${printable(input)}" are not allowed. ${HINT}`);
  if (/^[\\/]{2}/.test(input)) throw notAllowed('Network and device paths');
  if (/^[a-z]:(?![\\/])/i.test(input)) throw notAllowed('Drive-relative paths');
  const segments = input.replace(/^[a-z]:/i, '').split(/[\\/]/);
  if (segments.some((segment) => segment.includes(':'))) throw notAllowed('Alternate data streams');
  if (segments.some((segment) => RESERVED_WINDOWS_NAME.test(segment.trim()))) {
    throw notAllowed('Reserved device names');
  }
}

function outside(input: string): WorkspacePathError {
  return new WorkspacePathError(`The path "${printable(input)}" is outside the workspace. ${HINT}`);
}

function printable(input: string): string {
  return input.replace(/\0/g, '\\0');
}

async function isSymbolicLink(absPath: string): Promise<boolean> {
  try {
    return (await fs.promises.lstat(absPath)).isSymbolicLink();
  } catch {
    return false;
  }
}
