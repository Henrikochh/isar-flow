import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseSimulationText,
  parseWorkflowText,
  validateWorkflow,
  type HostToAgentEditor,
  type HostToSidebar,
  type HostToWorkflowEditor,
  type SidebarState,
} from '@isar-flow/core';
import {
  AGENTS,
  MEMORY_FILE,
  MEMORY_MISSING,
  MEMORY_OVER,
  RELEASE_LONG_TRIGGERS_TEXT,
  RELEASE_MANY_CHOICES_TEXT,
  RELEASE_SIMULATION_TEXT,
  RELEASE_WORKFLOW_TEXT,
} from '../../harness/fixtures';
import { everydayText } from '../../harness/everydayScenarios';
import { agentHost, probe, sidebarHost, workflowHost } from '../../harness/mockHost';

afterEach(() => vi.useRealTimers());

const MINUTE = 60_000;

function problems(text: string) {
  const parsed = parseWorkflowText(text);
  const semantic = parsed.workflow
    ? validateWorkflow(parsed.workflow, { agentIds: AGENTS.map((a) => a.id) })
    : [];
  return [...parsed.diagnostics, ...semantic];
}

async function openEditor(scenario: string) {
  const sent: HostToWorkflowEditor[] = [];
  const handle = workflowHost(scenario, (message) => sent.push(message), { liveDelayMs: 0 });
  handle({ type: 'ready' });
  await vi.waitFor(() => expect(document.body.dataset.harnessReady).toBe('true'), { timeout: 5000 });
  delete document.body.dataset.harnessReady;
  const all = <T extends HostToWorkflowEditor['type']>(type: T) =>
    sent.filter((m): m is Extract<HostToWorkflowEditor, { type: T }> => m.type === type);
  const last = <T extends HostToWorkflowEditor['type']>(type: T) => all(type).at(-1);
  return { sent, handle, last, all };
}

describe('release workflow fixtures', () => {
  it('are valid: triggers, Copilot access, two ask blocks and blocks reading the answer, editor and git', () => {
    expect(problems(RELEASE_WORKFLOW_TEXT)).toEqual([]);
    const workflow = parseWorkflowText(RELEASE_WORKFLOW_TEXT).workflow;
    expect(workflow?.on).toEqual({
      save: { files: ['src/**/*.ts', '!src/gen/**'] },
      schedule: { every: '1h' },
    });
    expect(workflow?.expose).toBe(true);
    expect(workflow?.steps.map((s) => [s.id, s.type])).toEqual([
      ['pick-env', 'ask'],
      ['release-notes', 'ask'],
      ['deploy', 'console'],
      ['summarize', 'agent'],
    ]);
    expect(problems(RELEASE_MANY_CHOICES_TEXT)).toEqual([]);
    expect(problems(RELEASE_LONG_TRIGGERS_TEXT)).toEqual([]);
    expect(parseSimulationText(RELEASE_SIMULATION_TEXT).file?.blocks?.['pick-env']).toHaveLength(2);
  });

  it('break the release workflow on purpose for the paused trigger scenarios', () => {
    expect(problems(everydayText('triggers-invalid')).map((d) => d.code)).toEqual(['schedule-too-short']);
    expect(problems(everydayText('triggers-inputs')).map((d) => d.code)).toEqual(['trigger-required-input']);
  });
});

