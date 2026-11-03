import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** True when a git executable can be started; git tests are skipped (with a message) otherwise. */
export const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    console.warn('git is not installed or not on PATH: the git snapshot tests are skipped.');
    return false;
  }
})();

const created: string[] = [];

/** A new empty folder under os.tmpdir() (long path form, so it compares equal to what git reports). */
export function tempDir(prefix = 'isar-safety-'): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  created.push(dir);
  return dir;
}

/** Removes the folders made by tempDir; call in afterAll. */
export function removeTempDirs(): void {
  for (const dir of created.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

/** Runs git in a test repository with a fixed identity, no signing and no hooks. */
export function gitIn(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'commit.gpgsign=false',
      '-c',
      `core.hooksPath=${path.join(os.tmpdir(), 'isar-no-hooks')}`,
      ...args,
    ],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

/** Writes files relative to `root` (parent folders created). */
export function writeFiles(root: string, files: Record<string, string | Uint8Array>): void {
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
}

/** A git repository with `files` committed (no commit when `files` is empty). autocrlf is off unless set. */
export function initRepo(files: Record<string, string | Uint8Array> = {}, autocrlf = 'false'): string {
  const repo = tempDir();
  gitIn(repo, 'init', '-q');
  gitIn(repo, 'config', 'core.autocrlf', autocrlf);
  if (Object.keys(files).length > 0) {
    writeFiles(repo, files);
    gitIn(repo, 'add', '-A');
    gitIn(repo, 'commit', '-q', '-m', 'initial');
  }
  return repo;
}

export const silentLog = () => {
  const lines: string[] = [];
  return {
    lines,
    info: (message: string) => void lines.push(`info: ${message}`),
    warn: (message: string) => void lines.push(`warn: ${message}`),
    error: (message: string) => void lines.push(`error: ${message}`),
  };
};
