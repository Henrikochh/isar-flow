import * as vscode from 'vscode';
import {
  type AgentDocumentState,
  type AgentEditorToHost,
  type AgentScope,
  applyAgentUpdate,
  type HostToAgentEditor,
} from '@isar-flow/core';
import type { Services } from '../contracts';
import { contextTokensSetting } from '../models/settings';
import { IGNORE_PATH_CASE } from '../store/paths';
import { buildAgentDocumentState, validationContext } from './documentState';
import { EditQueue } from './editQueue';
import { agentIdFromFileName, fileNameOf } from './files';
import { DOCUMENT_DEBOUNCE_MS, type EditorDocument, type EditorUi, WORKFLOW_EDITOR_VIEW_TYPE } from './host';
import { buildTryItRequest, TryItSession } from './tryIt';

const UNTRUSTED = 'Trust this workspace to try agents. Nothing runs in Restricted Mode.';
const UNTRUSTED_TEST = 'Trust this workspace to test models.';

const uriKey = (uri: vscode.Uri) => (IGNORE_PATH_CASE ? uri.toString().toLowerCase() : uri.toString());

/**
 * Host side of one agent editor: the form edits the agent file, Try it runs the agent as currently written.
 * Free of webview plumbing so it can be unit-tested; see agentEditor.ts for the wiring.
 */
export class AgentPanel implements vscode.Disposable {
  private readonly subscriptions: vscode.Disposable[];
  private readonly tryIt: TryItSession;
  private readonly edits: EditQueue;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(
    private readonly document: EditorDocument,
    private readonly services: Services,
    private readonly ui: EditorUi,
    private readonly send: (message: HostToAgentEditor) => void,
  ) {
    this.edits = new EditQueue(document);
    this.tryIt = new TryItSession(
      {
        resolver: services.models,
        tools: (runId) => services.tools(runId, this.toolRoot()),
        info: (text) => services.output.info(`Try it: ${text.trimEnd()}`),
        contextTokens: () =>
          contextTokensSetting(
            vscode.workspace.getConfiguration('isarFlow').get<unknown>('agentContextTokens'),
          ),
      },
      (event) => this.post({ type: 'tryItEvent', event }),
    );
    this.subscriptions = [
      services.workflows.onDidChange(() => this.sendDocument()),
      services.agents.onDidChange(() => this.sendDocument()),
      services.models.onDidChange(() => {
        this.post({ type: 'catalog', catalog: services.models.catalog() });
        this.sendDocument();
      }),
    ];
  }

  async handle(message: AgentEditorToHost): Promise<void> {
    switch (message.type) {
      case 'ready':
        this.sendDocument();
        this.post({ type: 'catalog', catalog: this.services.models.catalog() });
        return;
      case 'update':
        return this.update(message.set, message.unset ?? []);
      case 'tryIt':
        return this.startTry(message.prompt, message.history);
      case 'cancelTryIt':
        this.tryIt.cancel();
        return;
      case 'openYaml':
        return this.document.showYaml();
      case 'refreshModels':
        await this.services.models.refresh();
        return;
      case 'addProvider':
        await this.ui.executeCommand('isarFlow.addProvider');
        return;
      case 'openWorkflow':
        return this.openWorkflow(message.path);
      case 'testModel':
        return this.testModel(message.ref);
      default: {
        const unknown: never = message;
        throw new Error(`Unknown agent editor message ${JSON.stringify(unknown)}`);
      }
    }
  }

  /** Call on every change of the document text; the webview gets the new state after a short pause. */
  documentChanged(): void {
    if (this.disposed) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.sendDocument(), DOCUMENT_DEBOUNCE_MS);
  }

  state(): AgentDocumentState {
    const { workflows, models } = this.services;
    const { id, scope } = this.identity();
    return buildAgentDocumentState(
      this.document.getText(),
      this.document.uri.toString(),
      id,
      scope,
      fileNameOf(this.document.uri),
      workflows.usersOfAgent(id),
      { modelRefs: validationContext([], models.catalog()).modelRefs },
    );
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    this.tryIt.dispose();
    for (const subscription of this.subscriptions.splice(0)) subscription.dispose();
  }

  private identity(): { id: string; scope: AgentScope } {
    return (
      this.services.agents.identify(this.document.uri) ?? {
        id: agentIdFromFileName(fileNameOf(this.document.uri)),
        scope: 'workspace',
      }
    );
  }

  /** Try it gives the agent tools in the folder of the agent file; user agents get the first folder. */
  private toolRoot(): string | undefined {
    return (this.ui.workspaceFolderOf(this.document.uri) ?? this.ui.workspaceFolders()[0])?.fsPath;
  }

  /**
   * Opens a workflow of the "Used by" list. The path comes from the webview, so other paths are ignored.
   * Used-by paths are relative to their workspace folder: the agent's own folder is tried first, then the
   * others, and the first one whose workflow is indexed wins.
   */
  private async openWorkflow(relativePath: string): Promise<void> {
    if (!this.services.workflows.usersOfAgent(this.identity().id).includes(relativePath)) return;
    const own = this.ui.workspaceFolderOf(this.document.uri);
    const folders = this.ui.workspaceFolders();
    const ordered = own ? [own, ...folders.filter((f) => uriKey(f) !== uriKey(own))] : folders;
    const candidates = ordered.map((folder) => vscode.Uri.joinPath(folder, ...relativePath.split('/')));
    const indexed = new Set(this.services.workflows.list().map((w) => uriKey(vscode.Uri.parse(w.uri))));
    const target = candidates.find((uri) => indexed.has(uriKey(uri))) ?? candidates[0];
    if (target) await this.ui.executeCommand('vscode.openWith', target, WORKFLOW_EDITOR_VIEW_TYPE);
  }

  private post(message: HostToAgentEditor): void {
    if (!this.disposed) this.send(message);
  }

  private sendDocument(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.post({ type: 'document', doc: this.state() });
  }

  private async update(set: Record<string, unknown>, unset: string[]): Promise<void> {
    const outcome = await this.edits.apply((text) => applyAgentUpdate(text, set, unset));
    if (outcome.status === 'applied') this.sendDocument();
    else if (outcome.status === 'failed') this.post({ type: 'updateFailed', error: outcome.error });
  }

  /** "Test model": progress (catalog.probing) and the result (catalog.probes) reach the editor with the catalog. */
  private async testModel(ref: unknown): Promise<void> {
    if (!this.ui.isTrusted()) return this.ui.showError(UNTRUSTED_TEST);
    if (typeof ref !== 'string' || ref.trim() === '') return;
    await this.services.models.probe?.(ref.trim());
  }

  private startTry(prompt: string, history: { role: 'user' | 'assistant'; content: string }[]): void {
    const fail = (message: string) => this.post({ type: 'tryItEvent', event: { type: 'error', message } });
    if (!this.ui.isTrusted()) return fail(UNTRUSTED);
    const build = buildTryItRequest(this.state(), prompt, history);
    if (!build.ok) return fail(build.error);
    // Not awaited: the session reports progress and the end as events, and cancelTryIt must get through.
    void this.tryIt.start(build.request);
  }
}
