import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import type { HostToWorkflowEditor, RunEvent, RunView } from '@isar-flow/core';
import { PendingApprovals } from '../../../src/editors/approvals';
import { DOCUMENT_CHANGED, WRITE_FAILED } from '../../../src/editors/host';
import { WorkflowPanel } from '../../../src/editors/workflowPanel';
import { agentSummary, AsyncDocument, FakeDocument, fakeServices, fakeUi } from './fakes';

const TEXT = [
  '# Review workflow',
  'version: 1',
  'name: Review',
  'steps:',
  '  - id: implement',
  '    type: agent',
  '    agent: coder',
  '    prompt: Do it',
  '  - id: tests # the suite',
  '    type: console',
  '    run: npm test',
  '',
].join('\n');

const URI = 'file:///w/review.workflow.yaml';

const view = (runId: string, status: RunView['status'] = 'success'): RunView => ({
  runId,
  workflowName: 'Review',
  status,
  startedAt: 1,
  inputs: {},
  usage: { inputTokens: 0, outputTokens: 0 },
  steps: {},
});

const stepLog = (runId: string): RunEvent => ({
  type: 'step-log',
  runId,
  stepId: 'tests',
  stream: 'stdout',
  text: 'ok\n',
});

function setup(text = TEXT) {
  return setupWith(new FakeDocument(text));
}

function setupWith<D extends FakeDocument>(doc: D) {
  const fake = fakeServices();
  const { ui, api } = fakeUi();
  const approvals = new PendingApprovals(fake.services.runs);
  const posted: HostToWorkflowEditor[] = [];
  const panel = new WorkflowPanel(doc, fake.services, api, approvals, (m) => posted.push(m));
  const types = () => posted.map((m) => m.type);
  const last = <T extends HostToWorkflowEditor['type']>(type: T) =>
    posted.filter((m): m is Extract<HostToWorkflowEditor, { type: T }> => m.type === type).at(-1);
  return { ...fake, doc, ui, panel, posted, types, last, approvals };
}

