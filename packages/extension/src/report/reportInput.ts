import * as vscode from 'vscode';
import { parseWorkflowText, type RunReportInput, type RunView } from '@isar-flow/core';
import type { ModelRegistry, ReviewService, RunHistory, RunManager, WorkflowStore } from '../contracts';
import { fileNameOf } from '../editors/files';

/** The services a run report is built from. */
export interface ReportSources {
  runs: Pick<RunManager, 'active'> & {
    history: Pick<RunHistory, 'list' | 'get' | 'getAsync'>;
    reviews?: Pick<ReviewService, 'get'>;
  };
  workflows: Pick<WorkflowStore, 'list'>;
  models: Pick<ModelRegistry, 'catalog'>;
}

export interface GatherOptions {
  /** The final view when the caller has it (Copilot waits for the run); else it is read from the history. */
  view?: RunView;
  /** Workflow of the run when the history has no record of it. */
  workflowUri?: string;
  /** Reads the workflow file (an open editor's text first). */
  readText(uri: vscode.Uri): Promise<string>;
}

export interface GatheredReport {
  input: RunReportInput;
  workflowUri?: string;
}

/**
 * Everything the report generator gets for a saved run: the view, the workflow as it is now (block names and
 * order), its record, the review and the prices. Undefined when the run is not in the history.
 */
export async function gatherReportInput(
  sources: ReportSources,
  runId: string,
  options: GatherOptions,
): Promise<GatheredReport | undefined> {
  const { history, reviews } = sources.runs;
  const record = history.list().find((entry) => entry.runId === runId);
  const run = options.view ?? history.get(runId) ?? (await history.getAsync(runId).catch(() => undefined));
  if (!run) return undefined;

  const input: RunReportInput = { run };
  const workflowUri = record?.workflowUri ?? options.workflowUri;
  if (workflowUri !== undefined) {
    const uri = vscode.Uri.parse(workflowUri);
    // The file may be gone or broken by now; the report then names blocks by their ids.
    const text = await options.readText(uri).catch(() => undefined);
    const workflow = text === undefined ? null : parseWorkflowText(text).workflow;
    if (workflow) input.workflow = workflow;
    input.workflowPath =
      sources.workflows.list().find((summary) => summary.uri === workflowUri)?.relativePath ??
      fileNameOf(uri);
  }
  if (record) input.record = record;
  // A review is missing when the run changed nothing or its data was pruned with older runs.
  input.review = (await reviews?.get(runId).catch(() => undefined)) ?? null;
  const { prices } = sources.models.catalog();
  if (prices) input.prices = prices;
  return workflowUri === undefined ? { input } : { input, workflowUri };
}