describe('workflow mock host: ask blocks', () => {
  it('asks in a live run, continues with the answer and ends the run', async () => {
    const before = Date.now();
    const { handle, last, all } = await openEditor('ask');
    expect(last('document')?.doc.fileName).toBe('release.workflow.yaml');
    const first = last('askRequest')?.prompt;
    expect(first).toMatchObject({
      stepId: 'pick-env',
      question: 'Which environment should I deploy to?',
      choices: ['dev', 'staging', 'prod'],
      default: 'dev',
    });
    expect(first?.expiresAt).toBeGreaterThanOrEqual(before + 300_000);
    handle({ type: 'answer', requestId: first?.requestId ?? '', answer: 'staging' });
    expect(all('askResolved').map((m) => m.requestId)).toEqual([first?.requestId]);
    await vi.waitFor(() => expect(last('askRequest')?.prompt.stepId).toBe('release-notes'));
    const notes = last('askRequest')?.prompt;
    expect(notes?.choices).toBeUndefined();
    handle({ type: 'answer', requestId: notes?.requestId ?? '', answer: 'Faster checkout' });
    await vi.waitFor(() => expect(last('history')?.runs[0]?.runId).toBe(first?.runId));
    const run = last('history')?.runs[0];
    expect(run?.status).toBe('success');
    expect(run?.workflowUri).toContain('release.workflow.yaml');
    const deploy = all('runEvent').find((m) => m.event.type === 'step-start' && m.event.stepId === 'deploy');
    expect(deploy?.event).toMatchObject({ detail: 'npm run deploy -- --env staging' });
    expect(probe.answers?.()).toEqual([
      { requestId: first?.requestId, answer: 'staging' },
      { requestId: notes?.requestId, answer: 'Faster checkout' },
    ]);
  });

  it('answers pick-env by itself in ask-free and asks the free-text question with 2.5 minutes left', async () => {
    const before = Date.now();
    const { all } = await openEditor('ask-free');
    const asks = all('askRequest');
    expect(asks.map((m) => m.prompt.stepId)).toEqual(['release-notes']);
    expect(asks[0].prompt.default).toBe('Routine release');
    expect(asks[0].prompt.expiresAt).toBeGreaterThanOrEqual(before + 150_000);
    expect(asks[0].prompt.expiresAt).toBeLessThan(before + 160_000);
  });

  it('removes the card when the run is stopped while it asks', async () => {
    const { handle, last } = await openEditor('ask');
    const requestId = last('askRequest')?.prompt.requestId;
    handle({ type: 'cancelRun' });
    await vi.waitFor(() => expect(last('askResolved')?.requestId).toBe(requestId));
  });

  it('stacks a second question in ask-two and an expired one in ask-expired', async () => {
    const two = await openEditor('ask-two');
    expect(two.all('askRequest').map((m) => m.prompt.stepId)).toEqual(['pick-env', 'release-notes']);
    const expired = await openEditor('ask-expired');
    expect(expired.last('askRequest')?.prompt.expiresAt).toBeLessThan(Date.now());
  });

  it('shows a review card next to the question in ask-review', async () => {
    const { last } = await openEditor('ask-review');
    const runId = last('askRequest')?.prompt.runId;
    expect(last('review')?.review?.runId).toBe(runId);
  });

  it('shows a finished run in ask-output where nobody answered pick-env in time', async () => {
    const { last } = await openEditor('ask-output');
    const run = last('run')?.run;
    expect(run?.steps['pick-env']).toMatchObject({
      status: 'success',
      output: { answer: 'dev', timedOut: true },
    });
    expect(run?.status).toBe('success');
    expect(last('focusStep')).toEqual({ type: 'focusStep', stepId: 'pick-env' });
  });
});

describe('workflow mock host: release history, origins and reports', () => {
  it('keeps the review loop history for every other scenario', async () => {
    const { last } = await openEditor('default');
    expect(last('history')?.runs.map((r) => r.runId)).toEqual([
      'run-7',
      'run-6',
      'run-5',
      'run-4',
      'run-3',
      'run-2',
    ]);
    expect(last('triggers')?.triggers).toEqual({ triggers: [], status: 'active' });
  });

  it('seeds release runs started on save, by Copilot, on a selection, on schedule and by hand', async () => {
    const { last } = await openEditor('origins');
    const runs = last('history')?.runs ?? [];
    expect(runs.map((r) => [r.runId, r.origin?.kind ?? 'manual'])).toEqual([
      ['run-12', 'trigger'],
      ['run-11', 'copilot'],
      ['run-10', 'selection'],
      ['run-9', 'trigger'],
      ['run-8', 'manual'],
    ]);
    expect(runs.every((r) => r.status === 'success')).toBe(true);
    expect(last('run')?.run?.origin).toEqual({ kind: 'trigger', trigger: 'save', file: 'src/app.ts' });
  });

  it('notes report and settings requests on the probe', async () => {
    const { handle } = await openEditor('report-menu');
    handle({ type: 'runReport', runId: 'run-12', action: 'export' });
    handle({ type: 'runReport', runId: 'run-12', action: 'copyForPr' });
    handle({ type: 'openSettings', query: 'isarFlow.triggers.enabled' });
    expect(probe.reports?.()).toEqual([
      { runId: 'run-12', action: 'export' },
      { runId: 'run-12', action: 'copyForPr' },
    ]);
    expect(probe.settingsQueries?.()).toEqual(['isarFlow.triggers.enabled']);
  });

  it('loads the release mocks in simulation-ask', async () => {
    const { last } = await openEditor('simulation-ask');
    expect(last('simulation')?.simulation.path).toBe('.isarflow/simulations/release.sim.yaml');
    expect(last('simulation')?.simulation.file.blocks?.['pick-env']).toEqual([
      { answer: 'staging' },
      { answer: 'prod' },
    ]);
    expect(last('focusStep')).toEqual({ type: 'focusStep', stepId: 'pick-env' });
  });
});

