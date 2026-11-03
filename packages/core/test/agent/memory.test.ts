import { describe, expect, it } from 'vitest';
import {
  appendMemoryNote,
  capMemoryText,
  checkMemoryNote,
  decodeMemoryText,
  MEMORY_FILE,
  MEMORY_FILE_MAX_BYTES,
  MEMORY_NOT_TEXT,
  MEMORY_NOTE_MAX_CHARS,
  MEMORY_PROMPT_MAX_BYTES,
  memoryNoteLine,
  memorySection,
  newMemoryText,
  REMEMBER_TOOL,
} from '../../src/agent';

const HEADER =
  '# Project memory\n\nNotes for Isar Flow agents. Agents with memory set to read see the first 8 KB of this ' +
  'file; agents with write add notes with the remember tool. Edit it freely.\n\n';

const bytes = (text: string) => new TextEncoder().encode(text).length;

describe('memory constants', () => {
  it('names the file and the limits', () => {
    expect(MEMORY_FILE).toBe('.isarflow/memory.md');
    expect(MEMORY_PROMPT_MAX_BYTES).toBe(8192);
    expect(MEMORY_FILE_MAX_BYTES).toBe(65536);
    expect(MEMORY_NOTE_MAX_CHARS).toBe(500);
  });

  it('describes the remember tool with one required note', () => {
    expect(REMEMBER_TOOL).toEqual({
      name: 'remember',
      description:
        'Save one short, durable fact about this project (conventions, commands, decisions) to the project ' +
        'memory so later runs know it. Not for task progress. At most 500 characters.',
      parameters: {
        type: 'object',
        properties: { note: { type: 'string', description: expect.any(String) } },
        required: ['note'],
        additionalProperties: false,
      },
    });
  });
});

describe('newMemoryText', () => {
  it('is the header of a new memory file', () => {
    expect(newMemoryText()).toBe(HEADER);
  });
});

describe('memoryNoteLine', () => {
  it('is a bullet with the local date', () => {
    expect(memoryNoteLine('Tests run with npm test.', new Date(2026, 10, 3, 23, 59))).toBe(
      '- 2026-11-03: Tests run with npm test.',
    );
    expect(memoryNoteLine('x', new Date(2027, 0, 9))).toBe('- 2027-01-09: x');
  });

  it('collapses whitespace runs and trims', () => {
    expect(memoryNoteLine('  Use pnpm,\r\n\tnot   npm.  ', new Date(2026, 10, 3))).toBe(
      '- 2026-11-03: Use pnpm, not npm.',
    );
  });
});

describe('checkMemoryNote', () => {
  it('accepts a short note', () => {
    expect(checkMemoryNote('The API lives in src/api.', [])).toBeUndefined();
    expect(checkMemoryNote('x'.repeat(500), [])).toBeUndefined();
  });

  it('refuses empty notes', () => {
    expect(checkMemoryNote('', [])).toBe('The note is empty. Write one short fact to remember.');
    expect(checkMemoryNote(' \n\t ', [])).toBe('The note is empty. Write one short fact to remember.');
  });

  it('refuses long notes with their length', () => {
    expect(checkMemoryNote('x'.repeat(612), [])).toBe(
      'The note is too long (612 characters). Keep it under 500 characters.',
    );
    expect(checkMemoryNote('y'.repeat(1234), [])).toBe(
      'The note is too long (1,234 characters). Keep it under 500 characters.',
    );
  });

  it('counts the note as it is saved (whitespace collapsed) and characters, not UTF-16 units', () => {
    expect(checkMemoryNote(`${'a '.repeat(250)}${' '.repeat(100)}`, [])).toBeUndefined();
    expect(checkMemoryNote('😀'.repeat(500), [])).toBeUndefined();
  });

  it('refuses notes with a secret value of 4 or more characters', () => {
    const message = "The note contains a secret value, so it wasn't saved.";
    expect(checkMemoryNote('The token is s3cr3t-value.', ['s3cr3t-value'])).toBe(message);
    expect(checkMemoryNote('The pin is abc.', ['abc'])).toBeUndefined();
    expect(checkMemoryNote('Key: ab\n  cd', ['ab cd'])).toBe(message);
    expect(checkMemoryNote(`${'x'.repeat(600)} hunter22`, ['hunter22'])).toBe(message);
  });
});

