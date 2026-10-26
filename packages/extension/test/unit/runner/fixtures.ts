import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Helper scripts for real-process tests. `parent.js` starts `grandchild.js`, which writes `started`
 * right away, prints "ready" and writes `marker` at `deadline` (epoch ms, or "+ms" after its own start)
 * unless it is killed first.
 */
export interface ProcessFixtures {
  dir: string;
  parent: string;
  emit: string;
  flood: string;
  /** Command line that starts parent → grandchild; works in PowerShell, cmd and POSIX shells. */
  treeCommand(marker: string, started: string, deadline: number | string): string;
  cleanup(): void;
}

export function createProcessFixtures(): ProcessFixtures {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'isar-runner-'));
  const write = (name: string, source: string) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, source);
    return file;
  };
  const grandchild = write(
    'grandchild.js',
    [
      "const fs = require('fs');",
      'const [marker, started, deadline] = process.argv.slice(2);',
      'fs.writeFileSync(started, String(process.pid));',
      "process.stdout.write('ready\\n');",
      "const wait = deadline.startsWith('+') ? Number(deadline.slice(1)) : Number(deadline) - Date.now();",
      "setTimeout(() => fs.writeFileSync(marker, 'late'), Math.max(0, wait));",
    ].join('\n'),
  );
  const parent = write(
    'parent.js',
    [
      "const { spawn } = require('child_process');",
      `spawn(process.execPath, [${JSON.stringify(grandchild)}, ...process.argv.slice(2)], { stdio: 'inherit' });`,
      'setInterval(() => {}, 1000);',
    ].join('\n'),
  );
  const emit = write(
    'emit.js',
    [
      "process.stdout.write('out1\\n');",
      "setTimeout(() => process.stderr.write('err1\\n'), 150);",
      "setTimeout(() => process.stdout.write('out2\\n'), 300);",
    ].join('\n'),
  );
  const flood = write(
    'flood.js',
    [
      "const line = 'x'.repeat(99) + '\\n';",
      'const total = Number(process.argv[2]);',
      'let written = 0;',
      'function pump() {',
      '  while (written < total) {',
      '    written += line.length;',
      '    if (!process.stdout.write(line)) return process.stdout.once("drain", pump);',
      '  }',
      "  process.stdout.write('END\\n');",
      '}',
      'pump();',
    ].join('\n'),
  );
  return {
    dir,
    parent,
    emit,
    flood,
    treeCommand: (marker, started, deadline) => `node "${parent}" "${marker}" "${started}" ${deadline}`,
    cleanup: () => removeTempDir(dir),
  };
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls until `check` is true or `timeoutMs` elapsed; returns the last result. */
export async function waitFor(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (check()) return true;
    await delay(50);
  }
  return check();
}

/**
 * Deletes a temp folder. Windows refuses while a just-killed process still has it as working folder, so
 * this retries and finally leaves the folder behind rather than failing the suite.
 */
export function removeTempDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {
    // A leftover temp folder is harmless.
  }
}
