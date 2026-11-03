import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseAgentText,
  type HostToAgentEditor,
  type HostToSidebar,
  type HostToWorkflowEditor,
  type ModelCatalog,
  type RunReview,
  type SidebarState,
} from '@isar-flow/core';
import { READ_ONLY_PATH, SETUP_REPORT, SETUP_REPORT_RUNNING, WORKFLOWS } from '../../harness/fixtures';
import {
  agentHost,
  probe,
  sidebarHost,
  workflowHost,
  type WorkflowHostOptions,
} from '../../harness/mockHost';

afterEach(() => vi.useRealTimers());

async function openEditor(scenario: string, options?: WorkflowHostOptions) {
  const sent: HostToWorkflowEditor[] = [];
  const handle = workflowHost(scenario, (message) => sent.push(message), options);
  handle({ type: 'ready' });
  await vi.waitFor(() => expect(document.body.dataset.harnessReady).toBe('true'), { timeout: 5000 });
  delete document.body.dataset.harnessReady;
  const last = <T extends HostToWorkflowEditor['type']>(type: T) =>
    sent.filter((m): m is Extract<HostToWorkflowEditor, { type: T }> => m.type === type).at(-1);
  return { sent, handle, last };
}

describe('workflow mock host', () => {
  it('keeps six past runs whose summaries come from the core, and shows one again when it is selected', async () => {
    const { handle, last, sent } = await openEditor('default');
    const runs = last('history')?.runs ?? [];
    expect(runs.map((r) => [r.runId, r.status])).toEqual([
      ['run-7', 'success'],
      ['run-6', 'success'],
      ['run-5', 'success'],
      ['run-4', 'success'],
      ['run-3', 'failure'],
      ['run-2', 'success'],
    ]);
    expect(runs[0].review).toEqual({ total: 4, kept: 2, reverted: 0, pending: 2 });
    expect(runs[1].review).toEqual({ total: 4, kept: 3, reverted: 1, pending: 0 });
    expect(runs[2].review).toBeUndefined();

    handle({ type: 'selectRun', runId: 'run-3' });
    expect(sent.at(-2)).toMatchObject({
      type: 'run',
      live: false,
      run: { runId: 'run-3', status: 'failure' },
    });
    expect(sent.at(-1)).toEqual({ type: 'review', review: null });
    handle({ type: 'selectRun', runId: 'run-7' });
    expect(last('review')?.review).toMatchObject({ runId: 'run-7', coverage: 'git' });
    handle({ type: 'selectRun', runId: 'gone' });
    expect(sent.at(-2)).toEqual({ type: 'run', run: null, live: false });
  });

  it('records tool calls and tokens of agent blocks', async () => {
    const { handle, last } = await openEditor('default');
    handle({ type: 'selectRun', runId: 'run-7' });
    const run = last('run')?.run;
    expect(run?.steps.implement.output).toMatchObject({ toolCalls: 7, usage: { inputTokens: 18_400 } });
    expect(run?.steps.review.output).toMatchObject({ toolCalls: 2 });
  });

  it("shows the past failed run in the 'history' scenario", async () => {
    const { last } = await openEditor('history');
    expect(last('run')).toMatchObject({ live: false, run: { runId: 'run-3', status: 'failure' } });
    expect(last('review')).toEqual({ type: 'review', review: null });
  });

  it("leaves two blocks without ids in the 'noids' scenario", async () => {
    const { last } = await openEditor('noids');
    const steps = last('document')?.doc.workflow?.steps ?? [];
    expect(steps.map((s) => s.id)).toEqual([undefined, 'review_loop']);
  });

  it("finishes a run that changed five files in the 'review' scenario", async () => {
    const { last } = await openEditor('review');
    expect(last('run')).toMatchObject({ live: true, run: { runId: 'run-8', status: 'success' } });
    expect(last('review')?.review?.files).toHaveLength(5);
    expect(last('history')?.runs[0]).toMatchObject({
      runId: 'run-8',
      review: { total: 5, kept: 0, reverted: 0, pending: 5 },
    });
  });

  it.each([
    ['review-journal', { coverage: 'journal', overlapping: true }],
    ['review-worktree', { isolation: 'worktree', worktreeAvailable: true }],
    ['review-many', { omitted: 37 }],
  ])("sends the '%s' review", async (scenario, expected) => {
    const { last } = await openEditor(scenario);
    expect(last('review')?.review).toMatchObject({ runId: 'run-8', ...expected });
  });

  it("shows a past run whose files were all decided in 'review-done'", async () => {
    const { last } = await openEditor('review-done');
    expect(last('run')).toMatchObject({ live: false, run: { runId: 'run-6' } });
    expect(last('review')?.review?.files.every((f) => f.decision !== 'pending')).toBe(true);
  });

  it('applies keep and revert after a busy moment and updates the history counts', async () => {
    const { handle, last } = await openEditor('review');
    vi.useFakeTimers();
    handle({ type: 'reviewFiles', runId: 'run-8', decision: 'kept', paths: ['src/cart.ts'] });
    expect(last('review')?.review?.busy).toBe(true);
    vi.advanceTimersByTime(300);
    const review = last('review')?.review as RunReview;
    expect(review.busy).toBe(false);
    expect(review.files.find((f) => f.path === 'src/cart.ts')?.decision).toBe('kept');
    expect(review.files.filter((f) => f.decision === 'pending')).toHaveLength(4);
    expect(last('history')?.runs[0].review).toEqual({ total: 5, kept: 1, reverted: 0, pending: 4 });

    handle({ type: 'reviewFiles', runId: 'run-8', decision: 'reverted' });
    vi.advanceTimersByTime(300);
    expect(last('history')?.runs[0].review).toEqual({ total: 5, kept: 1, reverted: 4, pending: 0 });
  });

  it('fails to revert a read-only file and to revert files without a saved state', async () => {
    const { handle, last } = await openEditor('review-journal');
    vi.useFakeTimers();
    handle({ type: 'reviewFiles', runId: 'run-8', decision: 'reverted' });
    vi.advanceTimersByTime(300);
    const files = (last('review')?.review as RunReview).files;
    const readOnly = files.find((f) => f.path === READ_ONLY_PATH);
    expect(readOnly).toMatchObject({ decision: 'pending', error: expect.stringContaining('read-only') });
    expect(files.find((f) => !f.revertible)).toMatchObject({
      decision: 'pending',
      error: expect.any(String),
    });
    expect(files.find((f) => f.path === 'src/cart.ts')).toMatchObject({ decision: 'reverted' });
    expect(files.find((f) => f.path === 'src/cart.ts')?.error).toBeUndefined();
  });

  it('removes the worktree once every file of a worktree run is decided', async () => {
    const { handle, last } = await openEditor('review-worktree');
    vi.useFakeTimers();
    handle({ type: 'reviewFiles', runId: 'run-8', decision: 'kept' });
    vi.advanceTimersByTime(300);
    expect(last('review')?.review).toMatchObject({ worktreeAvailable: false, busy: false });
  });

  it('records opened diffs without answering', async () => {
    const { handle, sent } = await openEditor('review');
    const count = sent.length;
    handle({ type: 'openReviewDiff', runId: 'run-8', path: 'src/cart.ts' });
    expect(sent).toHaveLength(count);
    expect(probe.openedDiffs?.()).toContainEqual({ runId: 'run-8', path: 'src/cart.ts' });
  });

  it('sends a review after a live run that changed files', async () => {
    const { handle, last } = await openEditor('default', { liveDelayMs: 0 });
    handle({ type: 'run', inputs: { task: 'Add vouchers' } });
    await vi.waitFor(() => expect(last('history')?.runs).toHaveLength(7));
    const runId = last('history')?.runs[0].runId;
    expect(last('review')?.review).toMatchObject({ runId, coverage: 'git' });
    expect(last('review')?.review?.files.map((f) => f.path)).toContain('src/checkout.ts');
  });

  it("writes isolation and setup in the 'isolation' scenario", async () => {
    const { last } = await openEditor('isolation');
    expect(last('document')?.doc.workflow).toMatchObject({ isolation: 'worktree', setup: ['npm ci'] });
    expect(last('document')?.doc.valid).toBe(true);
  });

  it("shows a finished run with six past runs in the 'metrics' scenario", async () => {
    const { last } = await openEditor('metrics');
    expect(last('run')).toMatchObject({ live: true, run: { status: 'success' } });
    expect(last('history')?.runs).toHaveLength(6);
  });
});

