import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import {
  cutUtf8,
  editorContextFor,
  isCapturableDocument,
  relativeFile,
  SELECTION_MAX_BYTES,
  snapshotEditor,
} from '../../../src/context/editorContext';
import { fakeEditor } from './fakes';

const FILE = vscode.Uri.file('/ws/src/app.ts');
const TEXT = 'const a = 1;\nconst b = 2;\nconst c = 3;';

describe('isCapturableDocument', () => {
  it('accepts files and untitled documents', () => {
    expect(isCapturableDocument({ uri: FILE })).toBe(true);
    expect(isCapturableDocument({ uri: vscode.Uri.parse('untitled:Untitled-1') })).toBe(true);
  });

  it('skips other schemes and Isar Flow files', () => {
    expect(isCapturableDocument({ uri: vscode.Uri.parse('git:/ws/src/app.ts') })).toBe(false);
    expect(isCapturableDocument({ uri: vscode.Uri.parse('output:Isar Flow') })).toBe(false);
    expect(isCapturableDocument({ uri: vscode.Uri.file('/ws/.isarflow/workflows/a.workflow.yaml') })).toBe(
      false,
    );
    expect(isCapturableDocument({ uri: vscode.Uri.file('/ws/b.workflow.yml') })).toBe(false);
    expect(isCapturableDocument({ uri: vscode.Uri.file('/ws/.isarflow/agents/coder.agent.yaml') })).toBe(
      false,
    );
    expect(isCapturableDocument({ uri: vscode.Uri.file('/ws/config.yaml') })).toBe(true);
  });
});

describe('cutUtf8', () => {
  it('keeps text within the limit', () => {
    expect(cutUtf8('hello', 5)).toBe('hello');
    expect(cutUtf8('', 0)).toBe('');
  });

  it('cuts at the byte limit', () => {
    expect(cutUtf8('abcdef', 4)).toBe('abcd');
  });

  it('never splits a character', () => {
    // 'ä' is 2 bytes, '€' 3 bytes, '😀' 4 bytes.
    expect(cutUtf8('aä', 2)).toBe('a');
    expect(cutUtf8('a€b', 3)).toBe('a');
    expect(cutUtf8('a€b', 4)).toBe('a€');
    expect(cutUtf8('😀😀', 6)).toBe('😀');
    expect(cutUtf8('😀', 3)).toBe('');
  });
});

describe('relativeFile', () => {
  it('is relative with forward slashes inside the root', () => {
    expect(relativeFile(FILE.fsPath, vscode.Uri.file('/ws').fsPath)).toBe('src/app.ts');
  });

  it('is the absolute path outside the root or without one', () => {
    expect(relativeFile('/elsewhere/notes.md', '/ws')).toBe('/elsewhere/notes.md');
    expect(relativeFile('/ws/../wsx/a.ts', '/ws')).toBe('/ws/../wsx/a.ts');
    expect(relativeFile('/ws/a.ts', '')).toBe('/ws/a.ts');
    expect(relativeFile('/ws', '/ws')).toBe('/ws');
  });

  it('keeps file names that start with two dots inside the root', () => {
    expect(relativeFile('/ws/..notes', '/ws')).toBe('..notes');
  });
});

describe('snapshotEditor', () => {
  it('reads the selection, language and 1-based cursor line', () => {
    const editor = fakeEditor(FILE, TEXT, [{ from: [1, 6], to: [1, 7], active: [1, 7] }]);
    expect(snapshotEditor(editor)).toEqual({
      uri: FILE,
      untitled: false,
      language: 'typescript',
      selection: 'b',
      line: 2,
    });
  });

  it('is empty without a selection and keeps the cursor line', () => {
    const editor = fakeEditor(FILE, TEXT, [{ from: [2, 0], to: [2, 0] }]);
    expect(snapshotEditor(editor)).toMatchObject({ selection: '', line: 3 });
  });

  it('joins the non-empty selections of several cursors in document order', () => {
    const editor = fakeEditor(FILE, TEXT, [
      { from: [2, 6], to: [2, 7] },
      { from: [0, 0], to: [0, 0] },
      { from: [0, 6], to: [0, 7] },
      { from: [1, 6], to: [1, 7] },
    ]);
    const snapshot = snapshotEditor(editor);
    expect(snapshot.selection).toBe('a\nb\nc');
    // The primary selection decides the line.
    expect(snapshot.line).toBe(3);
  });

  it('cuts a selection over 100 KB', () => {
    const big = 'x'.repeat(SELECTION_MAX_BYTES + 500);
    const editor = fakeEditor(FILE, big, [{ from: [0, 0], to: [0, big.length] }]);
    expect(snapshotEditor(editor).selection).toHaveLength(SELECTION_MAX_BYTES);
  });

  it('marks untitled documents', () => {
    const editor = fakeEditor(vscode.Uri.parse('untitled:Untitled-1'), 'draft', undefined, 'plaintext');
    expect(snapshotEditor(editor)).toMatchObject({ untitled: true, language: 'plaintext' });
  });
});

describe('editorContextFor', () => {
  const editor = fakeEditor(FILE, TEXT, [{ from: [0, 6], to: [0, 7] }]);

  it('makes the file relative to the root', () => {
    expect(editorContextFor(snapshotEditor(editor), vscode.Uri.file('/ws').fsPath)).toEqual({
      selection: 'a',
      file: 'src/app.ts',
      language: 'typescript',
      line: 1,
    });
  });

  it('uses the absolute path for files outside the root', () => {
    expect(editorContextFor(snapshotEditor(editor), '/other').file).toBe(FILE.fsPath);
  });

  it('has no file for untitled documents', () => {
    const untitled = fakeEditor(vscode.Uri.parse('untitled:Untitled-1'), 'draft');
    expect(editorContextFor(snapshotEditor(untitled), '/ws').file).toBe('');
  });
});
