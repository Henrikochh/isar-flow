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
        return state.found.map((file) => actual.Uri.file(file));
      },
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

  it('checks existence and real paths on disk', async () => {
    const file = path.join(root, 'exists.txt');
    fs.writeFileSync(file, 'x');
    expect(await adapter.exists(file)).toBe(true);
    expect(await adapter.exists(path.join(root, 'nope.txt'))).toBe(false);
    expect(await adapter.realPath(file)).toBe(fs.realpathSync(file));
    await expect(adapter.realPath(path.join(root, 'nope.txt'))).rejects.toThrow();
  });
});