describe('sidebar mock host', () => {
  function openSidebar(scenario: string) {
    let state: SidebarState | undefined;
    const handle = sidebarHost(scenario, (message: HostToSidebar) => {
      state = message.state;
    });
    handle({ type: 'ready' });
    return { handle, state: () => state as SidebarState };
  }

  it('lists runs in progress as active runs and moves them to the finished runs when stopped', () => {
    const { handle, state } = openSidebar('workflows');
    handle({ type: 'runWorkflow', uri: WORKFLOWS[1].uri });
    const [active] = state().activeRuns;
    expect(active).toMatchObject({ workflowUri: WORKFLOWS[1].uri, workflowName: WORKFLOWS[1].name });
    expect(state().recentRuns.some((r) => r.runId === active.runId)).toBe(false);

    handle({ type: 'cancelRun', runId: active.runId });
    expect(state().activeRuns).toEqual([]);
    expect(state().recentRuns[0]).toMatchObject({ runId: active.runId, status: 'cancelled' });
    expect(state().workflows[1].lastRun?.runId).toBe(active.runId);
  });

  it('creates agents from a starter and deletes them without asking again', () => {
    const { handle, state } = openSidebar('default');
    handle({ type: 'createAgent', name: 'Fixer', scope: 'workspace', starter: 'coder' });
    const fixer = state().agents.find((a) => a.name === 'Fixer');
    expect(fixer?.tools).toContain('runCommand');
    handle({ type: 'deleteAgent', uri: fixer?.uri ?? '' });
    expect(state().agents.some((a) => a.name === 'Fixer')).toBe(false);
  });

  it('shows a finished or running setup check for the setup tokens', () => {
    expect(openSidebar('default').state().setupCheck).toBeNull();
    expect(openSidebar('narrow-setup').state().setupCheck).toEqual(SETUP_REPORT);
    expect(openSidebar('setuprunning').state().setupCheck).toEqual(SETUP_REPORT_RUNNING);
  });

  it('runs the setup check, finishes it after a moment and closes it', () => {
    vi.useFakeTimers();
    const { handle, state } = openSidebar('default');
    handle({ type: 'checkSetup' });
    expect(state().setupCheck?.finishedAt).toBeUndefined();
    expect(state().setupCheck?.items).toEqual(SETUP_REPORT_RUNNING.items);
    vi.advanceTimersByTime(800);
    expect(state().setupCheck?.finishedAt).toBeGreaterThan(0);
    expect(state().setupCheck?.items).toEqual(SETUP_REPORT.items);
    handle({ type: 'dismissSetupCheck' });
    expect(state().setupCheck).toBeNull();
  });

  it('tests a model: probing first, then a text or tools result', () => {
    vi.useFakeTimers();
    const { handle, state } = openSidebar('default');
    handle({ type: 'testModel', ref: 'litellm/qwen-coder-32b' });
    expect(state().catalog.probing).toEqual(['litellm/qwen-coder-32b']);
    vi.advanceTimersByTime(600);
    expect(state().catalog.probing).toEqual([]);
    expect(state().catalog.probes?.['litellm/qwen-coder-32b']).toMatchObject({ outcome: 'text' });

    // A provider without a ref tests its first model.
    handle({ type: 'testModel', providerId: 'vscode' });
    expect(state().catalog.probing).toEqual(['vscode/copilot/gpt-4.1']);
    vi.advanceTimersByTime(600);
    expect(state().catalog.probes?.['vscode/copilot/gpt-4.1']).toMatchObject({
      outcome: 'tools',
      message: 'Tool calls work',
    });
  });

  it('logs settings requests', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    openSidebar('default').handle({ type: 'openSettings', query: 'isarFlow.modelPrices' });
    expect(info).toHaveBeenCalledWith('[mock host] open settings', 'isarFlow.modelPrices');
    info.mockRestore();
  });
});

