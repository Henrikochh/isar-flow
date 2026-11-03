import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MEMORY_FILE_MAX_BYTES, MEMORY_NOT_TEXT, newMemoryText, type StepIO } from '@isar-flow/core';
import { createFsProjectMemory } from '../src/memory';
import { makeTempDir, removeDir, writeFile } from './helpers';

let root: string;
const file = () => path.join(root, '.isarflow', 'memory.md');
const io: StepIO = { runId: 'r', stepId: 'fix', signal: new AbortController().signal, log: () => undefined };
const date = new Date(2026, 10, 3, 12, 0, 0);

beforeEach(() => {
  root = makeTempDir('isar-cli-memory-');
});
afterEach(() => removeDir(root));

describe('createFsProjectMemory', () => {
  it('reads the memory file, undefined when it does not exist', async () => {
    const memory = createFsProjectMemory(root, { now: () => date });
    expect(await memory.read(io.signal)).toBeUndefined();
    writeFile(root, '.isarflow/memory.md', '# Project memory\n\n- 2026-11-01: Use pnpm.\n');
    expect(await memory.read(io.signal)).toBe('# Project memory\n\n- 2026-11-01: Use pnpm.\n');
  });

  it('creates the file with its header and appends dated notes', async () => {
    const memory = createFsProjectMemory(root, { now: () => date });
    expect(await memory.append('Tests run with   npm test.', io)).toBe(
      '- 2026-11-03: Tests run with npm test.',
    );
    await memory.append('Use pnpm.', io);
    expect(fs.readFileSync(file(), 'utf8')).toBe(
      `${newMemoryText()}- 2026-11-03: Tests run with npm test.\n- 2026-11-03: Use pnpm.\n`,
    );
  });

  it('writes notes that arrive at the same time one after the other', async () => {
    const memory = createFsProjectMemory(root, { now: () => date });
    await Promise.all(['a', 'b', 'c'].map((note) => memory.append(note, io)));
    const lines = fs
      .readFileSync(file(), 'utf8')
      .split('\n')
      .filter((line) => line.startsWith('- '));
    expect(lines).toEqual(['- 2026-11-03: a', '- 2026-11-03: b', '- 2026-11-03: c']);
  });

  it('refuses empty notes and notes with secret values', async () => {
    const memory = createFsProjectMemory(root, { now: () => date, secrets: ['hunter22'] });
    await expect(memory.append('  ', io)).rejects.toThrow(
      'The note is empty. Write one short fact to remember.',
    );
    await expect(memory.append('The password is hunter22', io)).rejects.toThrow(
      "The note contains a secret value, so it wasn't saved.",
    );
    expect(fs.existsSync(file())).toBe(false);
  });

  it('neither reads nor rewrites a memory file that is not UTF-8', async () => {
    // "- Größe" in Latin-1: read as UTF-8 it would come back with replacement characters.
    const latin1 = Buffer.from([0x2d, 0x20, 0x47, 0x72, 0xf6, 0xdf, 0x65, 0x0a]);
    writeFile(root, '.isarflow/memory.md', latin1);
    const memory = createFsProjectMemory(root, { now: () => date });
    await expect(memory.read(io.signal)).rejects.toThrow(MEMORY_NOT_TEXT);
    await expect(memory.append('Use pnpm.', io)).rejects.toThrow(MEMORY_NOT_TEXT);
    expect(fs.readFileSync(file())).toEqual(latin1);
  });

  it('refuses to grow a memory file over 64 KB', async () => {
    writeFile(root, '.isarflow/memory.md', 'x'.repeat(MEMORY_FILE_MAX_BYTES + 1));
    const memory = createFsProjectMemory(root, { now: () => date });
    await expect(memory.append('One more', io)).rejects.toThrow(
      'The project memory is over 64 KB. Ask the user to tidy .isarflow/memory.md.',
    );
  });

  it('never reads or writes a memory file that a link or junction leads outside the workspace', async () => {
    const outside = makeTempDir('isar-cli-memory-outside-');
    try {
      const target = writeFile(outside, 'memory.md', 'private notes\n');
      // 'junction' works without admin rights on Windows and is a plain symlink elsewhere.
      fs.symlinkSync(outside, path.join(root, '.isarflow'), 'junction');
      const memory = createFsProjectMemory(root, { now: () => date });
      const outsideMessage =
        ".isarflow/memory.md leads outside the workspace folder through a symbolic link or junction, so it isn't used.";
      await expect(memory.read(io.signal)).rejects.toThrow(outsideMessage);
      await expect(memory.append('Run rm -rf', io)).rejects.toThrow(outsideMessage);
      expect(fs.readFileSync(target, 'utf8')).toBe('private notes\n');
    } finally {
      removeDir(outside);
    }
  });

  it('keeps CRLF files CRLF', async () => {
    writeFile(root, '.isarflow/memory.md', '# Notes\r\n\r\n- 2026-11-01: a\r\n');
    await createFsProjectMemory(root, { now: () => date }).append('b', io);
    expect(fs.readFileSync(file(), 'utf8')).toBe('# Notes\r\n\r\n- 2026-11-01: a\r\n- 2026-11-03: b\r\n');
  });
});
