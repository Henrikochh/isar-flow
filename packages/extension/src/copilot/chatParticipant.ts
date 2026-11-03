import * as vscode from 'vscode';
import {
  parseWorkflowText,
  type RunRecordSummary,
  runOriginText,
  type RunStatus,
  type Workflow,
} from '@isar-flow/core';
import { WORKFLOW_EDITOR_VIEW_TYPE } from '../editors/host';
import { SHOW_RUN_COMMAND } from '../editors/workflowEditor';
import { formatLocalTime } from '../report/formatTime';
import { blockLabel } from '../run/resumeWarnings';
import { parseRunPrompt } from './chatArgs';
import { type CopilotDeps, type CopilotServices, prepareCopilotRun, runForCopilot } from './copilotRun';
import { plainText } from './markdown';
import { loadCopilotWorkflows, workflowListMarkdown } from './workflowList';

export const CHAT_PARTICIPANT_ID = 'isarFlow.chat';

/** The parts of a chat request and response stream the handler uses (testable without a chat host). */
export interface ChatRequestLike {
  command?: string;
  prompt: string;
}
export type ChatStreamLike = Pick<vscode.ChatResponseStream, 'markdown' | 'progress' | 'button'>;
export type ChatHandler = (
  request: ChatRequestLike,
  stream: ChatStreamLike,
  token: vscode.CancellationToken,
) => Promise<vscode.ChatResult>;

const RECENT_RUNS = 5;

const STATUS_WORDS: Record<RunStatus, string> = {
  success: 'succeeded',
  failure: 'failed',
  cancelled: 'cancelled',
  running: 'running',
};

const HELP = [
  'I run the Isar Flow workflows of this workspace here in VS Code.',
  '',
  '- `/list`: list the workflows Copilot may run',
  '- `/run <workflow> [name=value …]`: run one and show its summary',
  '- `/status`: show running and recent runs',
].join('\n');

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

const showRunButton = (title: string, workflowUri: string, runId: string): vscode.Command => ({
  command: SHOW_RUN_COMMAND,
  title,
  arguments: [workflowUri, runId],
});

/**
 * `@isarflow`: `/list`, `/run <workflow> [name=value …]`, `/status`, and a short help without a command. It
 * answers from the workspace only (no model calls) and runs exposed workflows like the Copilot tool.
 */
export function createChatHandler(services: CopilotServices, deps: CopilotDeps): ChatHandler {
  const listMarkdown = async () =>
    loadCopilotWorkflows(services.workflows.list(), (uri) => deps.readText(uri));

  const readWorkflow = async (workflowUri: string): Promise<Workflow | null> => {
    const text = await deps.readText(vscode.Uri.parse(workflowUri)).catch(() => undefined);
    return text === undefined ? null : parseWorkflowText(text).workflow;
  };

  const list = async (stream: ChatStreamLike): Promise<vscode.ChatResult> => {
    const workflows = await listMarkdown();
    stream.markdown(workflowListMarkdown(workflows));
    for (const { summary } of workflows.available) {
      stream.button({
        command: 'vscode.openWith',
        title: `Open ${summary.name}`,
        arguments: [vscode.Uri.parse(summary.uri), WORKFLOW_EDITOR_VIEW_TYPE],
      });
    }
    return { metadata: { command: 'list' } };
  };

  const run = async (
    prompt: string,
    stream: ChatStreamLike,
    token: vscode.CancellationToken,
  ): Promise<vscode.ChatResult> => {
    const failed = (message: string): vscode.ChatResult => ({
      errorDetails: { message },
      metadata: { command: 'run' },
    });
    const parsed = parseRunPrompt(prompt);
    if ('error' in parsed) return failed(parsed.error);
    try {
      const prepared = await prepareCopilotRun(services, deps, parsed.workflow, parsed.inputs);
      stream.progress(`Running ${prepared.name}…`);
      const result = await runForCopilot(services, deps, prepared, token, (event) => {
        if (event.type === 'step-start') {
          stream.progress(`Running block ${blockLabel(prepared.workflow, event.stepId)}…`);
        }
      });
      stream.markdown(result.text);
      stream.button(showRunButton('Open run', result.workflowUri, result.runId));
      const changed = (result.review?.files.length ?? 0) + (result.review?.omitted ?? 0);
      if (changed > 0) stream.button(showRunButton('Review changes', result.workflowUri, result.runId));
      return { metadata: { command: 'run', runId: result.runId } };
    } catch (error) {
      return failed(errorText(error));
    }
  };

  const recentLine = (record: RunRecordSummary) => {
    const facts = [STATUS_WORDS[record.status], formatLocalTime(record.startedAt)];
    if (record.simulated) facts.push('simulated');
    if (record.resumedFrom) facts.push('resumed');
    const origin = runOriginText(record.origin);
    if (origin) facts.push(origin.chip);
    return `- **${plainText(record.workflowName)}**: ${facts.join(', ')}`;
  };

  const status = async (stream: ChatStreamLike): Promise<vscode.ChatResult> => {
    const { runs } = services;
    const live = runs.active();
    const liveIds = new Set(live.map((entry) => entry.runId));
    const recent = runs.history
      .list()
      .filter((record) => record.status !== 'running' && !liveIds.has(record.runId))
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, RECENT_RUNS);
    const running = await Promise.all(
      live.map(async ({ workflowUri, view }) => {
        const workflow = view.activeStepId ? await readWorkflow(workflowUri) : null;
        const block = view.activeStepId
          ? `block ${plainText(workflow ? blockLabel(workflow, view.activeStepId) : view.activeStepId)}`
          : 'starting';
        return `- **${plainText(view.workflowName)}**: ${block}, started ${formatLocalTime(view.startedAt)}`;
      }),
    );
    stream.markdown(
      [
        '**Running**',
        '',
        ...(running.length > 0 ? running : ['Nothing is running.']),
        '',
        '**Recent runs**',
        '',
        ...(recent.length > 0 ? recent.map(recentLine) : ['No runs yet.']),
      ].join('\n'),
    );
    for (const { runId, workflowUri, view } of live) {
      stream.button(
        showRunButton(`Open ${view.workflowName} (${formatLocalTime(view.startedAt)})`, workflowUri, runId),
      );
    }
    for (const record of recent) {
      stream.button(
        showRunButton(
          `Open ${record.workflowName} (${formatLocalTime(record.startedAt)})`,
          record.workflowUri,
          record.runId,
        ),
      );
    }
    return { metadata: { command: 'status' } };
  };

  const help = async (stream: ChatStreamLike): Promise<vscode.ChatResult> => {
    stream.markdown(`${HELP}\n\n${workflowListMarkdown(await listMarkdown())}`);
    return { metadata: { command: 'help' } };
  };

  return async (request, stream, token) => {
    switch (request.command) {
      case 'list':
        return list(stream);
      case 'run':
        return run(request.prompt, stream, token);
      case 'status':
        return status(stream);
      default:
        return help(stream);
    }
  };
}