describe('agent mock host', () => {
  function openAgent(scenario: string) {
    const sent: HostToAgentEditor[] = [];
    const handle = agentHost(scenario, (message) => sent.push(message));
    handle({ type: 'ready' });
    const catalog = () =>
      sent.filter((m): m is { type: 'catalog'; catalog: ModelCatalog } => m.type === 'catalog').at(-1)
        ?.catalog;
    const doc = () => sent.filter((m) => m.type === 'document').at(-1);
    return { handle, catalog, doc };
  }

  it('tests the model and reports the result through the catalog', () => {
    vi.useFakeTimers();
    const { handle, catalog } = openAgent('default');
    handle({ type: 'testModel', ref: 'vscode/copilot/gpt-4.1' });
    expect(catalog()?.probing).toEqual(['vscode/copilot/gpt-4.1']);
    vi.advanceTimersByTime(600);
    expect(catalog()?.probes?.['vscode/copilot/gpt-4.1']).toMatchObject({ outcome: 'tools' });
  });

  it("uses a model with a text probe in 'probed' and text tool mode in 'textmode'", () => {
    const probed = openAgent('probed');
    const agent = (d: ReturnType<typeof probed.doc>) =>
      d?.type === 'document' ? parseAgentText(d.doc.text).agent : null;
    const model = agent(probed.doc())?.model ?? '';
    expect(probed.catalog()?.probes?.[model]).toMatchObject({ outcome: 'text' });
    expect(agent(openAgent('textmode').doc())).toMatchObject({ model, toolMode: 'text' });
  });
});
