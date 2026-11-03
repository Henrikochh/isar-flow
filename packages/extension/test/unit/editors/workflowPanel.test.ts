import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import {
  type HostToWorkflowEditor,
  liveContext,
  type RunEvent,
  type RunReview,
  type RunView,
  type SimulationState,
} from '@isar-flow/core';
import { PendingApprovals } from '../../../src/editors/approvals';
import { DOCUMENT_CHANGED, WRITE_FAILED } from '../../../src/editors/host';
import { WorkflowPanel } from '../../../src/editors/workflowPanel';
import {
  agentSummary,
  AsyncDocument,
  FakeDocument,
  fakeReviews,
  fakeServices,
  fakeSimulations,
  fakeUi,
} from './fakes';

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

function setupWith<D extends FakeDocument>(
  doc: D,
  prepare?: (fake: ReturnType<typeof fakeServices>) => void,
) {
  const fake = fakeServices();
  prepare?.(fake);
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

  it('answers ready with document, catalog, trust, history and the last run context', async () => {
    const { panel, posted, types, state } = setup();
    state.history = [
      { runId: 'old', workflowUri: URI, workflowName: 'Review', status: 'success', startedAt: 1 },
    ];
    await panel.handle({ type: 'ready' });
    await settle();
    expect(types()).toEqual(['document', 'catalog', 'trust', 'history', 'lastRunContext']);
    const [document, catalog, trust, history, lastRunContext] = posted;
    // The run is listed but can no longer be read.
    expect(lastRunContext).toEqual({ type: 'lastRunContext', context: null });
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

const REVIEW: RunReview = {
  runId: 'old',
  coverage: 'git',
  isolation: 'workspace',
  files: [
    {
      path: 'src/app.ts',
      status: 'modified',
      additions: 2,
      deletions: 1,
      stepIds: ['implement'],
      decision: 'pending',
      revertible: true,
    },
  ],
};

const record = (runId: string, workflowUri = URI) => ({
  runId,
  workflowUri,
  workflowName: 'Review',
  status: 'success' as const,
  startedAt: 1,
});

/** Lets pending promise callbacks run (setTimeout is faked in these tests). */
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

function setupWithReviews() {
  const reviews = fakeReviews();
  const t = setupWith(new FakeDocument(TEXT), (fake) =>
    Object.assign(fake.services.runs, { reviews: reviews.service }),
  );
  return { ...t, reviews };
}

describe('WorkflowPanel reviews', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
  afterEach(() => vi.useRealTimers());

  it('posts the review of the shown run after every run message', async () => {
    const t = setupWithReviews();
    t.state.views.old = view('old');
    t.state.history = [record('old')];
    t.reviews.reviews.old = REVIEW;
    await t.panel.handle({ type: 'selectRun', runId: 'old' });
    expect(t.posted).toEqual([
      { type: 'run', run: view('old'), live: false },
      { type: 'review', review: REVIEW },
    ]);

    t.posted.length = 0;
    await t.panel.handle({ type: 'selectRun', runId: null });
    expect(t.posted).toEqual([
      { type: 'run', run: null, live: false },
      { type: 'review', review: null },
    ]);
  });

  it('posts no review on ready without a shown run, and the review of a requested run', async () => {
    const t = setupWithReviews();
    await t.panel.handle({ type: 'ready' });
    await settle();
    expect(t.last('review')).toEqual({ type: 'review', review: null });

    t.state.views.old = view('old');
    t.state.history = [record('old')];
    t.reviews.reviews.old = REVIEW;
    t.panel.showRun('old');
    await settle();
    expect(t.posted.slice(-2)).toEqual([
      { type: 'run', run: view('old'), live: false },
      { type: 'review', review: REVIEW },
    ]);
  });

  it('does not show reviews of runs of other workflows', async () => {
    const t = setupWithReviews();
    t.state.views.other = view('other');
    t.state.history = [record('other', 'file:///w/other.workflow.yaml')];
    t.reviews.reviews.other = { ...REVIEW, runId: 'other' };
    await t.panel.handle({ type: 'selectRun', runId: 'other' });
    expect(t.last('review')).toEqual({ type: 'review', review: null });
  });

  it('follows changes of the review of the shown run, live runs included', async () => {
    const t = setupWithReviews();
    t.state.views.old = view('old');
    t.state.history = [record('old')];
    await t.panel.handle({ type: 'selectRun', runId: 'old' });
    t.posted.length = 0;

    t.reviews.reviews.old = REVIEW;
    t.reviews.emitter.fire({ runId: 'old', workflowUri: URI });
    t.reviews.emitter.fire({ runId: 'other', workflowUri: URI });
    t.reviews.emitter.fire({ runId: 'old', workflowUri: 'file:///w/other.workflow.yaml' });
    await settle();
    expect(t.posted).toEqual([{ type: 'review', review: REVIEW }]);

    // A new run takes over the canvas; its review arrives when the run has ended.
    const start: RunEvent = {
      type: 'run-start',
      runId: 'r2',
      workflowName: 'Review',
      startedAt: 5,
      inputs: {},
    };
    t.emitters.runEvents.fire({ workflowUri: URI, event: start });
    t.state.history = [record('r2'), record('old')];
    t.reviews.reviews.r2 = { ...REVIEW, runId: 'r2' };
    t.posted.length = 0;
    t.reviews.emitter.fire({ runId: 'old', workflowUri: URI });
    t.reviews.emitter.fire({ runId: 'r2', workflowUri: URI });
    await settle();
    expect(t.posted).toEqual([{ type: 'review', review: { ...REVIEW, runId: 'r2' } }]);
  });

  it('keeps or reverts files of its own runs, after checking the message', async () => {
    const t = setupWithReviews();
    t.state.history = [record('old'), record('other', 'file:///w/other.workflow.yaml')];
    const send = (message: unknown) => t.panel.handle(message as Parameters<typeof t.panel.handle>[0]);
    await send({ type: 'reviewFiles', runId: 'old', decision: 'kept', paths: ['src/app.ts'] });
    await send({ type: 'reviewFiles', runId: 'old', decision: 'reverted' });
    await send({ type: 'reviewFiles', runId: 'old', decision: 'deleted' });
    await send({ type: 'reviewFiles', runId: 'old', decision: 'kept', paths: 'src/app.ts' });
    await send({ type: 'reviewFiles', runId: 'old', decision: 'kept', paths: [42] });
    await send({ type: 'reviewFiles', runId: 7, decision: 'kept' });
    await send({ type: 'reviewFiles', runId: 'other', decision: 'kept' });
    expect(t.reviews.service.decide.mock.calls).toEqual([
      ['old', 'kept', ['src/app.ts']],
      ['old', 'reverted', undefined],
    ]);
  });

  it('opens review diffs of its own runs only', async () => {
    const t = setupWithReviews();
    t.state.history = [record('old'), record('other', 'file:///w/other.workflow.yaml')];
    t.state.active = [{ runId: 'live', workflowUri: URI, view: view('live', 'running') }];
    const send = (message: unknown) => t.panel.handle(message as Parameters<typeof t.panel.handle>[0]);
    await send({ type: 'openReviewDiff', runId: 'old', path: 'src/app.ts' });
    await send({ type: 'openReviewDiff', runId: 'live', path: 'a.txt' });
    await send({ type: 'openReviewDiff', runId: 'other', path: 'src/app.ts' });
    await send({ type: 'openReviewDiff', runId: 'old', path: 3 });
    expect(t.reviews.service.openDiff.mock.calls).toEqual([
      ['old', 'src/app.ts'],
      ['live', 'a.txt'],
    ]);
  });

  it('asks for trust before changing files and reports failures', async () => {
    const t = setup();
    const reviews = fakeReviews();
    Object.assign(t.services.runs, { reviews: reviews.service });
    t.state.history = [record('old')];
    t.ui.trusted = false;
    await t.panel.handle({ type: 'reviewFiles', runId: 'old', decision: 'reverted' });
    await t.panel.handle({ type: 'openReviewDiff', runId: 'old', path: 'a.txt' });
    expect(reviews.service.decide).not.toHaveBeenCalled();
    expect(reviews.service.openDiff).not.toHaveBeenCalled();
    expect(t.ui.errors).toEqual([
      'Trust this workspace to keep or revert changes.',
      'Trust this workspace to keep or revert changes.',
    ]);

    t.ui.trusted = true;
    reviews.service.decide.mockRejectedValueOnce(new Error('git is gone'));
    reviews.service.openDiff.mockRejectedValueOnce(new Error('no editor'));
    await t.panel.handle({ type: 'reviewFiles', runId: 'old', decision: 'reverted' });
    await t.panel.handle({ type: 'openReviewDiff', runId: 'old', path: 'a.txt' });
    expect(t.ui.errors.slice(2)).toEqual([
      'Could not revert the changes: git is gone',
      'Could not open the diff of a.txt: no editor',
    ]);
  });
});

/** Sends a message as the webview could, with any shape. */
const sendRaw = (panel: WorkflowPanel, message: unknown) =>
  panel.handle(message as Parameters<WorkflowPanel['handle']>[0]);

function setupWithSimulations(text = TEXT) {
  const simulations = fakeSimulations();
  const t = setupWith(new FakeDocument(text), (fake) =>
    Object.assign(fake.services.runs, { simulations: simulations.service }),
  );
  return { ...t, simulations };
}

const SIMULATION_URI = 'file:///w/.isarflow/simulations/review.sim.yaml';

describe('WorkflowPanel run from here and simulation', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
  afterEach(() => vi.useRealTimers());

  it('starts a run from a block of its own runs', async () => {
    const t = setup();
    t.state.history = [record('old')];
    t.state.active = [{ runId: 'live', workflowUri: URI, view: view('live', 'running') }];
    await t.panel.handle({ type: 'runFromHere', runId: 'old', stepId: 'tests', inputs: { task: 'x' } });
    await t.panel.handle({ type: 'runFromHere', runId: 'live', stepId: 'implement', inputs: {} });
    expect(t.services.runs.start.mock.calls).toEqual([
      [t.doc.uri, { task: 'x' }, { resume: { runId: 'old', stepId: 'tests' } }],
      [t.doc.uri, {}, { resume: { runId: 'live', stepId: 'implement' } }],
    ]);
  });

  it('ignores Run from here with wrong types or runs of other workflows', async () => {
    const t = setup();
    t.state.history = [record('old'), record('other', 'file:///w/other.workflow.yaml')];
    await sendRaw(t.panel, { type: 'runFromHere', runId: 7, stepId: 'tests', inputs: {} });
    await sendRaw(t.panel, { type: 'runFromHere', runId: 'old', stepId: null, inputs: {} });
    await sendRaw(t.panel, { type: 'runFromHere', runId: 'old', stepId: 'tests' });
    await sendRaw(t.panel, { type: 'runFromHere', runId: 'old', stepId: 'tests', inputs: null });
    await sendRaw(t.panel, { type: 'runFromHere', runId: 'old', stepId: 'tests', inputs: ['x'] });
    await sendRaw(t.panel, { type: 'runFromHere', runId: 'old', stepId: 'tests', inputs: 'x' });
    await sendRaw(t.panel, { type: 'runFromHere', runId: 'other', stepId: 'tests', inputs: {} });
    await sendRaw(t.panel, { type: 'runFromHere', runId: 'gone', stepId: 'tests', inputs: {} });
    expect(t.services.runs.start).not.toHaveBeenCalled();
    expect(t.doc.save).not.toHaveBeenCalled();
  });

  it('saves a dirty document before running from here, and stops when saving fails', async () => {
    const t = setup();
    t.state.history = [record('old')];
    t.doc.isDirty = true;
    await t.panel.handle({ type: 'runFromHere', runId: 'old', stepId: 'tests', inputs: {} });
    expect(t.doc.save).toHaveBeenCalledTimes(1);
    expect(t.services.runs.start).toHaveBeenCalledTimes(1);

    t.doc.isDirty = true;
    t.doc.saveResult = false;
    await t.panel.handle({ type: 'runFromHere', runId: 'old', stepId: 'tests', inputs: {} });
    expect(t.services.runs.start).toHaveBeenCalledTimes(1);
    expect(t.ui.errors).toEqual([
      'The workflow was not run because it could not be saved. Save the file, then run it again.',
    ]);
  });

  it('simulates the workflow with the given inputs', async () => {
    const t = setup();
    await t.panel.handle({ type: 'simulate', inputs: { task: 'x' } });
    await sendRaw(t.panel, { type: 'simulate', inputs: ['x'] });
    await sendRaw(t.panel, { type: 'simulate' });
    expect(t.services.runs.start.mock.calls).toEqual([[t.doc.uri, { task: 'x' }, { simulate: true }]]);
  });

  it('simulates unsaved edits without saving the file (a simulation changes no files)', async () => {
    const t = setup();
    t.doc.isDirty = true;
    t.doc.saveResult = false;
    await t.panel.handle({ type: 'simulate', inputs: {} });
    expect(t.doc.save).not.toHaveBeenCalled();
    expect(t.services.runs.start.mock.calls).toEqual([[t.doc.uri, {}, { simulate: true }]]);
    expect(t.ui.errors).toEqual([]);
  });

  it('saves the mocks of a block with only the known fields', async () => {
    const t = setupWithSimulations();
    await sendRaw(t.panel, {
      type: 'setSimulationMocks',
      stepId: 'tests',
      results: [
        { exitCode: 1, output: '1 failed', extra: true },
        { exitCode: 1.5, text: 3, json: { issues: ['x', null], score: 2 }, approved: 'yes', comment: 'c' },
        'not a result',
        null,
        [1],
        { approved: true, error: 'boom', output: 7 },
        { error: '', json: null },
        { json: { when: new Date(0) } },
        { json: Number.NaN, text: 'answer' },
        {},
      ],
    });
    await t.panel.handle({ type: 'setSimulationMocks', stepId: 'implement', results: null });
    await t.panel.handle({ type: 'setSimulationMocks', stepId: 'implement', results: [] });
    expect(t.simulations.service.setBlock.mock.calls).toEqual([
      [
        t.doc.uri,
        'tests',
        [
          { exitCode: 1, output: '1 failed' },
          { json: { issues: ['x', null], score: 2 }, comment: 'c' },
          { approved: true, error: 'boom' },
          { json: null },
          {},
          { text: 'answer' },
          {},
        ],
      ],
      [t.doc.uri, 'implement', null],
      [t.doc.uri, 'implement', []],
    ]);
  });

  it('ignores mocks for invalid block ids or without a list', async () => {
    const t = setupWithSimulations();
    await sendRaw(t.panel, { type: 'setSimulationMocks', stepId: '1tests', results: [] });
    await sendRaw(t.panel, { type: 'setSimulationMocks', stepId: 'te sts', results: [] });
    await sendRaw(t.panel, { type: 'setSimulationMocks', stepId: 7, results: [] });
    await sendRaw(t.panel, { type: 'setSimulationMocks', stepId: 'tests', results: { exitCode: 0 } });
    await sendRaw(t.panel, { type: 'setSimulationMocks', stepId: 'tests' });
    expect(t.simulations.service.setBlock).not.toHaveBeenCalled();
  });

  it('reports mocks that could not be saved', async () => {
    const t = setupWithSimulations();
    t.simulations.service.setBlock.mockRejectedValueOnce(
      new Error("The simulation file can't be read: bad indentation. Fix it in the file first."),
    );
    await t.panel.handle({ type: 'setSimulationMocks', stepId: 'tests', results: [{ exitCode: 1 }] });
    expect(t.ui.errors).toEqual([
      "Could not save the simulation mocks: The simulation file can't be read: bad indentation. Fix it in the file first.",
    ]);
  });

  it('opens the simulation file and reports failures', async () => {
    const t = setupWithSimulations();
    await t.panel.handle({ type: 'openSimulationFile' });
    expect(t.simulations.service.open).toHaveBeenCalledWith(t.doc.uri);
    t.simulations.service.open.mockRejectedValueOnce(new Error('No permission'));
    await t.panel.handle({ type: 'openSimulationFile' });
    expect(t.ui.errors).toEqual(['Could not open the simulation file: No permission']);
  });

  it('does nothing with simulation messages when there is no simulation store', async () => {
    const t = setup();
    await t.panel.handle({ type: 'setSimulationMocks', stepId: 'tests', results: null });
    await t.panel.handle({ type: 'openSimulationFile' });
    await t.panel.handle({ type: 'ready' });
    await settle();
    expect(t.ui.errors).toEqual([]);
    expect(t.types()).not.toContain('simulation');
  });

  it('sends the simulation file after ready and after every document change', async () => {
    const t = setupWithSimulations();
    t.emitters.agents.fire();
    await settle();
    expect(t.simulations.service.state).not.toHaveBeenCalled();

    await t.panel.handle({ type: 'ready' });
    await settle();
    expect(t.last('simulation')).toEqual({ type: 'simulation', simulation: t.simulations.data.simulation });
    const [uri, workflow] = t.simulations.service.state.mock.calls[0];
    expect(uri).toBe(t.doc.uri);
    expect(workflow?.steps.map((step) => step.id)).toEqual(['implement', 'tests']);

    const changed: SimulationState = { ...t.simulations.data.simulation, exists: true };
    t.simulations.data.simulation = changed;
    t.doc.text = TEXT.replace('id: tests', 'id: unit');
    t.panel.documentChanged();
    vi.advanceTimersByTime(150);
    await settle();
    expect(t.last('simulation')).toEqual({ type: 'simulation', simulation: changed });
    expect(t.simulations.service.state.mock.calls[1][1]?.steps.map((step) => step.id)).toEqual([
      'implement',
      'unit',
    ]);
  });

  it('posts only the newest of overlapping simulation reads', async () => {
    const t = setupWithSimulations();
    await t.panel.handle({ type: 'ready' });
    await settle();
    t.posted.length = 0;
    const older: SimulationState = { ...t.simulations.data.simulation, path: 'older' };
    const newer: SimulationState = { ...t.simulations.data.simulation, path: 'newer' };
    let release: (state: SimulationState) => void = () => undefined;
    t.simulations.service.state.mockImplementationOnce(
      () => new Promise<SimulationState>((resolve) => (release = resolve)),
    );
    t.simulations.service.state.mockImplementationOnce(async () => newer);
    t.simulations.emitter.fire({ uri: SIMULATION_URI });
    t.doc.text = `${TEXT}# changed\n`;
    t.panel.documentChanged();
    vi.advanceTimersByTime(150);
    await settle();
    release(older);
    await settle();
    expect(t.posted.filter((m) => m.type === 'simulation')).toEqual([
      { type: 'simulation', simulation: newer },
    ]);
  });

  it('re-sends the simulation file when the store reports a change of its file', async () => {
    const t = setupWithSimulations();
    t.simulations.emitter.fire({ uri: SIMULATION_URI });
    await settle();
    expect(t.simulations.service.state).not.toHaveBeenCalled();

    await t.panel.handle({ type: 'ready' });
    await settle();
    const count = () => t.posted.filter((m) => m.type === 'simulation').length;
    expect(count()).toBe(1);
    t.simulations.emitter.fire({ uri: SIMULATION_URI });
    await settle();
    expect(count()).toBe(2);
    // The .sim.yml variant of the same file counts too.
    t.simulations.emitter.fire({ uri: SIMULATION_URI.replace(/yaml$/, 'yml') });
    await settle();
    expect(count()).toBe(3);
    t.simulations.emitter.fire({ uri: 'file:///w/.isarflow/simulations/other.sim.yaml' });
    t.simulations.emitter.fire({ uri: 'file:///w/.isarflow/simulations/review-2.sim.yaml' });
    await settle();
    expect(count()).toBe(3);

    t.panel.dispose();
    t.simulations.emitter.fire({ uri: SIMULATION_URI });
    await settle();
    expect(count()).toBe(3);
  });

  it('moves the mocks of renamed blocks', async () => {
    const t = setupWithSimulations();
    await t.panel.handle({
      type: 'ops',
      ops: [
        { op: 'renameStep', stepId: 'tests', newId: 'unit' },
        { op: 'renameStep', stepId: 'implement', newId: 'implement' },
        { op: 'updateStep', stepId: 'unit', set: { run: 'npm run unit' } },
        { op: 'renameStep', stepId: 'unit', newId: 'unit_tests' },
      ],
    });
    expect(t.doc.text).toContain('id: unit_tests');
    expect(t.simulations.service.renameBlock.mock.calls).toEqual([
      [t.doc.uri, 'tests', 'unit'],
      [t.doc.uri, 'unit', 'unit_tests'],
    ]);
  });

  it('moves no mocks when the ops fail, and logs failed moves', async () => {
    const t = setupWithSimulations();
    await t.panel.handle({ type: 'ops', ops: [{ op: 'renameStep', stepId: 'nope', newId: 'x' }] });
    expect(t.simulations.service.renameBlock).not.toHaveBeenCalled();

    t.simulations.service.renameBlock.mockRejectedValueOnce(new Error('read-only'));
    await t.panel.handle({ type: 'ops', ops: [{ op: 'renameStep', stepId: 'tests', newId: 'unit' }] });
    await settle();
    expect(t.services.output.warn).toHaveBeenCalledWith(
      'Could not move the simulation mocks of tests to unit: read-only',
    );
    expect(t.ui.errors).toEqual([]);
  });
});

describe('WorkflowPanel last run context', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
  afterEach(() => vi.useRealTimers());

  const contexts = (t: ReturnType<typeof setup>) =>
    t.posted.flatMap((m) => (m.type === 'lastRunContext' ? [m.context] : []));

  it('sends null after ready when the workflow has no runs', async () => {
    const t = setup();
    await t.panel.handle({ type: 'ready' });
    expect(contexts(t)).toEqual([null]);
  });

  it('sends the context of the newest run once per new newest run', async () => {
    const t = setup();
    t.state.history = [record('r1'), record('r0')];
    t.state.views.r1 = { ...view('r1', 'failure'), inputs: { task: 'x' } };
    // Not sent before the webview is ready.
    t.emitters.history.fire();
    await settle();
    expect(contexts(t)).toEqual([]);

    await t.panel.handle({ type: 'ready' });
    await settle();
    expect(contexts(t)).toEqual([liveContext(t.state.views.r1)]);

    // Review counts and other changes that keep the newest run send nothing.
    t.state.history = [
      { ...record('r1'), review: { total: 1, kept: 1, reverted: 0, pending: 0 } },
      record('r0'),
    ];
    t.emitters.history.fire();
    t.emitters.history.fire();
    await settle();
    expect(contexts(t)).toHaveLength(1);

    // A newer run that is only stored, not cached.
    t.state.stored.r2 = view('r2');
    t.state.history = [record('r2'), ...t.state.history];
    t.emitters.history.fire();
    await settle();
    expect(contexts(t)).toEqual([liveContext(t.state.views.r1), liveContext(view('r2'))]);

    // The same run with another status.
    t.state.history = [{ ...record('r2'), status: 'cancelled' }, ...t.state.history.slice(1)];
    t.state.stored.r2 = view('r2', 'cancelled');
    t.emitters.history.fire();
    await settle();
    expect(contexts(t).at(-1)).toEqual(liveContext(view('r2', 'cancelled')));

    t.state.history = [];
    t.emitters.history.fire();
    await settle();
    expect(contexts(t)).toHaveLength(4);
    expect(contexts(t).at(-1)).toBeNull();
  });

  it('posts only the newest of overlapping run reads', async () => {
    const t = setup();
    await t.panel.handle({ type: 'ready' });
    let release: (value: RunView | undefined) => void = () => undefined;
    vi.mocked(t.services.runs.history.getAsync).mockImplementationOnce(
      () => new Promise<RunView | undefined>((resolve) => (release = resolve)),
    );
    t.state.history = [record('slow')];
    t.emitters.history.fire();
    t.state.views.fast = view('fast');
    t.state.history = [record('fast'), record('slow')];
    t.emitters.history.fire();
    release(view('slow'));
    await settle();
    expect(contexts(t)).toEqual([null, liveContext(view('fast'))]);
  });

  it('sends null when the newest run can no longer be read', async () => {
    const t = setup();
    t.state.history = [record('broken')];
    vi.mocked(t.services.runs.history.getAsync).mockRejectedValueOnce(new Error('corrupt'));
    await t.panel.handle({ type: 'ready' });
    await settle();
    expect(contexts(t)).toEqual([null]);
  });
});
