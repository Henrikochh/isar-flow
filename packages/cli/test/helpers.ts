import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { CliIo } from '../src/io';

/** A temp folder with its real path (macOS /var → /private/var, Windows short names). */
export function makeTempDir(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/** Windows may refuse while a just-killed process still uses the folder; a leftover temp folder is harmless. */
export function removeDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {
    // Ignored on purpose.
  }
}

export function writeFile(root: string, rel: string, content: string | Buffer): string {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

export interface CapturedStream {
  write(text: string): boolean;
  isTTY?: boolean;
  text(): string;
}

export function captureStream(isTTY = false): CapturedStream {
  const chunks: string[] = [];
  return {
    isTTY,
    write: (text) => {
      chunks.push(text);
      return true;
    },
    text: () => chunks.join(''),
  };
}

export type ScriptedInput = PassThrough & { isTTY?: boolean };

/** stdin for tests: a terminal (`isTTY`) or a pipe; `lines` are typed one after the other. */
export function scriptedInput(lines: string[] = [], isTTY = true): ScriptedInput {
  const input: ScriptedInput = new PassThrough();
  input.isTTY = isTTY;
  if (lines.length > 0) input.write(lines.map((line) => `${line}\n`).join(''));
  return input;
}

export interface TestIo extends CliIo {
  stdout: CapturedStream;
  stderr: CapturedStream;
  stdin: ScriptedInput;
}

export function testIo(cwd: string, overrides: Partial<CliIo> = {}): TestIo {
  return {
    stdout: captureStream(),
    stderr: captureStream(),
    stdin: scriptedInput([], false),
    env: {},
    cwd,
    gitTopLevel: async () => undefined,
    ...overrides,
  } as TestIo;
}
