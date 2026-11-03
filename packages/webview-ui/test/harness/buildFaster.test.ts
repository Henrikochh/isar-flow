import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseSimulationText, type HostToWorkflowEditor } from '@isar-flow/core';
import { SIMULATION_BROKEN_TEXT, SIMULATION_ERRORS_TEXT, SIMULATION_TEXT } from '../../harness/fixtures';
import { probe, workflowHost, type WorkflowHostOptions } from '../../harness/mockHost';

afterEach(() => vi.useRealTimers());

async function openEditor(scenario: string, options?: WorkflowHostOptions) {
  const sent: HostToWorkflowEditor[] = [];
  const handle = workflowHost(scenario, (message) => sent.push(message), options);
  handle({ type: 'ready' });
  await vi.waitFor(() => expect(document.body.dataset.harnessReady).toBe('true'), { timeout: 5000 });
  delete document.body.dataset.harnessReady;
  const all = <T extends HostToWorkflowEditor['type']>(type: T) =>
    sent.filter((m): m is Extract<HostToWorkflowEditor, { type: T }> => m.type === type);
  const last = <T extends HostToWorkflowEditor['type']>(type: T) => all(type).at(-1);
  return { sent, handle, last, all };
}

describe('simulation fixtures', () => {
  it('mock the review loop: tests fail once, the reviewer approves on the second round', () => {
    const file = parseSimulationText(SIMULATION_TEXT).file;
    expect(file?.blocks?.tests).toEqual([
      { exitCode: 1, output: '1 failed' },
      { exitCode: 0, output: '32 passed' },
    ]);
    expect(file?.blocks?.review?.map((r) => (r.json as { approved: boolean }).approved)).toEqual([
      false,
      true,
    ]);
    expect((file?.blocks?.review?.[0].json as { issues: string[] }).issues).toHaveLength(2);
    expect(file?.blocks?.implement).toBeUndefined();
    expect(file?.blocks?.fix).toBeUndefined();
  });

  it('have a file with warnings and one that cannot be read', () => {
    expect(parseSimulationText(SIMULATION_ERRORS_TEXT).diagnostics).toEqual([]);
    expect(parseSimulationText(SIMULATION_BROKEN_TEXT).file).toBeNull();
  });
});

describe('workflow mock host: simulation file', () => {
  it('sends the checked simulation file after ready and after document changes', async () => {
    const { handle, last, all } = await openEditor('simulation');
    expect(last('simulation')?.simulation).toMatchObject({
      path: '.isarflow/simulations/review-loop.sim.yaml',
      exists: true,
      diagnostics: [],
    });
    expect(last('simulation')?.simulation.file.blocks?.tests).toHaveLength(2);
    expect(last('focusStep')).toEqual({ type: 'focusStep', stepId: 'review' });
    const count = all('simulation').length;
    // Like the extension, a renamed block keeps its mocks.
    handle({ type: 'ops', ops: [{ op: 'renameStep', stepId: 'tests', newId: 'checks' }] });
    expect(all('simulation')).toHaveLength(count + 1);
    expect(last('simulation')?.simulation.file.blocks?.checks).toHaveLength(2);
    expect(last('simulation')?.simulation.diagnostics).toEqual([]);
    handle({ type: 'ops', ops: [{ op: 'deleteStep', stepId: 'review' }] });
    expect(last('simulation')?.simulation.diagnostics.map((d) => d.code)).toContain('sim-unknown-block');
  });

  it('warns about the mocks of the errors scenario and reports the broken file', async () => {
    const errors = await openEditor('simulation-errors');
    const codes = errors.last('simulation')?.simulation.diagnostics.map((d) => d.code);
    expect(codes).toEqual(
      expect.arrayContaining(['sim-unknown-block', 'sim-field-mismatch', 'sim-json-shape']),
    );
    const broken = await openEditor('simulation-broken');
    const state = broken.last('simulation')?.simulation;
    expect(state?.file).toEqual({});
    expect(state?.diagnostics.some((d) => d.severity === 'error')).toBe(true);
  });

  it('writes mocks into the text, sends the new state and records opening the file', async () => {
    const { handle, last } = await openEditor('simulation-console');
    expect(last('focusStep')).toEqual({ type: 'focusStep', stepId: 'tests' });
    handle({ type: 'setSimulationMocks', stepId: 'fix', results: [{ text: 'Fixed it.' }] });
    expect(probe.simulationText?.()).toContain('Fixed it.');
    expect(last('simulation')?.simulation.file.blocks?.fix).toEqual([{ text: 'Fixed it.' }]);
    handle({ type: 'setSimulationMocks', stepId: 'tests', results: null });
    expect(last('simulation')?.simulation.file.blocks?.tests).toBeUndefined();
    const before = probe.openedSimulation?.() ?? 0;
    handle({ type: 'openSimulationFile' });
    expect(probe.openedSimulation?.()).toBe(before + 1);
  });

  it('keeps a broken file as it is when mocks cannot be written', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const { handle } = await openEditor('simulation-broken');
    handle({ type: 'setSimulationMocks', stepId: 'tests', results: [{ exitCode: 0 }] });
    expect(probe.simulationText?.()).toBe(SIMULATION_BROKEN_TEXT);
    info.mockRestore();
  });
});