describe('capMemoryText', () => {
  it('keeps text up to 8 KB as it is', () => {
    expect(capMemoryText('- a\n- b\n')).toEqual({ text: '- a\n- b\n', truncated: false });
    const exact = 'x'.repeat(8192);
    expect(capMemoryText(exact)).toEqual({ text: exact, truncated: false });
    expect(capMemoryText('')).toEqual({ text: '', truncated: false });
  });

  it('cuts longer text at a line boundary', () => {
    const lines = Array.from({ length: 400 }, (_, i) => `- note ${String(i).padStart(3, '0')} xxxxxxxxxxx`);
    const result = capMemoryText(lines.join('\n'));
    expect(result.truncated).toBe(true);
    expect(bytes(result.text)).toBeLessThanOrEqual(8192);
    expect(result.text.endsWith('xxxxxxxxxxx')).toBe(true);
    expect(lines.join('\n').startsWith(result.text)).toBe(true);
    expect(bytes(result.text)).toBeGreaterThan(8192 - 30);
  });

  it('cuts one long line at a character boundary (multibyte characters stay whole)', () => {
    const text = `a${'€'.repeat(4000)}`;
    const result = capMemoryText(text);
    expect(result.truncated).toBe(true);
    expect(result.text).toBe(`a${'€'.repeat(2730)}`);
    expect(bytes(result.text)).toBe(8191);
  });

  it('prefers a character boundary when the last line break is far back', () => {
    const text = `intro\n${'z'.repeat(9000)}`;
    const result = capMemoryText(text);
    expect(result.text).toBe(`intro\n${'z'.repeat(8192 - 6)}`);
  });

  it('keeps surrogate pairs whole', () => {
    const text = '😀'.repeat(3000);
    const result = capMemoryText(text);
    expect(result.text).toBe('😀'.repeat(2048));
  });

  it('reads CRLF files and a byte order mark', () => {
    expect(capMemoryText('\uFEFF# Project memory\r\n\r\n- a\r\n')).toEqual({
      text: '# Project memory\n\n- a\n',
      truncated: false,
    });
    const crlf = Array.from({ length: 1000 }, () => '- 0123456789').join('\r\n');
    const result = capMemoryText(crlf);
    expect(result.truncated).toBe(true);
    expect(result.text).not.toContain('\r');
    expect(result.text.endsWith('- 0123456789')).toBe(true);
  });
});

describe('decodeMemoryText', () => {
  const utf8 = (text: string) => new TextEncoder().encode(text);

  it('decodes UTF-8 without the byte order mark and keeps line endings', () => {
    expect(decodeMemoryText(utf8('﻿# Notizen\r\n- Größe\r\n'))).toBe('# Notizen\r\n- Größe\r\n');
    expect(decodeMemoryText(new Uint8Array())).toBe('');
  });

  it('refuses bytes that are not UTF-8 text, so a rewrite cannot garble the file', () => {
    expect(MEMORY_NOT_TEXT).toBe(
      ".isarflow/memory.md isn't UTF-8 text, so it isn't used. Save it with the encoding UTF-8 (Save with Encoding in VS Code).",
    );
    const utf16 = new Uint8Array([0xff, 0xfe, ...Buffer.from('# Notes\r\n', 'utf16le')]);
    expect(() => decodeMemoryText(utf16)).toThrow(MEMORY_NOT_TEXT);
    expect(() => decodeMemoryText(Buffer.from('# Notes', 'utf16le'))).toThrow(MEMORY_NOT_TEXT);
    expect(() => decodeMemoryText(new Uint8Array([0x47, 0x72, 0xf6, 0xdf, 0x65]))).toThrow(MEMORY_NOT_TEXT);
  });
});

describe('appendMemoryNote', () => {
  const line = '- 2026-11-03: Use pnpm.';

  it('starts a new file with the header', () => {
    expect(appendMemoryNote(undefined, line)).toBe(`${HEADER}${line}\n`);
  });

  it('appends to existing text, adding a line break when missing', () => {
    expect(appendMemoryNote(`${HEADER}- old\n`, line)).toBe(`${HEADER}- old\n${line}\n`);
    expect(appendMemoryNote('- old', line)).toBe(`- old\n${line}\n`);
    expect(appendMemoryNote('', line)).toBe(`${line}\n`);
  });

  it('keeps CRLF line endings of the file', () => {
    expect(appendMemoryNote('# Memory\r\n\r\n- old', line)).toBe(`# Memory\r\n\r\n- old\r\n${line}\r\n`);
    expect(appendMemoryNote('# Memory\r\n', line)).toBe(`# Memory\r\n${line}\r\n`);
  });
});

describe('memorySection', () => {
  it('is empty without notes and without remember', () => {
    expect(memorySection(undefined)).toBe('');
    expect(memorySection({ text: '  \n' })).toBe('');
  });

  it('shows the notes', () => {
    expect(memorySection({ text: '# Project memory\n\n- a\n' })).toBe(
      '## Project memory\n\nNotes saved in .isarflow/memory.md by earlier runs. Use them as background; the task ' +
        'has priority.\n\n# Project memory\n\n- a',
    );
  });

  it('says when only the beginning is shown and when remember is offered', () => {
    const remember = async () => '';
    expect(memorySection({ text: '- a', truncated: true, remember })).toBe(
      '## Project memory\n\nNotes saved in .isarflow/memory.md by earlier runs. Use them as background; the task ' +
        'has priority.\n\n- a\n\n(Only the beginning of the file is shown.)\n\nUse the remember tool to save a ' +
        'short, durable fact about this project for later runs, one per call.',
    );
  });

  it('offers remember without notes', () => {
    expect(memorySection({ remember: async () => '' })).toBe(
      '## Project memory\n\nNo notes are saved in .isarflow/memory.md yet.\n\nUse the remember tool to save a ' +
        'short, durable fact about this project for later runs, one per call.',
    );
  });
});
