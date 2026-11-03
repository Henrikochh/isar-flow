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
    readonly authority = '',
  ) {}
  static file(fsPath: string): Uri {
    return new Uri('file', fsPath.replace(/\\/g, '/'));
  }
  static parse(value: string): Uri {
    const match = /^([a-z][\w+.-]*):(?:\/\/([^/]*))?(.*)$/i.exec(value);
    if (!match) return Uri.file(value);
    const [, scheme, authority = '', rest] = match;
    return new Uri(scheme, rest.startsWith('/') ? rest : `/${rest}`, authority);
  }
  static joinPath(base: Uri, ...segments: string[]): Uri {
    return new Uri(base.scheme, [base.path.replace(/\/$/, ''), ...segments].join('/'), base.authority);
  }
  get fsPath(): string {
    return this.authority ? `//${this.authority}${this.path}` : this.path;
  }
  with(change: { path?: string; scheme?: string; authority?: string }): Uri {
    return new Uri(
      change.scheme ?? this.scheme,
      change.path ?? this.path,
      change.authority ?? this.authority,
    );
  }
  toString(): string {
    return `${this.scheme}://${this.authority}${this.path}`;
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
  deleteFile(uri: Uri, _options?: unknown): void {
    this.edits.push({ kind: 'delete', uri });
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
  static NoPermissions(message = '') {
    return new LanguageModelError(message, 'NoPermissions');
  }
  static Blocked(message = '') {
    return new LanguageModelError(message, 'Blocked');
  }
  static NotFound(message = '') {
    return new LanguageModelError(message, 'NotFound');
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

export enum FileType {
  Unknown = 0,
  File = 1,
  Directory = 2,
  SymbolicLink = 64,
}

export class RelativePattern {
  constructor(
    public baseUri: Uri | string | { uri: Uri },
    public pattern: string,
  ) {}
}

const noop = () => undefined;
const noopEvent = () => ({ dispose: noop });

/* ---------- Package C additions (status bar, Copilot tools and chat, Markdown) ---------- */

export class MarkdownString {
  isTrusted?: boolean;
  constructor(
    public value = '',
    public supportThemeIcons = false,
  ) {}
  appendMarkdown(value: string): this {
    this.value += value;
    return this;
  }
  appendText(value: string): this {
    this.value += value.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
    return this;
  }
  appendCodeblock(code: string, language = ''): this {
    this.value += `\n\`\`\`${language}\n${code}\n\`\`\`\n`;
    return this;
  }
}

export class LanguageModelToolResult {
  constructor(public content: unknown[]) {}
}

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

export enum QuickPickItemKind {
  Separator = -1,
  Default = 0,
}

export const chat = {
  createChatParticipant: (id: string, requestHandler: unknown) => ({
    id,
    requestHandler,
    iconPath: undefined as unknown,
    followupProvider: undefined as unknown,
    onDidReceiveFeedback: noopEvent,
    dispose: noop,
  }),
};

export enum ProgressLocation {
  SourceControl = 1,
  Window = 10,
  Notification = 15,
}

export const window = {
  showInformationMessage: async () => undefined,
  showWarningMessage: async () => undefined,
  showErrorMessage: async () => undefined,
  showInputBox: async () => undefined,
  showQuickPick: async () => undefined,
  createOutputChannel: () => ({
    appendLine: noop,
    append: noop,
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    trace: noop,
    show: noop,
    dispose: noop,
  }),
  createTerminal: () => ({ show: noop, dispose: noop }),
  onDidCloseTerminal: noopEvent,
  registerWebviewViewProvider: () => ({ dispose: noop }),
  withProgress: async <R>(
    _options: unknown,
    task: (
      progress: { report: (value: unknown) => void },
      token: CancellationTokenSource['token'],
    ) => Promise<R>,
  ): Promise<R> => task({ report: noop }, new CancellationTokenSource().token),
  showTextDocument: async () => undefined,
  showSaveDialog: async () => undefined,
  setStatusBarMessage: (_text: string, _hideAfterTimeout?: number) => ({ dispose: noop }),
  activeTextEditor: undefined as unknown,
  visibleTextEditors: [] as unknown[],
  onDidChangeActiveTextEditor: noopEvent,
  onDidChangeVisibleTextEditors: noopEvent,
  onDidChangeTextEditorSelection: noopEvent,
  createStatusBarItem: () => ({
    text: '',
    tooltip: undefined as unknown,
    command: undefined as unknown,
    name: undefined as string | undefined,
    show: noop,
    hide: noop,
    dispose: noop,
  }),
};

export const workspace = {
  workspaceFolders: undefined as { uri: Uri; name: string; index: number }[] | undefined,
  isTrusted: true,
  getConfiguration: () => ({
    get: (_key: string, fallback?: unknown) => fallback,
    update: async () => undefined,
    inspect: () => undefined,
  }),
  onDidChangeConfiguration: noopEvent,
  onDidGrantWorkspaceTrust: noopEvent,
  applyEdit: async () => true,
  findFiles: async () => [],
  onDidChangeWorkspaceFolders: noopEvent,
  onDidSaveTextDocument: noopEvent,
  onDidChangeTextDocument: noopEvent,
  textDocuments: [] as unknown[],
  openTextDocument: async (_uri: Uri) => undefined as unknown,
  asRelativePath: (pathOrUri: string | Uri) => (typeof pathOrUri === 'string' ? pathOrUri : pathOrUri.path),
  registerTextDocumentContentProvider: (_scheme: string, _provider: unknown) => ({ dispose: noop }),
  getWorkspaceFolder: (_uri: Uri) => undefined as { uri: Uri; name: string; index: number } | undefined,
  createFileSystemWatcher: () => ({
    onDidCreate: noopEvent,
    onDidChange: noopEvent,
    onDidDelete: noopEvent,
    dispose: noop,
  }),
  fs: {
    readDirectory: async (): Promise<[string, number][]> => [],
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
  registerTool: (_name: string, _tool: unknown) => ({ dispose: noop }),
  tools: [] as unknown[],
  invokeTool: async () => new LanguageModelToolResult([]),
};

export const env = {
  clipboard: { writeText: async () => undefined },
};