describe('WorkflowPanel', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
  afterEach(() => vi.useRealTimers());

  it('attaches to the approval broker while it is visible', () => {
    const { services, panel, detach } = setup();
    const { attach } = services.runs.approvals;
    expect(attach).toHaveBeenCalledTimes(1);
    expect(attach).toHaveBeenCalledWith(URI);
    panel.setVisible(true);
    expect(attach).toHaveBeenCalledTimes(1);

    panel.setVisible(false);
    expect(detach).toHaveBeenCalledTimes(1);
    panel.setVisible(true);
    expect(attach).toHaveBeenCalledTimes(2);

    panel.dispose();
    expect(detach).toHaveBeenCalledTimes(2);
    panel.setVisible(true);
    expect(attach).toHaveBeenCalledTimes(2);
  });

  it('answers ready with document, catalog, trust and history', async () => {
    const { panel, posted, types, state } = setup();
    state.history = [
      { runId: 'old', workflowUri: URI, workflowName: 'Review', status: 'success', startedAt: 1 },
    ];
    await panel.handle({ type: 'ready' });
    expect(types()).toEqual(['document', 'catalog', 'trust', 'history']);
    const [document, catalog, trust, history] = posted;
    expect(document).toMatchObject({
      type: 'document',
      doc: { uri: URI, fileName: 'review.workflow.yaml', text: TEXT, valid: true, diagnostics: [] },
    });
    expect(catalog).toMatchObject({ type: 'catalog', agents: [agentSummary('coder')] });
    expect(trust).toEqual({ type: 'trust', trusted: true });
    expect(history).toEqual({ type: 'history', runs: state.history });
  });

  it('includes the live run and open approvals on ready', async () => {
    const { panel, posted, state, emitters } = setup();
    state.active = [{ runId: 'r1', workflowUri: URI, view: view('r1', 'running') }];
    emitters.approvalRequest.fire({
      requestId: 'q1',
      runId: 'r1',
      stepId: 'gate',
      message: 'OK?',
      workflowUri: URI,
    });
    posted.length = 0;
    await panel.handle({ type: 'ready' });
    expect(posted).toContainEqual({ type: 'run', run: view('r1', 'running'), live: true });
    expect(posted).toContainEqual({
      type: 'approvalRequest',
      prompt: { requestId: 'q1', runId: 'r1', stepId: 'gate', message: 'OK?' },
    });
  });

  it('debounces text changes', async () => {
    const { panel, posted, doc } = setup();
    await panel.handle({ type: 'ready' });
    posted.length = 0;
    doc.text = TEXT.replace('agent: coder', 'agent: ghost');
    panel.documentChanged();
    panel.documentChanged();
    expect(posted).toEqual([]);
    vi.advanceTimersByTime(150);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ type: 'document', doc: { valid: false } });
  });

  it('re-sends catalog and document when agents or models change', async () => {
    const { panel, posted, types, emitters, state } = setup(TEXT.replace('agent: coder', 'agent: reviewer'));
    await panel.handle({ type: 'ready' });
    expect(posted[0]).toMatchObject({ doc: { valid: false } });
    posted.length = 0;
    state.agents = [agentSummary('coder'), agentSummary('reviewer')];
    emitters.agents.fire();
    expect(types()).toEqual(['catalog', 'document']);
    expect(posted[1]).toMatchObject({ doc: { valid: true } });
    posted.length = 0;
    emitters.models.fire();
    expect(types()).toEqual(['catalog', 'document']);
  });

  it('applies canvas ops as one minimal edit and sends the new document right away', async () => {
    const { panel, doc, last } = setup();
    await panel.handle({ type: 'ready' });
    await panel.handle({
      type: 'ops',
      ops: [{ op: 'updateStep', stepId: 'tests', set: { run: 'npm run unit' } }],
    });
    expect(doc.edits).toHaveLength(1);
    expect([doc.edits[0].start.line, doc.edits[0].end.line]).toEqual([10, 10]);
    expect(doc.text).toContain('    run: npm run unit\n');
    expect(doc.text).toContain('- id: tests # the suite');
    expect(last('document')?.doc.text).toBe(doc.text);
  });

  it('reports failing ops without touching the document', async () => {
    const { panel, doc, last } = setup();
    await panel.handle({ type: 'ops', ops: [{ op: 'deleteStep', stepId: 'nope' }] });
    expect(last('opsFailed')?.error).toMatch(/nope/);
    expect(doc.edits).toEqual([]);
  });

  it('reports refused edits', async () => {
    const { panel, doc, last } = setup();
    doc.refuseEdits = true;
    await panel.handle({ type: 'ops', ops: [{ op: 'deleteStep', stepId: 'tests' }] });
    expect(last('opsFailed')?.error).toBe(WRITE_FAILED);
  });

  it('applies ops that arrive while an edit is still on its way, one after the other', async () => {
    const doc = new AsyncDocument(TEXT);
    const { panel, last } = setupWith(doc);
    // E.g. a field commits on blur and the click that caused the blur sends the next op.
    await Promise.all([
      panel.handle({
        type: 'ops',
        ops: [{ op: 'updateStep', stepId: 'tests', set: { run: 'npm run unit' } }],
      }),
      panel.handle({
        type: 'ops',
        ops: [{ op: 'updateStep', stepId: 'implement', set: { prompt: 'Do more' } }],
      }),
    ]);
    expect(last('opsFailed')).toBeUndefined();
    expect(doc.text).toContain('run: npm run unit');
    expect(doc.text).toContain('prompt: Do more');
  });

  it('applies the ops to the new text when the YAML changed while the edit was on its way', async () => {
    const doc = new AsyncDocument(TEXT);
    const { panel, last } = setupWith(doc);
    doc.beforeApply = () => {
      doc.beforeApply = undefined;
      doc.type(doc.text.replace('prompt: Do it', 'prompt: Typed in YAML'));
    };
    await panel.handle({
      type: 'ops',
      ops: [{ op: 'updateStep', stepId: 'tests', set: { run: 'npm run unit' } }],
    });
    expect(last('opsFailed')).toBeUndefined();
    expect(doc.text).toContain('prompt: Typed in YAML');
    expect(doc.text).toContain('run: npm run unit');
  });

  it('says that the file changed when it keeps changing during the edit', async () => {
    const doc = new AsyncDocument(TEXT);
    const { panel, last } = setupWith(doc);
    let n = 0;
    doc.beforeApply = () => doc.type(`${doc.text}# typing ${++n}\n`);
    await panel.handle({ type: 'ops', ops: [{ op: 'deleteStep', stepId: 'tests' }] });
    expect(last('opsFailed')?.error).toBe(DOCUMENT_CHANGED);
  });

  it('saves a dirty document before running it', async () => {
    const { panel, doc, services } = setup();
    doc.isDirty = true;
    await panel.handle({ type: 'run', inputs: { task: 'x' } });
    expect(doc.save).toHaveBeenCalled();
    expect(services.runs.start).toHaveBeenCalledWith(doc.uri, { task: 'x' });
  });

  it('does not run when saving fails', async () => {
    const { panel, doc, services, ui } = setup();
    doc.isDirty = true;
    doc.saveResult = false;
    await panel.handle({ type: 'run', inputs: {} });
    expect(services.runs.start).not.toHaveBeenCalled();
    expect(ui.errors).toEqual([
      'The workflow was not run because it could not be saved. Save the file, then run it again.',
    ]);
  });

  it('cancels the active run of this workflow', async () => {
    const { panel, services, state } = setup();
    state.active = [{ runId: 'r1', workflowUri: URI, view: view('r1', 'running') }];
    await panel.handle({ type: 'cancelRun' });
    expect(services.runs.active).toHaveBeenCalledWith(URI);
    expect(services.runs.cancel).toHaveBeenCalledWith('r1');
  });

  it('switches between history runs and the live run', async () => {
    const { panel, posted, state, emitters } = setup();
    state.views.old = view('old');
    state.active = [{ runId: 'r1', workflowUri: URI, view: view('r1', 'running') }];
    await panel.handle({ type: 'ready' });

    posted.length = 0;
    await panel.handle({ type: 'selectRun', runId: 'old' });
    expect(posted).toEqual([{ type: 'run', run: view('old'), live: false }]);

    // Live events are held back while a past run is shown.
    emitters.runEvents.fire({ workflowUri: URI, event: stepLog('r1') });
    expect(posted).toHaveLength(1);

    await panel.handle({ type: 'selectRun', runId: null });
    expect(posted.at(-1)).toEqual({ type: 'run', run: view('r1', 'running'), live: true });
    emitters.runEvents.fire({ workflowUri: URI, event: stepLog('r1') });
    expect(posted.at(-1)).toEqual({ type: 'runEvent', event: stepLog('r1') });

    await panel.handle({ type: 'selectRun', runId: 'r1' });
    expect(posted.at(-1)).toEqual({ type: 'run', run: view('r1', 'running'), live: true });

    await panel.handle({ type: 'selectRun', runId: 'missing' });
    expect(posted.at(-1)).toEqual({ type: 'run', run: null, live: false });
  });

  it('loads a past run that is no longer cached', async () => {
    const { panel, posted, state } = setup();
    state.stored.older = view('older');
    await panel.handle({ type: 'ready' });
    posted.length = 0;
    await panel.handle({ type: 'selectRun', runId: 'older' });
    expect(posted).toEqual([{ type: 'run', run: view('older'), live: false }]);
  });

  it('drops a slow history load when another run was selected meanwhile', async () => {
    const { panel, posted, state, services } = setup();
    state.views.old = view('old');
    let release: (value: RunView | undefined) => void = () => undefined;
    vi.mocked(services.runs.history.getAsync).mockImplementationOnce(
      () => new Promise<RunView | undefined>((resolve) => (release = resolve)),
    );
    await panel.handle({ type: 'ready' });
    posted.length = 0;
    const slow = panel.handle({ type: 'selectRun', runId: 'older' });
    await panel.handle({ type: 'selectRun', runId: 'old' });
    release(view('older'));
    await slow;
    expect(posted).toEqual([{ type: 'run', run: view('old'), live: false }]);
  });

  it('clears the canvas when no run is live', async () => {
    const { panel, last } = setup();
    await panel.handle({ type: 'selectRun', runId: null });
    expect(last('run')).toEqual({ type: 'run', run: null, live: false });
  });

  it('follows a new run even while a past run is shown', async () => {
    const { panel, posted, state, emitters } = setup();
    state.views.old = view('old');
    await panel.handle({ type: 'selectRun', runId: 'old' });
    const start: RunEvent = {
      type: 'run-start',
      runId: 'r2',
      workflowName: 'Review',
      startedAt: 5,
      inputs: {},
    };
    emitters.runEvents.fire({ workflowUri: URI, event: start });
    emitters.runEvents.fire({ workflowUri: URI, event: stepLog('r2') });
    emitters.runEvents.fire({ workflowUri: 'file:///w/other.workflow.yaml', event: stepLog('x') });
    expect(posted.slice(-2)).toEqual([
      { type: 'runEvent', event: start },
      { type: 'runEvent', event: stepLog('r2') },
    ]);
  });

  it('forwards history changes and approval events for this workflow only', () => {
    const { posted, emitters, state } = setup();
    state.history = [
      { runId: 'r1', workflowUri: URI, workflowName: 'Review', status: 'failure', startedAt: 1 },
    ];
    emitters.history.fire();
    emitters.approvalRequest.fire({
      requestId: 'q1',
      runId: 'r1',
      stepId: 'gate',
      message: 'OK?',
      workflowUri: URI,
    });
    emitters.approvalRequest.fire({
      requestId: 'q2',
      runId: 'r9',
      stepId: 'gate',
      message: 'OK?',
      workflowUri: 'file:///x',
    });
    emitters.approvalResolve.fire({ requestId: 'q1', workflowUri: URI });
    expect(posted).toEqual([
      { type: 'history', runs: state.history },
      { type: 'approvalRequest', prompt: { requestId: 'q1', runId: 'r1', stepId: 'gate', message: 'OK?' } },
      { type: 'approvalResolved', requestId: 'q1' },
    ]);
  });

  it('passes approval answers to the broker', async () => {
    const { panel, services, emitters } = setup();
    for (const requestId of ['q1', 'q2']) {
      emitters.approvalRequest.fire({
        requestId,
        runId: 'r1',
        stepId: 'gate',
        message: 'OK?',
        workflowUri: URI,
      });
    }
    await panel.handle({ type: 'approval', requestId: 'q1', approved: false, comment: 'Not yet' });
    await panel.handle({ type: 'approval', requestId: 'q2', approved: true });
    expect(services.runs.approvals.respond).toHaveBeenNthCalledWith(1, 'q1', {
      approved: false,
      comment: 'Not yet',
    });
    expect(services.runs.approvals.respond).toHaveBeenNthCalledWith(2, 'q2', { approved: true });
  });

  it('ignores answers to approvals this canvas does not show', async () => {
    const { panel, services, emitters } = setup();
    emitters.approvalRequest.fire({
      requestId: 'other',
      runId: 'r9',
      stepId: 'gate',
      message: 'OK?',
      workflowUri: 'file:///x',
    });
    emitters.approvalRequest.fire({
      requestId: 'done',
      runId: 'r1',
      stepId: 'gate',
      message: 'OK?',
      workflowUri: URI,
    });
    emitters.approvalResolve.fire({ requestId: 'done', workflowUri: URI });
    await panel.handle({ type: 'approval', requestId: 'other', approved: true });
    await panel.handle({ type: 'approval', requestId: 'done', approved: true });
    await panel.handle({ type: 'approval', requestId: 'unknown', approved: true });
    expect(services.runs.approvals.respond).not.toHaveBeenCalled();
  });

  it('only accepts true or false as an approval answer', async () => {
    const { panel, services, emitters } = setup();
    emitters.approvalRequest.fire({
      requestId: 'q1',
      runId: 'r1',
      stepId: 'gate',
      message: 'OK?',
      workflowUri: URI,
    });
    const forged = {
      type: 'approval',
      requestId: 'q1',
      approved: 'yes',
      comment: 42,
    } as unknown as Parameters<typeof panel.handle>[0];
    await panel.handle(forged);
    expect(services.runs.approvals.respond).not.toHaveBeenCalled();
    const sloppy = {
      type: 'approval',
      requestId: 'q1',
      approved: false,
      comment: 42,
    } as unknown as Parameters<typeof panel.handle>[0];
    await panel.handle(sloppy);
    expect(services.runs.approvals.respond).toHaveBeenCalledWith('q1', { approved: false });
  });

  it('opens the YAML beside the canvas at the block', async () => {
    const { panel, doc } = setup();
    await panel.handle({ type: 'openYaml', stepId: 'tests' });
    await panel.handle({ type: 'openYaml' });
    await panel.handle({ type: 'openYaml', stepId: 'nope' });
    expect(doc.shownRanges).toEqual([
      { start: { line: 8, character: 4 }, end: { line: 10, character: 17 } },
      undefined,
      undefined,
    ]);
  });

  it('opens existing agents in the agent editor', async () => {
    const { panel, ui } = setup();
    await panel.handle({ type: 'openAgent', agentId: 'coder' });
    expect(ui.commands).toHaveLength(1);
    const [command, uri, viewType] = ui.commands[0] as [string, vscode.Uri, string];
    expect(command).toBe('vscode.openWith');
    expect(uri.toString()).toBe('file:///w/.isarflow/agents/coder.agent.yaml');
    expect(viewType).toBe('isarFlow.agentEditor');
  });

  it('offers to create a missing agent with exactly that id, in the folder of the workflow', async () => {
    const { panel, ui, services } = setup();
    await panel.handle({ type: 'openAgent', agentId: 'MyReviewer' });
    expect(ui.confirmations).toEqual(["Agent 'MyReviewer' does not exist yet."]);
    expect(services.agents.create).not.toHaveBeenCalled();

    ui.confirmAnswer = true;
    await panel.handle({ type: 'openAgent', agentId: 'MyReviewer' });
    expect(services.agents.create).toHaveBeenCalledWith('MyReviewer', 'workspace', 'blank', {
      id: 'MyReviewer',
      folder: vscode.Uri.file('/w'),
    });
    const [command, uri, viewType] = ui.commands.at(-1) as [string, vscode.Uri, string];
    expect([command, uri.path, viewType]).toEqual([
      'vscode.openWith',
      '/w/.isarflow/agents/MyReviewer.agent.yaml',
      'isarFlow.agentEditor',
    ]);
  });

  it('runs the remaining commands', async () => {
    const { panel, ui, services } = setup();
    await panel.handle({ type: 'createAgent' });
    await panel.handle({ type: 'refreshModels' });
    await panel.handle({ type: 'copyToClipboard', text: 'npm test' });
    expect(ui.commands).toEqual([['isarFlow.newAgent']]);
    expect(services.models.refresh).toHaveBeenCalled();
    expect(ui.clipboard).toEqual(['npm test']);
  });

  it('shows a requested history run once the webview is ready', async () => {
    const { panel, posted, state } = setup();
    state.views.old = view('old');
    panel.showRun('old');
    expect(posted).toEqual([]);
    await panel.handle({ type: 'ready' });
    expect(posted.at(-1)).toEqual({ type: 'run', run: view('old'), live: false });
    panel.showRun('old');
    expect(posted.at(-1)).toEqual({ type: 'run', run: view('old'), live: false });
  });

  it('reports granted trust', () => {
    const { panel, posted } = setup();
    panel.trustGranted();
    expect(posted).toEqual([{ type: 'trust', trusted: true }]);
  });

  it('stops posting after dispose', async () => {
    const { panel, posted, emitters } = setup();
    await panel.handle({ type: 'ready' });
    panel.documentChanged();
    panel.dispose();
    posted.length = 0;
    vi.advanceTimersByTime(500);
    emitters.agents.fire();
    emitters.history.fire();
    expect(posted).toEqual([]);
  });
});
