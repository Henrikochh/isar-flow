import fs from 'node:fs';
import path from 'node:path';
import { envValue } from './env';

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

/**
 * Finds an executable like `which`/`where`: a bare name is looked up on PATH (with PATHEXT on Windows),
 * a path is checked directly. Returns the full path or undefined.
 */
export function findExecutable(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const win = platform === 'win32';
  const p = win ? path.win32 : path.posix;
  const extensions = win
    ? (envValue(env, 'PATHEXT', platform) ?? DEFAULT_PATHEXT).split(';').filter((ext) => ext !== '')
    : [];
  const variants = (base: string) => (win && !p.extname(base) ? extensions.map((ext) => base + ext) : [base]);

  const isPath = command.includes('/') || (win && command.includes('\\')) || p.isAbsolute(command);
  if (isPath) return variants(command).find((candidate) => isExecutableFile(candidate, win));

  const dirs = (envValue(env, 'PATH', platform) ?? '')
    .split(p.delimiter)
    .map((dir) => dir.trim().replace(/^"(.*)"$/, '$1'))
    .filter((dir) => dir !== '');
  for (const dir of dirs) {
    const found = variants(p.join(dir, command)).find((candidate) => isExecutableFile(candidate, win));
    if (found) return found;
  }
  return undefined;
}

function isExecutableFile(file: string, win: boolean): boolean {
  try {
    if (!fs.statSync(file).isFile()) return false;
    if (!win) fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