describe('workflow mock host: last run context', () => {
  it('sends the newest seeded run after ready and the newest run after each finished run', async () => {
    const { handle, last } = await openEditor('live', { liveDelayMs: 0 });
    expect(last('run')).toBeUndefined();
    expect(last('lastRunContext')?.context).toMatchObject({ runId: 'run-7', status: 'success' });
    handle({ type: 'run', inputs: {} });
    await vi.waitFor(() => expect(last('history')?.runs).toHaveLength(7));
    expect(last('lastRunContext')?.context?.runId).toBe(last('history')?.runs[0].runId);
  });

  it("reads a newest run with a task longer than 2 KB in 'live-long'", async () => {
    const { last } = await openEditor('live-long');
    const context = last('lastRunContext')?.context;
    expect(context?.runId).toBe(last('history')?.runs[0].runId);
    expect(String(context?.inputs.task).length).toBeGreaterThan(2048);
    expect(last('run')).toBeUndefined();
  });
});

describe('workflow mock host: simulate and run from here', () => {
  it('simulates with the mocks and keeps the run in the history', async () => {
    const { handle, last, all } = await openEditor('default', { liveDelayMs: 0 });
    handle({ type: 'simulate', inputs: { task: 'Try it' } });
    await vi.waitFor(() => expect(last('history')?.runs).toHaveLength(7));
    const start = all('runEvent').find((m) => m.event.type === 'run-start')?.event;
    expect(start).toMatchObject({ type: 'run-start', simulated: true, inputs: { task: 'Try it' } });
    const newest = last('history')?.runs[0];
    expect(newest).toMatchObject({ simulated: true, status: 'success' });
    const testsEnds = all('runEvent').filter(
      (m) => m.event.type === 'step-end' && m.event.stepId === 'tests',
    );
    expect(testsEnds.map((m) => (m.event as { output?: { exitCode?: number } }).output?.exitCode)).toEqual([
      1, 0,
    ]);
  });

  it('does not simulate with a broken simulation file', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const { handle, all } = await openEditor('simulation-broken', { liveDelayMs: 0 });
    handle({ type: 'simulate', inputs: {} });
    await new Promise((r) => setTimeout(r, 50));
    expect(all('runEvent')).toHaveLength(0);
    info.mockRestore();
  });

  it('continues a past run at a block: earlier blocks are reused', async () => {
    const { handle, last, all } = await openEditor('default', { liveDelayMs: 0 });
    handle({ type: 'runFromHere', runId: 'run-3', stepId: 'tests', inputs: { task: 'Again' } });
    await vi.waitFor(() => expect(last('history')?.runs).toHaveLength(7));
    const start = all('runEvent').find((m) => m.event.type === 'run-start')?.event;
    expect(start).toMatchObject({
      resumedFrom: { runId: 'run-3', stepId: 'tests' },
      inputs: { task: 'Again' },
    });
    const reused = all('runEvent').filter((m) => m.event.type === 'step-end' && m.event.reused);
    expect(reused.map((m) => (m.event as { stepId: string }).stepId)).toContain('implement');
    expect(last('history')?.runs[0]).toMatchObject({
      resumedFrom: { runId: 'run-3', stepId: 'tests' },
      status: 'success',
    });
  });
});

describe('workflow mock host: build-faster scenarios', () => {
  it("shows the failed run-3 with tests selected in 'resume' and 'resume-changed'", async () => {
    const resume = await openEditor('resume');
    expect(resume.last('run')).toMatchObject({ live: false, run: { runId: 'run-3', status: 'failure' } });
    expect(resume.last('focusStep')).toEqual({ type: 'focusStep', stepId: 'tests' });
    const changed = await openEditor('resume-changed');
    expect(changed.last('run')?.run?.runId).toBe('run-3');
    expect(changed.last('document')?.doc.text).not.toBe(resume.last('document')?.doc.text);
  });

  it("shows a run resumed from run-3 in 'resumed'", async () => {
    const { last } = await openEditor('resumed');
    const run = last('run')?.run;
    expect(run).toMatchObject({ resumedFrom: { runId: 'run-3', stepId: 'tests' }, status: 'success' });
    expect(run?.steps.implement.reused).toBe(true);
    expect(last('history')?.runs[0].runId).toBe(run?.runId);
  });

  it("shows a finished simulated run in 'simulated'", async () => {
    const { last } = await openEditor('simulated');
    expect(last('run')?.run).toMatchObject({ simulated: true, status: 'success' });
    expect(last('history')?.runs[0]).toMatchObject({ simulated: true });
  });

  it("puts a simulated and a resumed run on top of the history in 'runs-markers'", async () => {
    const { last } = await openEditor('runs-markers');
    const runs = last('history')?.runs ?? [];
    expect(runs).toHaveLength(8);
    expect(runs[0]).toMatchObject({ simulated: true });
    expect(runs[1]).toMatchObject({ resumedFrom: { runId: 'run-3', stepId: 'tests' } });
    expect(runs.slice(2).map((r) => r.runId)).toEqual(['run-7', 'run-6', 'run-5', 'run-4', 'run-3', 'run-2']);
    expect(last('run')).toBeUndefined();
  });

  it('keeps the default history as it was', async () => {
    const { last } = await openEditor('default');
    expect(last('history')?.runs.map((r) => r.runId)).toEqual([
      'run-7',
      'run-6',
      'run-5',
      'run-4',
      'run-3',
      'run-2',
    ]);
    expect(last('history')?.runs.find((r) => r.runId === 'run-3')?.stoppedAt).toBe('tests');
  });
});
