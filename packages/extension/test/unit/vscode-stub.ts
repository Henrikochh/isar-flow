/**
 * Minimal stand-in for the `vscode` module in unit tests (aliased in vitest.config.mts).
 * Add exports here additively when a module under test needs more; integration tests use the real API.
 */

type Listener<T> = (e: T) => unknown;

export class EventEmitter<T> {
  private listeners: Listener<T>[] = [];
  event = (listener: Listener<T>) => {
    this.listeners.push(listener);
    return { dispose: () => (this.listeners = this.listeners.filter((l) => l !== listener)) };
  };
  fire(data: T): void {
    for (const l of [...this.listeners]) l(data);
  }
  dispose(): void {
    this.listeners = [];
  }
}

export class Disposable {
  constructor(private readonly fn: () => void) {}
  static from(...items: { dispose(): unknown }[]): Disposable {
    return new Disposable(() => items.forEach((i) => i.dispose()));
  }
  dispose(): void {
    this.fn();
  }
}

export class Uri {
  private constructor(
    readonly scheme: string,
    readonly path: string,
  ) {}
  static file(fsPath: string): Uri {
    return new Uri('file', fsPath.replace(/\\/g, '/'));
  }
  static parse(value: string): Uri {
    const match = /^([a-z][\w+.-]*):(?:\/\/)?(.*)$/i.exec(value);
    return match ? new Uri(match[1], match[2].startsWith('/') ? match[2] : `/${match[2]}`) : Uri.file(value);
  }
  static joinPath(base: Uri, ...segments: string[]): Uri {
    return new Uri(base.scheme, [base.path.replace(/\/$/, ''), ...segments].join('/'));
  }
  get fsPath(): string {
    return this.path;
  }
  with(change: { path?: string; scheme?: string }): Uri {
    return new Uri(change.scheme ?? this.scheme, change.path ?? this.path);
  }
  toString(): string {
    return `${this.scheme}://${this.path}`;
  }
}

export class Position {
  constructor(
    readonly line: number,
    readonly character: number,
  ) {}
}

export class Range {
  constructor(
    readonly start: Position,
    readonly end: Position,
  ) {}
}

export class WorkspaceEdit {
  readonly edits: { kind: string; uri: Uri; range?: Range; text?: string }[] = [];
  replace(uri: Uri, range: Range, text: string): void {
    this.edits.push({ kind: 'replace', uri, range, text });
  }
  insert(uri: Uri, position: Position, text: string): void {
    this.edits.push({ kind: 'insert', uri, range: new Range(position, position), text });
  }
  createFile(uri: Uri, _options?: unknown): void {
    this.edits.push({ kind: 'create', uri });
  }
}

export class CancellationTokenSource {
  private emitter = new EventEmitter<void>();
  token = { isCancellationRequested: false, onCancellationRequested: this.emitter.event };
  cancel(): void {
    this.token.isCancellationRequested = true;
    this.emitter.fire();
  }
  dispose(): void {}
}

export enum LanguageModelChatMessageRole {
  User = 1,
  Assistant = 2,
}

export class LanguageModelTextPart {
  constructor(public value: string) {}
}

export class LanguageModelToolCallPart {
  constructor(
    public callId: string,
    public name: string,
    public input: object,
  ) {}
}

export class LanguageModelToolResultPart {
  constructor(
    public callId: string,
    public content: unknown[],
  ) {}
}

export class LanguageModelChatMessage {
  constructor(
    public role: LanguageModelChatMessageRole,
    public content: unknown,
    public name?: string,
  ) {}
  static User(content: unknown, name?: string) {
    return new LanguageModelChatMessage(LanguageModelChatMessageRole.User, content, name);
  }
  static Assistant(content: unknown, name?: string) {
    return new LanguageModelChatMessage(LanguageModelChatMessageRole.Assistant, content, name);
  }
}

export class LanguageModelError extends Error {
  constructor(
    message: string,
    public code = 'Unknown',
  ) {
    super(message);
  }
}

export enum DiagnosticSeverity {
  Error = 0,
  Warning = 1,
  Information = 2,
  Hint = 3,
}

export class Diagnostic {
  source?: string;
  code?: string;
  constructor(
    public range: Range,
    public message: string,
    public severity = DiagnosticSeverity.Error,
  ) {}
}

export enum ConfigurationTarget {
  Global = 1,
  Workspace = 2,
  WorkspaceFolder = 3,
}

export enum ViewColumn {
  Active = -1,
  Beside = -2,
  One = 1,
  Two = 2,
}

export class ThemeIcon {
  constructor(public id: string) {}
}

const noop = () => undefined;
const noopEvent = () => ({ dispose: noop });

export const window = {
  showInformationMessage: async () => undefined,
  showWarningMessage: async () => undefined,
  showErrorMessage: async () => undefined,
  showInputBox: async () => undefined,
  showQuickPick: async () => undefined,
  createOutputChannel: () => ({ appendLine: noop, append: noop, info: noop, warn: noop, error: noop, debug: noop, trace: noop, show: noop, dispose: noop }),
  createTerminal: () => ({ show: noop, dispose: noop }),
  onDidCloseTerminal: noopEvent,
};

export const workspace = {
  workspaceFolders: undefined as { uri: Uri; name: string; index: number }[] | undefined,
  isTrusted: true,
  getConfiguration: () => ({ get: (_key: string, fallback?: unknown) => fallback, update: async () => undefined, inspect: () => undefined }),
  onDidChangeConfiguration: noopEvent,
  onDidGrantWorkspaceTrust: noopEvent,
  applyEdit: async () => true,
  findFiles: async () => [],
  fs: {
    readFile: async () => new Uint8Array(),
    writeFile: async () => undefined,
    stat: async () => ({ type: 1, size: 0, ctime: 0, mtime: 0 }),
    delete: async () => undefined,
    createDirectory: async () => undefined,
  },
};

export const commands = {
  registerCommand: () => ({ dispose: noop }),
  executeCommand: async () => undefined,
};

export const lm = {
  selectChatModels: async () => [],
  onDidChangeChatModels: noopEvent,
};

export const env = {
  clipboard: { writeText: async () => undefined },
};