describe('workflow mock host: triggers', () => {
  it('sends active triggers with the next scheduled run in 12 minutes', async () => {
    const before = Date.now();
    const { last } = await openEditor('triggers');
    const state = last('triggers')?.triggers;
    expect(state?.status).toBe('active');
    expect(state?.triggers.map((t) => t.label)).toEqual(['On save: src/**/*.ts, !src/gen/**', 'Every hour']);
    expect(state?.nextRunAt).toBeGreaterThanOrEqual(before + 12 * MINUTE);
    expect(state?.lastFired).toMatchObject({ kind: 'save', file: 'src/app.ts', runId: 'run-12' });
  });

  it.each([
    ['triggers-paused', 'approval'],
    ['triggers-disabled', 'disabled'],
    ['triggers-untrusted', 'untrusted'],
    ['triggers-invalid', 'invalid'],
    ['triggers-inputs', 'inputs'],
  ])('pauses the triggers in %s (%s)', async (scenario, reason) => {
    const { last } = await openEditor(scenario);
    expect(last('triggers')?.triggers).toMatchObject({ status: 'paused', pausedReason: reason });
    expect(last('triggers')?.triggers.pausedMessage).toBeTruthy();
    expect(last('trust')?.trusted).toBe(scenario !== 'triggers-untrusted');
  });

  it('resumes limited triggers', async () => {
    const { handle, last } = await openEditor('triggers-limited');
    expect(last('triggers')?.triggers.pausedReason).toBe('limited');
    handle({ type: 'resumeTriggers' });
    expect(last('triggers')?.triggers.status).toBe('active');
    expect(probe.resumedTriggers?.()).toBe(1);
  });

  it('reads the triggers again after an edit and says a skipped start in triggers-long', async () => {
    const { handle, last } = await openEditor('triggers-long');
    expect(last('triggers')?.triggers.lastFired?.skipped).toBe('The workflow was already running.');
    handle({ type: 'ops', ops: [{ op: 'updateWorkflow', set: {}, unset: ['on'] }] });
    expect(last('triggers')?.triggers).toEqual({ triggers: [], status: 'active' });
  });
});

describe('agent mock host: memory', () => {
  function openAgent(scenario: string) {
    const sent: HostToAgentEditor[] = [];
    const handle = agentHost(scenario, (message) => sent.push(message));
    handle({ type: 'ready' });
    const memory = () =>
      sent.filter((m): m is Extract<HostToAgentEditor, { type: 'memory' }> => m.type === 'memory').at(-1)
        ?.memory;
    const doc = () =>
      sent.filter((m): m is Extract<HostToAgentEditor, { type: 'document' }> => m.type === 'document').at(-1)
        ?.doc;
    return { handle, memory, doc };
  }

  it('sends the memory file after ready, per scenario', () => {
    expect(openAgent('default').memory()).toEqual(MEMORY_FILE);
    expect(openAgent('memory-missing').memory()).toEqual(MEMORY_MISSING);
    expect(openAgent('memory-over').memory()).toEqual(MEMORY_OVER);
    expect(openAgent('memory-nofolder').memory()).toBeNull();
    const memory = openAgent('memory');
    expect(memory.doc()?.text).toContain('memory: write');
    expect(openAgent('memory-user').doc()?.scope).toBe('user');
  });

  it('notes requests to open the memory file', () => {
    const { handle } = openAgent('memory');
    handle({ type: 'openMemory' });
    expect(probe.openedMemory?.()).toEqual([null]);
  });
});

describe('sidebar mock host: memory', () => {
  it('lists two folders, a workflow with triggers and Copilot access, and notes Open', () => {
    let state: SidebarState | undefined;
    const handle = sidebarHost('memory', (message: HostToSidebar) => {
      state = message.state;
    });
    handle({ type: 'ready' });
    expect(state?.memory).toEqual([MEMORY_FILE, MEMORY_MISSING]);
    expect(state?.workflows[0]).toMatchObject({
      exposed: true,
      triggers: [{ kind: 'save' }, { kind: 'schedule' }],
    });
    expect(state?.workflows.filter((w) => w.exposed).length).toBe(2);
    expect(state?.recentRuns[0].origin).toEqual({ kind: 'trigger', trigger: 'save', file: 'src/app.ts' });
    handle({ type: 'openMemory', folderUri: MEMORY_MISSING.folderUri });
    expect(probe.openedMemory?.()).toEqual([MEMORY_MISSING.folderUri]);
  });

  it('leaves the memory out of the other scenarios', () => {
    let state: SidebarState | undefined;
    sidebarHost('default', (message: HostToSidebar) => {
      state = message.state;
    })({ type: 'ready' });
    expect(state?.memory).toBeUndefined();
  });
});
