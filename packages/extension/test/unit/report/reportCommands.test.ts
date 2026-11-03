import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import type { RunRecordSummary } from '@isar-flow/core';
import { formatLocalTime } from '../../../src/report/formatTime';
import { createReportCommands, registerReportCommands } from '../../../src/report/reportCommands';
import { fakeServices, flush } from '../editors/fakes';
import { fakeGenerator, fakeReportUi, finishedView, WORKFLOW_URI } from './fakes';

const OTHER_URI = 'file:///w/.isarflow/workflows/other.workflow.yaml';

const record = (
  runId: string,
  startedAt: number,
  overrides: Partial<RunRecordSummary> = {},
): RunRecordSummary => ({
  runId,
  workflowUri: WORKFLOW_URI,
  workflowName: 'Release',
  status: 'success',
  startedAt,
  ...overrides,
});

function setup() {
  const fake = fakeServices();
  fake.state.history = [
    record('old', 1_000),
    record('copilot', 3_000, { origin: { kind: 'copilot' }, status: 'failure' }),
    record('other', 2_000, { workflowUri: OTHER_URI, workflowName: 'Other', simulated: true }),
    record('live', 4_000, { status: 'running' }),
  ];
  for (const { runId } of fake.state.history) fake.state.views[runId] = finishedView(runId);
  fake.state.active = [{ runId: 'live', workflowUri: WORKFLOW_URI, view: finishedView('live') }];
  const { ui, data } = fakeReportUi();
  const { generator, calls } = fakeGenerator();
  const commands = createReportCommands(fake.services, ui, generator);
  return { ...fake, ui, data, generator, calls, commands };
}

describe('report commands', () => {
  it('export a given run to a given target without asking', async () => {
    const { commands, data } = setup();
    const text = await commands.exportRunReport({ runId: 'old', target: '/tmp/x.md' });
    expect(text).toBe('# full report of old');
    expect(data.picks).toEqual([]);
    expect(data.saveDialogs).toEqual([]);
    expect(data.written).toEqual([{ uri: 'file:///tmp/x.md', text: '# full report of old' }]);
  });

  it('accept a run id as plain argument and a Uri as target', async () => {
    const { commands, data } = setup();
    await commands.copyRunForPr('old');
    expect(data.clipboard).toEqual(['# pr report of old']);
    await commands.exportRunReport({ runId: 'old', target: vscode.Uri.file('/tmp/y.md') });
    expect(data.written.map((w) => w.uri)).toEqual(['file:///tmp/y.md']);
  });

  it('let the user pick a finished run, newest first, with status, time and origin', async () => {
    const { commands, data } = setup();
    data.pick = (items) => items[1];
    await commands.copyRunForPr();
    expect(data.picks).toHaveLength(1);
    const [{ items, options }] = data.picks;
    expect(options.placeHolder).toBe('Choose a run to copy for a pull request description');
    expect(items).toEqual([
      expect.objectContaining({
        label: 'Release',
        description: '$(error) Failed  $(copilot) Copilot',
        detail: formatLocalTime(3_000),
      }),
      expect.objectContaining({
        label: 'Other',
        description: '$(pass) Succeeded  $(beaker) Simulated',
        detail: formatLocalTime(2_000),
      }),
      expect.objectContaining({
        label: 'Release',
        description: '$(pass) Succeeded',
        detail: formatLocalTime(1_000),
      }),
    ]);
    expect(data.clipboard).toEqual(['# pr report of other']);
  });

  it('list only the runs of the given workflow', async () => {
    const { commands, data } = setup();
    await commands.exportRunReport({ workflowUri: OTHER_URI });
    expect(data.picks[0].items.map((item) => item.label)).toEqual(['Other']);
    expect(data.picks[0].options.placeHolder).toBe('Choose a run to export');
  });

  it('do nothing when the pick is closed', async () => {
    const { commands, data, generator } = setup();
    expect(await commands.exportRunReport()).toBeUndefined();
    expect(generator.markdown).not.toHaveBeenCalled();
    expect(data.written).toEqual([]);
  });

  it('say when there is no finished run', async () => {
    const { commands, data, state } = setup();
    state.history = [];
    await commands.exportRunReport();
    expect(data.infos).toEqual(['No finished runs yet. Run a workflow, then export its report.']);
    expect(data.picks).toEqual([]);
  });
});

describe('registerReportCommands', () => {
  it('registers both commands and shows unexpected errors', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const register = vi
      .spyOn(vscode.commands, 'registerCommand')
      .mockImplementation((id: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(id, handler);
        return { dispose: () => handlers.delete(id) };
      });
    try {
      const fake = fakeServices();
      const { ui, data } = fakeReportUi();
      fake.state.history = [record('r1', 1)];
      fake.state.views.r1 = finishedView('r1');
      const { generator } = fakeGenerator();
      vi.mocked(generator.markdown).mockImplementation(() => {
        throw new Error('boom');
      });
      const disposable = registerReportCommands(fake.services, ui, generator);
      expect([...handlers.keys()]).toEqual(['isarFlow.exportRunReport', 'isarFlow.copyRunForPr']);
      await handlers.get('isarFlow.copyRunForPr')?.({ runId: 'r1' });
      await flush();
      expect(data.errors).toEqual(['boom']);
      expect(fake.services.output.error).toHaveBeenCalled();
      disposable.dispose();
      expect(handlers.size).toBe(0);
    } finally {
      register.mockRestore();
    }
  });
});
