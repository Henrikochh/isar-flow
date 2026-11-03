import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

/** The log methods the safety modules use (vscode.LogOutputChannel in the extension). */
export interface SafetyLog {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

export async function exists(file: string): Promise<boolean> {
  try {
    await fs.lstat(file);
    return true;
  } catch {
    return false;
  }
}

/** sha256 (hex) of the bytes; 'missing' stands for a file that does not exist. */
export function hashOf(bytes: Uint8Array | undefined): string {
  return bytes === undefined ? 'missing' : createHash('sha256').update(bytes).digest('hex');
}

/** hashOf the bytes of a file, read as a stream (files changed by a run can be large). */
export async function hashFile(file: string | undefined): Promise<string> {
  if (file === undefined) return hashOf(undefined);
  try {
    if (!(await fs.lstat(file)).isFile()) return hashOf(undefined);
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
    return hash.digest('hex');
  } catch {
    return hashOf(undefined);
  }
}

/** Bytes of a file; undefined when it does not exist (or is not a regular file). */
export async function readIfFile(file: string): Promise<Uint8Array | undefined> {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile()) return undefined;
    return new Uint8Array(await fs.readFile(file));
  } catch {
    return undefined;
  }
}

/** Path of `absPath` relative to `root` with forward slashes; undefined when it is outside `root`. */
export function relativeTo(root: string, absPath: string): string | undefined {
  const rel = path.relative(root, absPath);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
  return rel.split(path.sep).join('/');
}

/** Joins a forward-slash relative path to a root, refusing paths that leave the root. */
export function resolveInside(root: string, rel: string): string | undefined {
  const abs = path.resolve(root, ...rel.split('/'));
  return relativeTo(root, abs) === undefined ? undefined : abs;
}

/** Git and other tools treat a NUL byte in the first 8000 bytes as the mark of a binary file. */
export function isBinary(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, 8000);
  for (let i = 0; i < end; i++) if (bytes[i] === 0) return true;
  return false;
}

export function sameBytes(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.length === b.length && Buffer.from(a).equals(Buffer.from(b));
}

export const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
