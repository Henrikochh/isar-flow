import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Stub from '../vscode-stub';
import { createVscodeWorkspaceAdapter } from '../../../src/tools/vscodeWorkspace';
import { removeTempDir } from '../runner/fixtures';

interface FakeDocument {
  uri: Stub.Uri;
  text: string;
  isDirty: boolean;
  saved: number;
}

const state = vi.hoisted(() => ({
  documents: [] as FakeDocument[],
  applied: [] as unknown[],
  applyResult: true,
  found: [] as string[],
  findCalls: [] as unknown[][],
  findError: undefined as Error | undefined,
  insideWorkspace: true,
}));

vi.mock('vscode', async (importOriginal) => {
  const actual = await importOriginal<typeof Stub>();
  class RelativePattern {
    constructor(
      readonly baseUri: Stub.Uri,
      readonly pattern: string,
    ) {}
  }
  class WorkspaceEdit extends actual.WorkspaceEdit {
    readonly createOptions: unknown[] = [];
    override createFile(uri: Stub.Uri, options?: unknown): void {
      super.createFile(uri);
      this.createOptions.push(options);
    }
  }
  const toDocument = (doc: FakeDocument) => ({
    uri: doc.uri,
    get isDirty() {
      return doc.isDirty;
    },
    getText: () => doc.text,
    positionAt: (offset: number) => new actual.Position(0, offset),
    save: async () => {
      doc.saved++;
      doc.isDirty = false;
      return true;
    },
  });
  return {
    ...actual,
    RelativePattern,
    WorkspaceEdit,
    workspace: {
      ...actual.workspace,
      get textDocuments() {
        return state.documents.map(toDocument);
      },
      openTextDocument: async (uri: Stub.Uri) => {
        let doc = state.documents.find((d) => d.uri.fsPath === uri.fsPath);
        if (!doc) {
          doc = { uri, text: fs.readFileSync(uri.fsPath, 'utf8'), isDirty: false, saved: 0 };
          state.documents.push(doc);
        }
        return toDocument(doc);
      },
      applyEdit: async (edit: InstanceType<typeof WorkspaceEdit>) => {
        state.applied.push(edit);
        for (const change of edit.edits) {
          const doc = state.documents.find((d) => d.uri.fsPath === change.uri.fsPath);
          if (change.kind === 'replace' && doc) {
            doc.text = change.text ?? '';
            doc.isDirty = true;
          }
        }
        return state.applyResult;
      },
      findFiles: async (...args: unknown[]) => {
        state.findCalls.push(args);
        if (state.findError) throw state.findError;
        return state.found.map((file) => actual.Uri.file(file));
      },
      getWorkspaceFolder: (uri: Stub.Uri) =>
        state.insideWorkspace ? { uri, name: 'ws', index: 0 } : undefined,
    },
  };
});

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'isar-vsws-')));
afterAll(() => removeTempDir(root));

beforeEach(() => {
  state.documents = [];
  state.applied = [];
  state.applyResult = true;
  state.found = [];
  state.findCalls = [];
  state.findError = undefined;
  state.insideWorkspace = true;
});

const { Uri } = await import('vscode');

