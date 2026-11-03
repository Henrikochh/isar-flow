import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import type { RunRecordSummary, RunReview } from '@isar-flow/core';
import { formatLocalTime } from '../../../src/report/formatTime';
import { runReport } from '../../../src/report/runReport';
import { fakeReviews, fakeServices, flush } from '../editors/fakes';
import { fakeGenerator, fakeReportUi, finishedView, WORKFLOW_URI } from './fakes';

const record = (runId = 'r1', overrides: Partial<RunRecordSummary> = {}): RunRecordSummary => ({
  runId,
  workflowUri: WORKFLOW_URI,
  workflowName: 'Release',
  status: 'success',
  startedAt: finishedView().startedAt,
  ...overrides,
});

const REVIEW: RunReview = {
  runId: 'r1',
  coverage: 'git',
  files: [],
} as unknown as RunReview;

function setup() {
  const fake = fakeServices();
  const reviews = fakeReviews();
  Object.assign(fake.services.runs, { reviews: reviews.service });
  fake.state.history = [record()];
  fake.state.views.r1 = finishedView();
  fake.state.workflows = [
    {
      uri: WORKFLOW_URI,
      name: 'Release',
      relativePath: '.isarflow/workflows/release.workflow.yaml',
      valid: true,
      stepCount: 1,
    },
  ];
  fake.state.catalog = { ...fake.state.catalog, prices: { 'litellm/gpt-4.1': { input: 2, output: 8 } } };
  const { ui, data } = fakeReportUi();
  const { generator, calls } = fakeGenerator();
  return { ...fake, reviews, ui, data, generator, calls };
}

describe('runReport export', () => {
  it('writes the full report to the target without a dialog and offers to open it', async () => {
    const { services, ui, data, generator, calls, reviews } = setup();
    reviews.reviews.r1 = REVIEW;
    data.infoAnswer = 'Open';
    const target = vscode.Uri.file('/tmp/report.md');
    const text = await runReport(services, 'r1', 'export', { target, ui, generator });
    await flush();

    expect(text).toBe('# full report of r1');
    expect(data.saveDialogs).toEqual([]);
    expect(data.written).toEqual([{ uri: 'file:///tmp/report.md', text: '# full report of r1' }]);
    expect(data.infos).toEqual(['Saved the run report.']);
    expect(ui.showInfo).toHaveBeenCalledWith('Saved the run report.', 'Open');
    expect(data.opened).toEqual(['file:///tmp/report.md']);

    expect(calls).toHaveLength(1);
    const [{ input, options }] = calls;
    expect(input).toEqual({
      run: finishedView(),
      workflow: expect.objectContaining({ name: 'Release' }),
      workflowPath: '.isarflow/workflows/release.workflow.yaml',
      record: record(),
      review: REVIEW,
      prices: { 'litellm/gpt-4.1': { input: 2, output: 8 } },
    });
    expect(options?.variant).toBe('full');
    expect(options?.formatTime?.(0)).toBe(formatLocalTime(0));
  });

  it('asks where to save, next to the workflow folder, with a Markdown filter', async () => {
    const { services, ui, data, generator } = setup();
    data.saveTarget = vscode.Uri.file('/w/out.md');
    await runReport(services, 'r1', 'export', { ui, generator });
    expect(data.saveDialogs).toHaveLength(1);
    const [dialog] = data.saveDialogs;
    expect(String(dialog.defaultUri)).toBe('file:///w/release-run-2026-11-03-1402.md');
    expect(dialog.filters).toEqual({ Markdown: ['md'] });
    expect(data.written.map((w) => w.uri)).toEqual(['file:///w/out.md']);
    expect(ui.folderOf).toHaveBeenCalled();
  });

  it('writes nothing when the save dialog is cancelled', async () => {
    const { services, ui, data, generator } = setup();
    expect(await runReport(services, 'r1', 'export', { ui, generator })).toBeUndefined();
    expect(data.written).toEqual([]);
    expect(data.infos).toEqual([]);
    expect(data.errors).toEqual([]);
  });

  it('offers no default folder without a workspace folder', async () => {
    const { services, ui, data, generator } = setup();
    data.folder = undefined;
    await runReport(services, 'r1', 'export', { ui, generator });
    const defaultPath = data.saveDialogs[0].defaultUri?.path ?? '';
    expect(defaultPath.endsWith('/release-run-2026-11-03-1402.md')).toBe(true);
    expect(defaultPath.startsWith('/w/')).toBe(false);
  });

  it('says why the file could not be written', async () => {
    const { services, ui, data, generator } = setup();
    data.writeError = new Error('EACCES: permission denied');
    const target = vscode.Uri.file('/tmp/report.md');
    expect(await runReport(services, 'r1', 'export', { target, ui, generator })).toBeUndefined();
    expect(data.errors).toEqual(['Could not save the run report: EACCES: permission denied']);
    expect(data.infos).toEqual([]);
  });
});

