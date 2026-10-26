import { describe, expect, it, vi } from 'vitest';
import type { HostToSidebar, HostToWorkflowEditor, SidebarState } from '@isar-flow/core';
import { WORKFLOWS } from '../../harness/fixtures';
import { sidebarHost, workflowHost } from '../../harness/mockHost';

describe('workflow mock host', () => {
  async function openEditor(scenario: string) {
    const sent: HostToWorkflowEditor[] = [];
    const handle = workflowHost(scenario, (message) => sent.push(message));
    handle({ type: 'ready' });
    await vi.waitFor(() => expect(sent.some((m) => m.type === 'history')).toBe(true));
    return { sent, handle };
  }

  it('keeps a history of past runs and shows one again when it is selected', async () => {
    const { sent, handle } = await openEditor('default');
    const history = sent.find((m) => m.type === 'history');
    expect(history?.type === 'history' && history.runs.map((r) => [r.runId, r.status])).toEqual([
      ['run-7', 'success'],
      ['run-3', 'failure'],
    ]);
    handle({ type: 'selectRun', runId: 'run-3' });
    expect(sent.at(-1)).toMatchObject({ type: 'run', live: false, run: { runId: 'run-3', status: 'failure' } });
    handle({ type: 'selectRun', runId: 'gone' });
    expect(sent.at(-1)).toEqual({ type: 'run', run: null, live: false });
  });

  it("shows the past failed run in the 'history' scenario", async () => {
    const { sent } = await openEditor('history');
    await vi.waitFor(() => expect(sent.some((m) => m.type === 'run')).toBe(true));
    expect(sent.find((m) => m.type === 'run')).toMatchObject({ live: false, run: { runId: 'run-3', status: 'failure' } });
  });

  it("leaves two blocks without ids in the 'noids' scenario", async () => {
    const { sent } = await openEditor('noids');
    const doc = sent.find((m) => m.type === 'document');
    const steps = doc?.type === 'document' ? (doc.doc.workflow?.steps ?? []) : [];
    expect(steps.map((s) => s.id)).toEqual([undefined, 'review_loop']);
  });
});

describe('sidebar mock host', () => {
  it('lists runs in progress as active runs and moves them to the finished runs when stopped', () => {
    let state: SidebarState | undefined;
    const handle = sidebarHost('workflows', (message: HostToSidebar) => {
      state = message.state;
    });
    handle({ type: 'runWorkflow', uri: WORKFLOWS[1].uri });
    const [active] = state?.activeRuns ?? [];
    expect(active).toMatchObject({ workflowUri: WORKFLOWS[1].uri, workflowName: WORKFLOWS[1].name });
    expect(state?.recentRuns.some((r) => r.runId === active.runId)).toBe(false);

    handle({ type: 'cancelRun', runId: active.runId });
    expect(state?.activeRuns).toEqual([]);
    expect(state?.recentRuns[0]).toMatchObject({ runId: active.runId, status: 'cancelled' });
    expect(state?.workflows[1].lastRun?.runId).toBe(active.runId);
  });

  it('creates agents from a starter and deletes them without asking again', () => {
    let state: SidebarState | undefined;
    const handle = sidebarHost('default', (message: HostToSidebar) => {
      state = message.state;
    });
    handle({ type: 'createAgent', name: 'Fixer', scope: 'workspace', starter: 'coder' });
    const fixer = state?.agents.find((a) => a.name === 'Fixer');
    expect(fixer?.tools).toContain('runCommand');
    handle({ type: 'deleteAgent', uri: fixer?.uri ?? '' });
    expect(state?.agents.some((a) => a.name === 'Fixer')).toBe(false);
  });
});