describe('createVscodeWorkspaceAdapter', () => {
  const adapter = createVscodeWorkspaceAdapter(root);

  it('reads the text of an open, unsaved document first', async () => {
    const file = path.join(root, 'open.ts');
    fs.writeFileSync(file, 'on disk');
    state.documents.push({ uri: Uri.file(file) as Stub.Uri, text: 'in the editor', isDirty: true, saved: 0 });
    expect(await adapter.readFile(file)).toBe('in the editor');
  });

  it('reports the text of an open document only while it has unsaved changes', () => {
    const file = path.join(root, 'dirty.ts');
    fs.writeFileSync(file, 'on disk');
    state.documents.push({ uri: Uri.file(file) as Stub.Uri, text: 'typed', isDirty: true, saved: 0 });
    expect(adapter.unsavedText?.(file)).toBe('typed');
    state.documents[0].isDirty = false;
    expect(adapter.unsavedText?.(file)).toBeUndefined();
    expect(adapter.unsavedText?.(path.join(root, 'closed.ts'))).toBeUndefined();
  });

  it('reads closed files from disk as UTF-8 without BOM', async () => {
    const file = path.join(root, 'closed.txt');
    fs.writeFileSync(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('Grüße', 'utf8')]));
    expect(await adapter.readFile(file)).toBe('Grüße');
  });

  it('creates new files through a workspace edit with their content', async () => {
    const file = path.join(root, 'new', 'file.ts');
    await adapter.writeFile(file, 'export {};\n');
    const edit = state.applied[0] as { edits: { kind: string }[]; createOptions: { contents: Uint8Array }[] };
    expect(edit.edits.map((e) => e.kind)).toEqual(['create']);
    expect(new TextDecoder().decode(edit.createOptions[0].contents)).toBe('export {};\n');
  });

  it('replaces existing files through a workspace edit and saves them', async () => {
    const file = path.join(root, 'existing.ts');
    fs.writeFileSync(file, 'old');
    await adapter.writeFile(file, 'new');
    const edit = state.applied[0] as { edits: { kind: string; text?: string }[] };
    expect(edit.edits).toEqual([expect.objectContaining({ kind: 'replace', text: 'new' })]);
    expect(state.documents[0].saved).toBe(1);
  });

  it('fails when VS Code refuses the edit', async () => {
    const file = path.join(root, 'refused.ts');
    fs.writeFileSync(file, 'old');
    state.applyResult = false;
    await expect(adapter.writeFile(file, 'new')).rejects.toThrow(/could not/);
  });

  it('finds files relative to the root, excluding node_modules and .git', async () => {
    state.found = [path.join(root, 'src', 'a.ts'), path.join(root, 'b.ts')];
    expect(await adapter.findFiles('**/*.ts', 50)).toEqual(['src/a.ts', 'b.ts']);
    const [pattern, exclude, max] = state.findCalls[0] as [{ pattern: string }, string, number];
    expect(pattern.pattern).toBe('**/*.ts');
    expect(exclude).toContain('**/node_modules/**');
    expect(exclude).toContain('**/.git/**');
    expect(max).toBe(50);
  });

  it('deletes files through an undoable workspace edit', async () => {
    const file = path.join(root, 'gone.ts');
    fs.writeFileSync(file, 'x');
    await adapter.deleteFile?.(file);
    const edit = state.applied[0] as { edits: { kind: string; uri: Stub.Uri }[] };
    expect(edit.edits).toEqual([expect.objectContaining({ kind: 'delete' })]);
    expect(path.normalize(edit.edits[0].uri.fsPath)).toBe(path.normalize(file));
  });

  it('fails when VS Code refuses the delete', async () => {
    state.applyResult = false;
    await expect(adapter.deleteFile?.(path.join(root, 'kept.ts'))).rejects.toThrow(
      /VS Code could not delete .*kept\.ts/,
    );
  });

  it('walks the folder itself when it is outside the workspace folders, e.g. a git worktree', async () => {
    const worktree = path.join(root, 'worktree');
    for (const rel of ['src/a.ts', 'src/b.js', 'node_modules/x/c.ts', 'README.md']) {
      fs.mkdirSync(path.dirname(path.join(worktree, rel)), { recursive: true });
      fs.writeFileSync(path.join(worktree, rel), 'x');
    }
    state.insideWorkspace = false;
    const outside = createVscodeWorkspaceAdapter(worktree);
    expect(await outside.findFiles('**/*.ts', 10)).toEqual(['src/a.ts']);
    expect(await outside.findFiles('**/*', 2)).toEqual(['README.md', 'src/a.ts']);
    expect(state.findCalls).toEqual([]);
  });

  it('walks the folder when VS Code cannot search it', async () => {
    const folder = path.join(root, 'unsearchable');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'one.txt'), 'x');
    state.findError = new Error('search provider failed');
    expect(await createVscodeWorkspaceAdapter(folder).findFiles('*.txt', 10)).toEqual(['one.txt']);
    expect(state.findCalls).toHaveLength(1);
  });

  it('checks existence and real paths on disk', async () => {
    const file = path.join(root, 'exists.txt');
    fs.writeFileSync(file, 'x');
    expect(await adapter.exists(file)).toBe(true);
    expect(await adapter.exists(path.join(root, 'nope.txt'))).toBe(false);
    expect(await adapter.realPath(file)).toBe(fs.realpathSync(file));
    await expect(adapter.realPath(path.join(root, 'nope.txt'))).rejects.toThrow();
  });
});
