import { vi } from 'vitest';
import * as vscode from 'vscode';
import type {
  AgentDefinition,
  AgentScope,
  AgentSummary,
  ApprovalPrompt,
  ChatModel,
  ModelCatalog,
  Range,
  RunEvent,
  RunRecordSummary,
  RunView,
  ToolHost,
  WorkflowSummary,
} from '@isar-flow/core';
import type { ActiveRun, AgentRecord, Services } from '../../../src/contracts';
import type { EditorDocument, EditorUi } from '../../../src/editors/host';
import { computeReplaceRange } from '../../../src/editors/textEdit';

export const CATALOG: ModelCatalog = {
  loading: false,
  providers: [],
  models: [
    {
      ref: 'vscode/copilot/gpt-4.1',
      provider: 'vscode',
      providerLabel: 'VS Code',
      id: 'copilot/gpt-4.1',
      name: 'GPT-4.1',
      capabilities: { tools: true, jsonSchema: false },
    },
  ],
};

export function agentSummary(id: string, scope: AgentScope = 'workspace'): AgentSummary {
  return {
    id,
    name: id,
    model: 'vscode/copilot/gpt-4.1',
    tools: [],
    scope,
    uri: `file:///w/.isarflow/agents/${id}.agent.yaml`,
    valid: true,
  };
}

/** Services backed by plain data and event emitters; tests mutate `state` and fire the emitters. */
export function fakeServices() {
  const emitters = {
    agents: new vscode.EventEmitter<void>(),
    workflows: new vscode.EventEmitter<void>(),
    models: new vscode.EventEmitter<void>(),
    runEvents: new vscode.EventEmitter<{ workflowUri: string; event: RunEvent }>(),
    runs: new vscode.EventEmitter<void>(),
    history: new vscode.EventEmitter<void>(),
    approvalRequest: new vscode.EventEmitter<ApprovalPrompt & { workflowUri: string }>(),
    approvalResolve: new vscode.EventEmitter<{ requestId: string; workflowUri: string }>(),
  };
  const state = {
    agents: [agentSummary('coder')] as AgentSummary[],
    definitions: {} as Record<string, AgentDefinition>,
    identity: undefined as { id: string; scope: AgentScope } | undefined,
    usersOfAgent: {} as Record<string, string[]>,
    workflows: [] as WorkflowSummary[],
    catalog: CATALOG,
    history: [] as RunRecordSummary[],
    views: {} as Record<string, RunView>,
    /** Saved runs that are not cached: only getAsync finds them. */
    stored: {} as Record<string, RunView>,
    active: [] as ActiveRun[],
    toolHost: { execute: async () => ({ content: '' }) } as ToolHost,
  };
  const detach = vi.fn();
  const services = {
    context: { extensionUri: vscode.Uri.file('/ext') } as unknown as vscode.ExtensionContext,
    agents: {
      onDidChange: emitters.agents.event,
      list: () => state.agents,
      definitions: () => state.definitions,
      get: (id: string): AgentRecord | undefined => {
        const summary = state.agents.find((a) => a.id === id);
        return summary ? { summary, definition: state.definitions[id] ?? null } : undefined;
      },
      identify: () => state.identity,
      create: vi.fn(async (name: string) => vscode.Uri.file(`/w/.isarflow/agents/${name}.agent.yaml`)),
      delete: vi.fn(async () => undefined),
      ensure: vi.fn(async () => undefined),
      dispose: vi.fn(),
    },
    workflows: {
      onDidChange: emitters.workflows.event,
      list: () => state.workflows,
      create: vi.fn(async () => vscode.Uri.file('/w/new.workflow.yaml')),
      usersOfAgent: (id: string) => state.usersOfAgent[id] ?? [],
      dispose: vi.fn(),
    },
    models: {
      onDidChange: emitters.models.event,
      catalog: () => state.catalog,
      refresh: vi.fn(async () => state.catalog),
      resolve: vi.fn(async (ref: string): Promise<ChatModel> => {
        throw new Error(`Model ${ref} is not available.`);
      }),
      dispose: vi.fn(),
    },
    runs: {
      onEvent: emitters.runEvents.event,
      onDidChangeRuns: emitters.runs.event,
      history: {
        onDidChange: emitters.history.event,
        list: vi.fn(() => state.history),
        get: (runId: string) => state.views[runId],
        getAsync: vi.fn(async (runId: string) => state.views[runId] ?? state.stored[runId]),
        save: vi.fn(async () => undefined),
      },
      approvals: {
        onDidRequest: emitters.approvalRequest.event,
        onDidResolve: emitters.approvalResolve.event,
        request: vi.fn(async () => ({ approved: true })),
        respond: vi.fn(),
        attach: vi.fn(() => ({ dispose: detach })),
      },
      start: vi.fn(async () => 'run-1'),
      cancel: vi.fn(),
      active: vi.fn(() => state.active),
      dispose: vi.fn(),
    },
    tools: vi.fn(() => state.toolHost),
    output: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
    } as unknown as vscode.LogOutputChannel,
  } satisfies Services;
  return { services, state, emitters, detach };
}

