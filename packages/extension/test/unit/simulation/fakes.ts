import * as vscode from 'vscode';
import type {
  SimulationDocument,
  SimulationDocuments,
  SimulationFs,
  SimulationWatcher,
} from '../../../src/simulation/simulationIo';

/** Files by URI path; `failures` makes reads of a path reject. */
export class FakeSimulationFs implements SimulationFs {
  readonly files = new Map<string, string>();
  readonly failures = new Map<string, Error>();
  readonly writes: { path: string; text: string }[] = [];
  /** Resolves each write only after this promise, to test queueing. */
  gate: Promise<void> | undefined;

  async read(uri: vscode.Uri): Promise<string | undefined> {
    const failure = this.failures.get(uri.path);
    if (failure) throw failure;
    return this.files.get(uri.path);
  }

  async write(uri: vscode.Uri, text: string): Promise<void> {
    if (this.gate) await this.gate;
    this.writes.push({ path: uri.path, text });
    this.files.set(uri.path, text);
  }

  exists(uri: vscode.Uri): boolean {
    return this.files.has(uri.path);
  }
}

export class FakeDocument implements SimulationDocument {
  saves = 0;
  constructor(
    public text: string,
    public isDirty = false,
    private readonly onSave?: (text: string) => void,
    public saveResult = true,
  ) {}
  getText(): string {
    return this.text;
  }
  async save(): Promise<boolean> {
    this.saves++;
    if (!this.saveResult) return false;
    this.isDirty = false;
    this.onSave?.(this.text);
    return true;
  }
}

/** Open editors by URI path. */
export class FakeDocuments implements SimulationDocuments {
  readonly open = new Map<string, FakeDocument>();
  readonly shown: vscode.Uri[] = [];
  readonly edits: { path: string; text: string }[] = [];
  acceptEdits = true;
  private readonly changes = new vscode.EventEmitter<vscode.Uri>();

  constructor(private readonly fs: FakeSimulationFs) {}

  /** Opens a document; a dirty one has unsaved edits that differ from the file. */
  add(path: string, text: string, dirty = false): FakeDocument {
    const doc = new FakeDocument(text, dirty, (saved) => this.fs.files.set(path, saved));
    this.open.set(path, doc);
    return doc;
  }

  find(uri: vscode.Uri): FakeDocument | undefined {
    return this.open.get(uri.path);
  }

  async replaceAll(uri: vscode.Uri, text: string): Promise<boolean> {
    const doc = this.open.get(uri.path);
    if (!doc || !this.acceptEdits) return false;
    this.edits.push({ path: uri.path, text });
    doc.text = text;
    doc.isDirty = true;
    return true;
  }

  onDidChange(listener: (uri: vscode.Uri) => void): vscode.Disposable {
    return this.changes.event(listener);
  }

  fireChange(uri: vscode.Uri): void {
    this.changes.fire(uri);
  }

  async show(uri: vscode.Uri): Promise<void> {
    this.shown.push(uri);
  }
}

export class FakeWatcher implements SimulationWatcher {
  readonly created = new vscode.EventEmitter<vscode.Uri>();
  readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly deleted = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidCreate = this.created.event;
  readonly onDidChange = this.changed.event;
  readonly onDidDelete = this.deleted.event;
  disposed = false;
  constructor(readonly glob: string) {}
  dispose(): void {
    this.disposed = true;
  }
}