describe('runReport copy for PR', () => {
  it('copies the pr variant and confirms in the status bar', async () => {
    const { services, ui, data, generator, calls } = setup();
    const text = await runReport(services, 'r1', 'copyForPr', { ui, generator });
    expect(text).toBe('# pr report of r1');
    expect(calls[0].options?.variant).toBe('pr');
    expect(data.clipboard).toEqual(['# pr report of r1']);
    expect(data.statusBar).toEqual([{ text: 'Copied the run summary for a pull request.', ms: 4000 }]);
  });

  it('says why the clipboard could not be filled', async () => {
    const { services, ui, data, generator } = setup();
    data.clipboardError = new Error('clipboard busy');
    expect(await runReport(services, 'r1', 'copyForPr', { ui, generator })).toBeUndefined();
    expect(data.errors).toEqual(['Could not copy the run summary: clipboard busy']);
    expect(data.statusBar).toEqual([]);
  });
});

describe('runReport sources', () => {
  it('waits for running runs instead of reporting them', async () => {
    const { services, state, ui, data, generator } = setup();
    state.active = [
      { runId: 'r1', workflowUri: WORKFLOW_URI, view: finishedView('r1', { status: 'running' }) },
    ];
    expect(await runReport(services, 'r1', 'copyForPr', { ui, generator })).toBeUndefined();
    expect(data.infos).toEqual(['Wait until the run has finished.']);
    expect(generator.markdown).not.toHaveBeenCalled();
  });

  it('says when the run is no longer in the history', async () => {
    const { services, ui, data, generator } = setup();
    expect(await runReport(services, 'gone', 'export', { ui, generator })).toBeUndefined();
    expect(data.errors).toEqual(['That run is no longer in the history.']);
  });

  it('reads saved runs that are not cached', async () => {
    const { services, state, ui, generator, calls } = setup();
    state.views = {};
    state.stored.r1 = finishedView('r1', { simulated: true });
    await runReport(services, 'r1', 'copyForPr', { ui, generator });
    expect(calls[0].input.run).toEqual(finishedView('r1', { simulated: true }));
  });

  it('reports runs whose review was pruned or whose workflow file is gone', async () => {
    const { services, state, ui, data, generator, calls, reviews } = setup();
    reviews.service.get.mockRejectedValueOnce(new Error('pruned'));
    data.texts = {};
    state.workflows = [];
    await runReport(services, 'r1', 'copyForPr', { ui, generator });
    const { input } = calls[0];
    expect(input.review).toBeNull();
    expect(input).not.toHaveProperty('workflow');
    expect(input.workflowPath).toBe('release.workflow.yaml');
    expect(data.clipboard).toHaveLength(1);
  });

  it('reports runs without review service, record or prices', async () => {
    const { services, state, ui, generator, calls } = setup();
    Object.assign(services.runs, { reviews: undefined });
    state.history = [];
    state.catalog = { ...state.catalog, prices: undefined };
    await runReport(services, 'r1', 'copyForPr', { ui, generator, workflowUri: WORKFLOW_URI });
    const { input } = calls[0];
    expect(input.review).toBeNull();
    expect(input).not.toHaveProperty('record');
    expect(input).not.toHaveProperty('prices');
    expect(input.workflow).toMatchObject({ name: 'Release' });
  });
});

describe('runReport with the core generator', () => {
  it('copies the pull request summary and exports the full report', async () => {
    const { services, ui, data } = setup();
    await runReport(services, 'r1', 'copyForPr', { ui });
    expect(data.clipboard[0]).toMatch(/^### Release: succeeded/);
    await runReport(services, 'r1', 'export', { ui, target: vscode.Uri.file('/tmp/r.md') });
    expect(data.written[0].text).toMatch(/^# Run report: Release/);
    expect(data.written[0].text).toContain('.isarflow/workflows/release.workflow.yaml');
  });
});