/** An in-memory document that applies edits like VS Code (line/character ranges on the current text). */
export class FakeDocument implements EditorDocument {
  isDirty = false;
  saveResult = true;
  refuseEdits = false;
  readonly edits: {
    start: { line: number; character: number };
    end: { line: number; character: number };
    text: string;
  }[] = [];
  readonly shownRanges: (Range | undefined)[] = [];
  readonly save = vi.fn(async () => {
    if (this.saveResult) this.isDirty = false;
    return this.saveResult;
  });

  constructor(
    public text: string,
    readonly uri: vscode.Uri = vscode.Uri.file('/w/review.workflow.yaml'),
  ) {}

  getText(): string {
    return this.text;
  }

  async replaceText(oldText: string, newText: string): Promise<boolean> {
    if (this.refuseEdits || oldText !== this.text) return false;
    const edit = computeReplaceRange(oldText, newText);
    this.edits.push(edit);
    this.text = newText;
    this.isDirty = true;
    return true;
  }

  async showYaml(range?: Range): Promise<void> {
    this.shownRanges.push(range);
  }
}

/**
 * Behaves like a VS Code document behind applyEdit: the edit reaches the text a little later, and VS Code
 * refuses an edit that was made for an older version of the document (here: when the text changed meanwhile).
 */
export class AsyncDocument extends FakeDocument {
  private version = 0;
  /** Called while an edit is on its way, e.g. to simulate the user typing in the YAML editor. */
  beforeApply: (() => void) | undefined;

  type(newText: string): void {
    this.text = newText;
    this.version++;
  }

  override async replaceText(oldText: string, newText: string): Promise<boolean> {
    if (this.refuseEdits || oldText !== this.text) return false;
    const version = this.version;
    await Promise.resolve();
    this.beforeApply?.();
    await Promise.resolve();
    if (version !== this.version) return false;
    this.version++;
    return super.replaceText(oldText, newText);
  }
}

export function fakeUi(overrides: Partial<EditorUi> = {}) {
  const ui = {
    trusted: true,
    confirmAnswer: false,
    commands: [] as unknown[][],
    clipboard: [] as string[],
    errors: [] as string[],
    confirmations: [] as string[],
    folders: [vscode.Uri.file('/w')],
  };
  const api: EditorUi = {
    isTrusted: () => ui.trusted,
    workspaceFolders: () => ui.folders,
    workspaceFolderOf: (uri) => ui.folders.find((folder) => uri.path.startsWith(`${folder.path}/`)),
    executeCommand: async (...args: unknown[]) => {
      ui.commands.push(args);
      return undefined;
    },
    writeClipboard: async (text) => void ui.clipboard.push(text),
    confirm: async (message) => {
      ui.confirmations.push(message);
      return ui.confirmAnswer;
    },
    showError: (message) => void ui.errors.push(message),
    ...overrides,
  };
  return { ui, api };
}

/** Lets pending promise callbacks run. */
export const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
