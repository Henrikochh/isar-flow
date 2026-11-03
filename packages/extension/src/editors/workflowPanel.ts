import * as vscode from 'vscode';
import {
  applyWorkflowOps,
  type HostToWorkflowEditor,
  parseWorkflowText,
  type RunEvent,
  type WorkflowDocumentState,
  type WorkflowEditorToHost,
  type WorkflowOp,
} from '@isar-flow/core';
import type { ActiveRun, Services } from '../contracts';
import type { PendingApprovals } from './approvals';
import { buildWorkflowDocumentState, validationContext } from './documentState';
import { EditQueue } from './editQueue';
import { fileNameOf } from './files';
import { AGENT_EDITOR_VIEW_TYPE, DOCUMENT_DEBOUNCE_MS, type EditorDocument, type EditorUi } from './host';

const UNTRUSTED_REVIEW = 'Trust this workspace to keep or revert changes.';
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Host side of one workflow canvas: answers webview messages and keeps the webview in sync with the document,
 * the stores and runs. Free of webview plumbing so it can be unit-tested; see workflowEditor.ts for the wiring.
 */
export class WorkflowPanel implements vscode.Disposable {
  private readonly uri: string;
  private readonly subscriptions: vscode.Disposable[];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private ready = false;
  private disposed = false;
  /** Past run shown on the canvas; undefined while the canvas follows the live run. */
  private historyRunId: string | undefined;
  /** Past run to show once the webview is ready. */
  private requestedRunId: string | undefined;
  /** Run on the canvas (live or past), whose review the canvas shows. */
  private shownRunId: string | undefined;
  /** Registration with the approval broker; held while the panel is visible. */
  private attachment: vscode.Disposable | undefined;
  private readonly edits: EditQueue;

  constructor(
    private readonly document: EditorDocument,
    private readonly services: Services,
    private readonly ui: EditorUi,
    private readonly approvals: PendingApprovals,
    private readonly send: (message: HostToWorkflowEditor) => void,
  ) {
    this.uri = document.uri.toString();
    this.edits = new EditQueue(document);
    const { agents, models, runs } = services;
    const forThisWorkflow = (workflowUri: string) => workflowUri === this.uri;
    this.setVisible(true);
    this.subscriptions = [
      agents.onDidChange(() => this.sendCatalog()),
      models.onDidChange(() => this.sendCatalog()),
      runs.onEvent(({ workflowUri, event }) => {
        if (forThisWorkflow(workflowUri)) this.onRunEvent(event);
      }),
      runs.history.onDidChange(() => this.sendHistory()),
      runs.approvals.onDidRequest(({ workflowUri, ...prompt }) => {
        if (forThisWorkflow(workflowUri)) this.post({ type: 'approvalRequest', prompt });
      }),
      runs.approvals.onDidResolve(({ workflowUri, requestId }) => {
        if (forThisWorkflow(workflowUri)) this.post({ type: 'approvalResolved', requestId });
      }),
    ];
    if (runs.reviews) {
      this.subscriptions.push(
        runs.reviews.onDidChange(({ workflowUri, runId }) => {
          if (forThisWorkflow(workflowUri) && runId === this.shownRunId) void this.sendReview();
        }),
      );
    }
  }

  async handle(message: WorkflowEditorToHost): Promise<void> {
    const { runs } = this.services;
    switch (message.type) {
      case 'ready':
        return this.sendAll();
      case 'ops':
        return this.applyOps(message.ops);
      case 'run':
        return this.run(message.inputs);
      case 'cancelRun':
        for (const run of runs.active(this.uri)) runs.cancel(run.runId);
        return;
      case 'selectRun':
        return this.selectRun(message.runId);
      case 'approval':
        return this.answerApproval(message.requestId, message.approved, message.comment);
      case 'openYaml':
        return this.openYaml(message.stepId);
      case 'openAgent':
        return this.openAgent(message.agentId);
      case 'createAgent':
        await this.ui.executeCommand('isarFlow.newAgent');
        return;
      case 'refreshModels':
        await this.services.models.refresh();
        return;
      case 'copyToClipboard':
        return this.ui.writeClipboard(message.text);
      case 'reviewFiles':
        return this.reviewFiles(message.runId, message.decision, message.paths);
      case 'openReviewDiff':
        return this.openReviewDiff(message.runId, message.path);
      default: {
        const unknown: never = message;
        throw new Error(`Unknown workflow editor message ${JSON.stringify(unknown)}`);
      }
    }
  }

