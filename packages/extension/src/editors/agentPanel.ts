import type * as vscode from 'vscode';
import {
  type AgentDocumentState,
  type AgentEditorToHost,
  applyAgentUpdate,
  type HostToAgentEditor,
} from '@isar-flow/core';
import type { Services } from '../contracts';
import { buildAgentDocumentState, validationContext } from './documentState';
import { EditQueue } from './editQueue';
import { agentIdFromFileName, fileNameOf } from './files';
import { DOCUMENT_DEBOUNCE_MS, type EditorDocument, type EditorUi } from './host';
import { buildTryItRequest, TryItSession } from './tryIt';

const UNTRUSTED = 'Trust this workspace to try agents. Nothing runs in Restricted Mode.';

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
        tools: services.tools,
        info: (text) => services.output.info(`Try it: ${text.trimEnd()}`),
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
    const { agents, workflows, models } = this.services;
    const fileName = fileNameOf(this.document.uri);
    const { id, scope } = agents.identify(this.document.uri) ?? {
      id: agentIdFromFileName(fileName),
      scope: 'workspace',
    };
    return buildAgentDocumentState(
      this.document.getText(),
      this.document.uri.toString(),
      id,
      scope,
      fileName,
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

  private startTry(prompt: string, history: { role: 'user' | 'assistant'; content: string }[]): void {
    const fail = (message: string) => this.post({ type: 'tryItEvent', event: { type: 'error', message } });
    if (!this.ui.isTrusted()) return fail(UNTRUSTED);
    const build = buildTryItRequest(this.state(), prompt, history);
    if (!build.ok) return fail(build.error);
    // Not awaited: the session reports progress and the end as events, and cancelTryIt must get through.
    void this.tryIt.start(build.request);
  }
}
