import * as vscode from 'vscode';
import { type RunRecordSummary, type RunReportAction, runOriginText, type RunStatus } from '@isar-flow/core';
import { uriArg } from '../commands/workflowCommands';
import type { Services } from '../contracts';
import { COPY_RUN_FOR_PR_COMMAND, EXPORT_RUN_REPORT_COMMAND } from './commandIds';
import { formatLocalTime } from './formatTime';
import type { ReportSources } from './reportInput';
import { type ReportGenerator, type ReportUi, runReport, vscodeReportUi } from './runReport';

/** `{ runId?, workflowUri?, target? }` or a run id. */
interface ReportArgs {
  runId?: string;
  workflowUri?: string;
  target?: vscode.Uri;
}

export interface ReportCommands {
  /** Resolves with the saved Markdown; undefined when nothing was saved. */
  exportRunReport(arg?: unknown): Promise<string | undefined>;
  /** Resolves with the copied Markdown; undefined when nothing was copied. */
  copyRunForPr(arg?: unknown): Promise<string | undefined>;
}

const STATUS_TEXT: Record<RunStatus, string> = {
  success: '$(pass) Succeeded',
  failure: '$(error) Failed',
  cancelled: '$(circle-slash) Cancelled',
  running: '$(sync~spin) Running',
};

const PLACEHOLDERS: Record<RunReportAction, string> = {
  export: 'Choose a run to export',
  copyForPr: 'Choose a run to copy for a pull request description',
};

const NO_RUNS: Record<RunReportAction, string> = {
  export: 'No finished runs yet. Run a workflow, then export its report.',
  copyForPr: 'No finished runs yet. Run a workflow, then copy its summary.',
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !(value instanceof vscode.Uri);

function reportArgs(arg: unknown): ReportArgs {
  if (typeof arg === 'string') return arg.trim() === '' ? {} : { runId: arg };
  if (!isRecord(arg)) return {};
  const args: ReportArgs = {};
  if (typeof arg.runId === 'string' && arg.runId !== '') args.runId = arg.runId;
  const workflow = uriArg(arg.workflowUri);
  if (workflow) args.workflowUri = workflow.toString();
  const target = uriArg(arg.target);
  if (target) args.target = target;
  return args;
}

/** "Succeeded  Copilot": status, then the simulated, resumed and origin marks of the run. */
function runDescription(record: RunRecordSummary): string {
  const parts = [STATUS_TEXT[record.status]];
  if (record.simulated) parts.push('$(beaker) Simulated');
  if (record.resumedFrom) parts.push('$(debug-continue) Resumed');
  const origin = runOriginText(record.origin);
  if (origin) parts.push(`$(${origin.icon}) ${origin.chip}`);
  return parts.join('  ');
}

export function createReportCommands(
  services: ReportSources,
  ui: ReportUi,
  generator?: ReportGenerator,
): ReportCommands {
  const { runs } = services;

  /** Finished runs (of one workflow when given), newest first; the user picks one. */
  const pickRun = async (action: RunReportAction, workflowUri: string | undefined) => {
    const live = new Set(runs.active().map((run) => run.runId));
    const finished = runs.history
      .list(workflowUri)
      .filter((record) => workflowUri === undefined || record.workflowUri === workflowUri)
      .filter((record) => record.status !== 'running' && !live.has(record.runId))
      .sort((a, b) => b.startedAt - a.startedAt);
    if (finished.length === 0) {
      void ui.showInfo(NO_RUNS[action]);
      return undefined;
    }
    const items = finished.map((record) => ({
      label: record.workflowName,
      description: runDescription(record),
      detail: formatLocalTime(record.startedAt),
      record,
    }));
    const picked = await ui.showQuickPick(items, {
      placeHolder: PLACEHOLDERS[action],
      matchOnDescription: true,
    });
    return picked?.record;
  };

  const report = async (action: RunReportAction, arg: unknown) => {
    const args = reportArgs(arg);
    const picked = args.runId === undefined ? await pickRun(action, args.workflowUri) : undefined;
    const runId = args.runId ?? picked?.runId;
    if (runId === undefined) return undefined;
    const workflowUri = args.workflowUri ?? picked?.workflowUri;
    return runReport(services, runId, action, {
      ui,
      ...(generator && { generator }),
      ...(workflowUri !== undefined && { workflowUri }),
      ...(args.target && { target: args.target }),
    });
  };

  return {
    exportRunReport: (arg) => report('export', arg),
    copyRunForPr: (arg) => report('copyForPr', arg),
  };
}

/** Registers Export run report and Copy run for PR description (`{ runId?, workflowUri?, target? }`). */
export function registerReportCommands(
  services: Pick<Services, 'runs' | 'workflows' | 'models' | 'output'>,
  ui: ReportUi = vscodeReportUi,
  generator?: ReportGenerator,
): vscode.Disposable {
  const commands = createReportCommands(services, ui, generator);
  const guarded =
    (name: string, handler: (arg?: unknown) => Promise<string | undefined>) =>
    async (arg?: unknown): Promise<string | undefined> => {
      try {
        return await handler(arg);
      } catch (error) {
        services.output.error(
          `${name} failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
        );
        ui.showError(error instanceof Error ? error.message : String(error));
        return undefined;
      }
    };
  return vscode.Disposable.from(
    vscode.commands.registerCommand(
      EXPORT_RUN_REPORT_COMMAND,
      guarded('Export run report', commands.exportRunReport),
    ),
    vscode.commands.registerCommand(
      COPY_RUN_FOR_PR_COMMAND,
      guarded('Copy run for PR description', commands.copyRunForPr),
    ),
  );
}