  /** Call on every change of the document text; the webview gets the new state after a short pause. */
  documentChanged(): void {
    if (this.disposed) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.sendDocument(), DOCUMENT_DEBOUNCE_MS);
  }

  trustGranted(): void {
    this.post({ type: 'trust', trusted: true });
  }

  /**
   * Approvals are answered inline only while the canvas is visible; for a hidden canvas the broker asks with a
   * dialog instead, so a run never waits on a prompt nobody sees.
   */
  setVisible(visible: boolean): void {
    if (visible && !this.attachment && !this.disposed) {
      this.attachment = this.services.runs.approvals.attach(this.uri);
    } else if (!visible && this.attachment) {
      this.attachment.dispose();
      this.attachment = undefined;
    }
  }

  /** Shows a past run on the canvas, now or as soon as the webview is ready. */
  showRun(runId: string): void {
    if (this.ready) void this.selectRun(runId);
    else this.requestedRunId = runId;
  }

  state(): WorkflowDocumentState {
    const { agents, models } = this.services;
    return buildWorkflowDocumentState(
      this.document.getText(),
      this.uri,
      fileNameOf(this.document.uri),
      validationContext(agents.list(), models.catalog()),
    );
  }

  dispose(): void {
    this.setVisible(false);
    this.disposed = true;
    this.ready = false;
    clearTimeout(this.timer);
    for (const subscription of this.subscriptions.splice(0)) subscription.dispose();
  }

  private post(message: HostToWorkflowEditor): void {
    if (!this.disposed) this.send(message);
  }

  private sendDocument(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.post({ type: 'document', doc: this.state() });
  }

  /** Diagnostics depend on the known agents and models, so the document is re-sent too. */
  private sendCatalog(): void {
    const { agents, models } = this.services;
    this.post({ type: 'catalog', agents: agents.list(), catalog: models.catalog() });
    this.sendDocument();
  }

  private sendHistory(): void {
    this.post({ type: 'history', runs: this.services.runs.history.list(this.uri) });
  }

  private liveRun(): ActiveRun | undefined {
    return this.services.runs.active(this.uri)[0];
  }

  private sendAll(): void {
    const { agents, models } = this.services;
    this.ready = true;
    this.sendDocument();
    this.post({ type: 'catalog', agents: agents.list(), catalog: models.catalog() });
    this.post({ type: 'trust', trusted: this.ui.isTrusted() });
    this.sendHistory();
    const requested = this.requestedRunId;
    this.requestedRunId = undefined;
    this.historyRunId = undefined;
    const live = this.liveRun();
    if (requested !== undefined) {
      void this.selectRun(requested);
    } else {
      this.shownRunId = live?.runId;
      if (live) this.post({ type: 'run', run: live.view, live: true });
      void this.sendReview();
    }
    for (const prompt of this.approvals.for(this.uri)) this.post({ type: 'approvalRequest', prompt });
  }

  private async selectRun(runId: string | null): Promise<void> {
    const live = this.liveRun();
    if (runId === null || runId === live?.runId) {
      this.historyRunId = undefined;
      this.shownRunId = live?.runId;
      this.post({ type: 'run', run: live?.view ?? null, live: live !== undefined });
      return this.sendReview();
    }
    this.historyRunId = runId;
    this.shownRunId = runId;
    const { history } = this.services.runs;
    const cached = history.get(runId);
    if (cached) {
      this.post({ type: 'run', run: cached, live: false });
      return this.sendReview();
    }
    const stored = await history.getAsync(runId).catch(() => undefined);
    // Another run may have been selected, or a new run started, while the saved run was read.
    if (this.historyRunId !== runId) return;
    this.post({ type: 'run', run: stored ?? null, live: false });
    return this.sendReview();
  }

  /** Whether a run (live or saved) belongs to this workflow; webview messages may only touch those. */
  private ownsRun(runId: string): boolean {
    const { runs } = this.services;
    return (
      runs.active(this.uri).some((run) => run.runId === runId) ||
      runs.history.list(this.uri).some((record) => record.runId === runId && record.workflowUri === this.uri)
    );
  }

  /** Posts the review of the run on the canvas (null when it has none). */
  private async sendReview(): Promise<void> {
    const { reviews } = this.services.runs;
    if (!reviews) return;
    const runId = this.shownRunId;
    const wanted = runId !== undefined && this.ui.isTrusted() && this.ownsRun(runId);
    const review = wanted ? await reviews.get(runId).catch(() => undefined) : undefined;
    // The canvas may have moved on to another run meanwhile.
    if (runId === this.shownRunId) this.post({ type: 'review', review: review ?? null });
  }

  private async reviewFiles(runId: unknown, decision: unknown, paths: unknown): Promise<void> {
    const { reviews } = this.services.runs;
    if (!reviews || typeof runId !== 'string' || (decision !== 'kept' && decision !== 'reverted')) return;
    if (paths !== undefined && !(Array.isArray(paths) && paths.every((p) => typeof p === 'string'))) return;
    if (!this.ownsRun(runId)) return;
    if (!this.ui.isTrusted()) return this.ui.showError(UNTRUSTED_REVIEW);
    try {
      await reviews.decide(runId, decision, paths as string[] | undefined);
    } catch (error) {
      this.ui.showError(
        `Could not ${decision === 'kept' ? 'keep' : 'revert'} the changes: ${errorText(error)}`,
      );
    }
  }

  private async openReviewDiff(runId: unknown, file: unknown): Promise<void> {
    const { reviews } = this.services.runs;
    if (!reviews || typeof runId !== 'string' || typeof file !== 'string' || !this.ownsRun(runId)) return;
    if (!this.ui.isTrusted()) return this.ui.showError(UNTRUSTED_REVIEW);
    try {
      await reviews.openDiff(runId, file);
    } catch (error) {
      this.ui.showError(`Could not open the diff of ${file}: ${errorText(error)}`);
    }
  }

  /** Live events go to the canvas unless it shows a past run; a new run always takes over the canvas. */
  private onRunEvent(event: RunEvent): void {
    if (event.type === 'run-start') {
      this.historyRunId = undefined;
      this.shownRunId = event.runId;
    }
    if (this.historyRunId === undefined) this.post({ type: 'runEvent', event });
  }

  /**
   * The answer comes from the webview, so it counts only for a prompt this canvas shows right now: not for
   * another workflow's prompt, nor for one that moved to a dialog when the canvas was hidden.
   */
  private answerApproval(requestId: unknown, approved: unknown, comment: unknown): void {
    if (typeof approved !== 'boolean') return;
    if (!this.approvals.for(this.uri).some((prompt) => prompt.requestId === requestId)) return;
    this.services.runs.approvals.respond(
      requestId as string,
      typeof comment === 'string' ? { approved, comment } : { approved },
    );
  }

  private async applyOps(ops: WorkflowOp[]): Promise<void> {
    const outcome = await this.edits.apply((text) => applyWorkflowOps(text, ops));
    if (outcome.status === 'applied') this.sendDocument();
    else if (outcome.status === 'failed') this.post({ type: 'opsFailed', error: outcome.error });
  }

  private async run(inputs: Record<string, unknown>): Promise<void> {
    if (this.document.isDirty && !(await this.document.save())) {
      this.ui.showError(
        'The workflow was not run because it could not be saved. Save the file, then run it again.',
      );
      return;
    }
    await this.services.runs.start(this.document.uri, inputs);
  }

  private async openYaml(stepId: string | undefined): Promise<void> {
    if (stepId === undefined) return this.document.showYaml();
    const { stepRanges } = parseWorkflowText(this.document.getText());
    return this.document.showYaml(Object.hasOwn(stepRanges, stepId) ? stepRanges[stepId] : undefined);
  }

  private async openAgent(agentId: string): Promise<void> {
    const record = this.services.agents.get(agentId);
    let uri: vscode.Uri;
    if (record) {
      uri = vscode.Uri.parse(record.summary.uri);
    } else {
      if (!(await this.ui.confirm(`Agent '${agentId}' does not exist yet.`, 'Create agent'))) return;
      // The file must carry exactly the id the workflow refers to, next to the workflow in multi-root setups.
      uri = await this.services.agents.create(agentId, 'workspace', 'blank', {
        id: agentId,
        folder: this.ui.workspaceFolderOf(this.document.uri),
      });
    }
    await this.ui.executeCommand('vscode.openWith', uri, AGENT_EDITOR_VIEW_TYPE);
  }
}
