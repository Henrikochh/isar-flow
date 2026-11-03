import * as vscode from 'vscode';
import {
  parseWorkflowText,
  type RunEvent,
  runReportFileName,
  runReportMarkdown,
  type RunReview,
  type RunView,
  type Workflow,
} from '@isar-flow/core';
import type { AgentStore, RunManager, RunRefusal, WorkflowStore } from '../contracts';
import { formatLocalTime } from '../report/formatTime';
import { gatherReportInput, type ReportSources } from '../report/reportInput';
import { type ReportGenerator, vscodeReportUi } from '../report/runReport';
import { unattendedAgentsOf } from '../run/commandApproval';
import { checkInputs } from './inputs';
import { lookupWorkflow, unavailableMessage } from './lookup';

const UNTRUSTED =
  'Isar Flow runs workflows only in trusted workspaces. Trust this workspace, then try again.';
const CANCELLED = 'Cancelled before the run started.';

/** The services Copilot runs use. */
export type CopilotServices = ReportSources & {
  workflows: Pick<WorkflowStore, 'list'>;
  runs: ReportSources['runs'] & Pick<RunManager, 'start' | 'cancel' | 'onEvent' | 'whenFinished'>;
  /** Agent files, so the confirmation can name agents that act without asking. */
  agents?: Pick<AgentStore, 'definitions'>;
};

/** Window and file access of the Copilot tools and the chat participant; injected in tests. */
export interface CopilotDeps {
  /** Text of a file, an open editor's (unsaved) text first. */
  readText(uri: vscode.Uri): Promise<string>;
  isTrusted(): boolean;
  /** Report generator; default core's runReportMarkdown. */
  generator?: ReportGenerator;
}

export const vscodeCopilotDeps: CopilotDeps = {
  readText: (uri) => vscodeReportUi.readText(uri),
  isTrusted: () => vscode.workspace.isTrusted,
};

/** A workflow Copilot asked for: exposed (in the index and in its current text), inputs checked. */
export interface PreparedCopilotRun {
  uri: vscode.Uri;
  name: string;
  relativePath: string;
  workflow: Workflow;
  inputs: Record<string, unknown>;
  /** Agents that edit files or run commands without asking (see unattendedAgentsOf). */
  unattendedAgents: string[];
}

export interface CopilotRunResult {
  runId: string;
  view: RunView;
  /** The `chat` variant of the run report. */
  text: string;
  review: RunReview | null;
  workflowUri: string;
}

/**
 * Finds the exposed workflow `query` names and checks `inputs` against its current file. Throws an Error with a
 * message for Copilot or the chat (unknown, not exposed, ambiguous, unreadable, wrong inputs).
 */
export async function prepareCopilotRun(
  services: Pick<CopilotServices, 'workflows' | 'agents'>,
  deps: CopilotDeps,
  query: string,
  inputs: unknown,
): Promise<PreparedCopilotRun> {
  const found = lookupWorkflow(services.workflows.list(), query);
  if (found.kind !== 'found') throw new Error(found.message);
  const { summary } = found;
  const uri = vscode.Uri.parse(summary.uri);
  let text: string;
  try {
    text = await deps.readText(uri);
  } catch (error) {
    throw new Error(
      `Could not read ${summary.relativePath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const { workflow } = parseWorkflowText(text);
  // The index can lag behind an edit that just removed `expose: true`; the file decides.
  if (!workflow || workflow.expose !== true) throw new Error(unavailableMessage(query.trim()));
  const name =
    typeof workflow.name === 'string' && workflow.name.trim() !== '' ? workflow.name : summary.name;
  return {
    uri,
    name,
    relativePath: summary.relativePath,
    workflow,
    inputs: checkInputs({ ...workflow, name }, inputs),
    unattendedAgents: unattendedAgentsOf(workflow, services.agents?.definitions() ?? {}),
  };
}

/**
 * Starts the run as Copilot (never simulated or resumed; the command confirmation still applies), stops it when
 * `token` is cancelled and resolves with its chat report once it has ended. Refusals become the Error.
 */
export async function runForCopilot(
  services: CopilotServices,
  deps: CopilotDeps,
  prepared: PreparedCopilotRun,
  token: vscode.CancellationToken,
  onEvent?: (event: RunEvent) => void,
): Promise<CopilotRunResult> {
  if (!deps.isTrusted()) throw new Error(UNTRUSTED);
  if (token.isCancellationRequested) throw new Error(CANCELLED);
  const { runs } = services;
  const workflowUri = prepared.uri.toString();
  let runId: string | undefined;
  let refusal: RunRefusal | undefined;
  const events = runs.onEvent(({ workflowUri: uri, event }) => {
    if (uri !== workflowUri) return;
    // Events of the new run can arrive before start() resolves with its id.
    if (runId === undefined && event.type === 'run-start') runId = event.runId;
    if (event.runId === runId) onEvent?.(event);
  });
  let cancellation: vscode.Disposable | undefined;
  try {
    const started = await runs.start(prepared.uri, prepared.inputs, {
      origin: { kind: 'copilot' },
      onRefused: (reason) => {
        refusal = reason;
      },
    });
    if (started === undefined) throw new Error(refusal?.message ?? `${prepared.name} did not start.`);
    runId = started;
    cancellation = token.onCancellationRequested(() => runs.cancel(started));
    if (token.isCancellationRequested) runs.cancel(started);
    const view = (await runs.whenFinished?.(started)) ?? (await runs.history.getAsync(started));
    if (!view) throw new Error(`${prepared.name} ended, but its result could not be read.`);
    const gathered = await gatherReportInput(services, started, {
      view,
      workflowUri,
      readText: (uri) => deps.readText(uri),
    });
    const input = gathered?.input ?? { run: view };
    const generator = deps.generator ?? { markdown: runReportMarkdown, fileName: runReportFileName };
    const text = generator.markdown(input, { variant: 'chat', formatTime: formatLocalTime });
    return { runId: started, view, text, review: input.review ?? null, workflowUri };
  } finally {
    events.dispose();
    cancellation?.dispose();
  }
}
