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
  const target = resolveInWorkspace(root, input, platform);
  const realRoot = await realPath(p.resolve(root)).catch(() => p.resolve(root));
  const real = await realPathOfNearest(target, input, realPath, options.isLink ?? isSymbolicLink, p);
  if (real !== undefined && !isInside(realRoot, real, p)) {
    throw new WorkspacePathError(
      `The path "${printable(input)}" is outside the workspace: it leads there through a symbolic link or junction. ${HINT}`,
    );
  }
  return target;
}

/**
 * `absPath` relative to the real workspace root once links, junctions and Windows short names (GIT~1) are
 * resolved, i.e. what the file system will actually touch. Forward slashes; '.' for the root.
 */
export async function realRelativePath(
  root: string,
  absPath: string,
  realPath: (absPath: string) => Promise<string>,
  options: RealPathOptions = {},
): Promise<string> {
  const p = (options.platform ?? process.platform) === 'win32' ? path.win32 : path.posix;
  const lexicalRoot = p.resolve(root);
  const real = await realPathOfNearest(absPath, absPath, realPath, options.isLink ?? isSymbolicLink, p);
  const rel =
    real === undefined
      ? p.relative(lexicalRoot, absPath)
      : p.relative(await realPath(lexicalRoot).catch(() => lexicalRoot), real);
  return rel.split(p.sep).join('/') || '.';
}

/** Real path of the nearest existing ancestor of `target` (or of itself) with the missing parts appended. */
async function realPathOfNearest(
  target: string,
  input: string,
  realPath: (absPath: string) => Promise<string>,
  isLink: (absPath: string) => Promise<boolean>,
  p: typeof path.posix,
): Promise<string | undefined> {
  let current = target;
  const missing: string[] = [];
  for (;;) {
    const real = await realPath(current).catch(() => undefined);
    if (real !== undefined) return p.join(real, ...missing);
    if (await isLink(current)) {
      throw new WorkspacePathError(
        `The path "${printable(input)}" goes through a broken symbolic link or junction.`,
      );
    }
    const parent = p.dirname(current);
    if (parent === current) return undefined;
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
