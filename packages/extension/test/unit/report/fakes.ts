import { vi } from 'vitest';
import * as vscode from 'vscode';
import type { RunReportInput, RunReportOptions, RunView } from '@isar-flow/core';
import type { ReportGenerator, ReportUi } from '../../../src/report/runReport';

export const WORKFLOW_URI = 'file:///w/.isarflow/workflows/release.workflow.yaml';

export const WORKFLOW_TEXT = [
  'version: 1',
  'name: Release',
  'steps:',
  '  - id: tests',
  '    type: console',
  '    run: npm test',
  '',
].join('\n');

export const finishedView = (runId = 'r1', overrides: Partial<RunView> = {}): RunView => ({
  runId,
  workflowName: 'Release',
  status: 'success',
  startedAt: Date.UTC(2026, 10, 3, 13, 2),
  durationMs: 240_000,
  inputs: {},
  usage: { inputTokens: 10, outputTokens: 5 },
  steps: {},
  ...overrides,
});

/** A generator that records its calls and answers with a short text naming the variant. */
export function fakeGenerator() {
  const calls: { input: RunReportInput; options: RunReportOptions | undefined }[] = [];
  const generator: ReportGenerator = {
    markdown: vi.fn((input: RunReportInput, options?: RunReportOptions) => {
      calls.push({ input, options });
      return `# ${options?.variant ?? 'full'} report of ${input.run.runId}`;
    }),
    fileName: vi.fn((run: RunView) => `${run.workflowName.toLowerCase()}-run-2026-11-03-1402.md`),
  };
  return { generator, calls };
}

/** Window functions of the report commands, recording what they were asked. */
export function fakeReportUi() {
  const data = {
    texts: { [WORKFLOW_URI]: WORKFLOW_TEXT } as Record<string, string>,
    saveTarget: undefined as vscode.Uri | undefined,
    infoAnswer: undefined as string | undefined,
    pick: undefined as ((items: vscode.QuickPickItem[]) => vscode.QuickPickItem | undefined) | undefined,
    folder: vscode.Uri.file('/w') as vscode.Uri | undefined,
    written: [] as { uri: string; text: string }[],
    clipboard: [] as string[],
    infos: [] as string[],
    errors: [] as string[],
    statusBar: [] as { text: string; ms: number }[],
    opened: [] as string[],
    picks: [] as { items: vscode.QuickPickItem[]; options: vscode.QuickPickOptions }[],
    saveDialogs: [] as vscode.SaveDialogOptions[],
    writeError: undefined as Error | undefined,
    clipboardError: undefined as Error | undefined,
  };
  const ui: ReportUi = {
    readText: vi.fn(async (uri: vscode.Uri) => {
      const text = data.texts[uri.toString()];
      if (text === undefined) throw new Error('ENOENT: no such file');
      return text;
    }),
    showSaveDialog: vi.fn(async (options: vscode.SaveDialogOptions) => {
      data.saveDialogs.push(options);
      return data.saveTarget;
    }),
    writeFile: vi.fn(async (uri: vscode.Uri, text: string) => {
      if (data.writeError) throw data.writeError;
      data.written.push({ uri: uri.toString(), text });
    }),
    showInfo: vi.fn(async (message: string) => {
      data.infos.push(message);
      return data.infoAnswer;
    }),
    showError: vi.fn((message: string) => void data.errors.push(message)),
    openFile: vi.fn(async (uri: vscode.Uri) => void data.opened.push(uri.toString())),
    writeClipboard: vi.fn(async (text: string) => {
      if (data.clipboardError) throw data.clipboardError;
      data.clipboard.push(text);
    }),
    setStatusBarMessage: vi.fn((text: string, ms: number) => void data.statusBar.push({ text, ms })),
    showQuickPick: vi.fn(async (items: vscode.QuickPickItem[], options: vscode.QuickPickOptions) => {
      data.picks.push({ items, options });
      return data.pick?.(items);
    }) as ReportUi['showQuickPick'],
    folderOf: vi.fn(() => data.folder),
  };
  return { ui, data };
}
