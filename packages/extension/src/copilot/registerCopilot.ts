import * as vscode from 'vscode';
import type { Services } from '../contracts';
import { CHAT_PARTICIPANT_ID, type ChatHandler, createChatHandler } from './chatParticipant';
import { type CopilotDeps, type CopilotServices, vscodeCopilotDeps } from './copilotRun';
import {
  createListWorkflowsTool,
  createRunWorkflowTool,
  LIST_WORKFLOWS_TOOL,
  RUN_WORKFLOW_TOOL,
  type RunWorkflowInput,
} from './tools';

const NO_CHAT = 'Copilot tools and @isarflow need VS Code with chat support; they are turned off.';

/** The registered tools and chat handler, also reachable through the extension API (integration tests). */
export interface CopilotRegistration extends vscode.Disposable {
  readonly listWorkflows: vscode.LanguageModelTool<Record<string, never>>;
  readonly runWorkflow: vscode.LanguageModelTool<RunWorkflowInput>;
  readonly chat: ChatHandler;
}

/**
 * Copilot integration through VS Code's own APIs only: the language model tools `isarflow_listWorkflows` /
 * `isarflow_runWorkflow` and the chat participant `@isarflow`. Only workflows with `expose: true` can be run, and
 * the user confirms each run.
 */
export function registerCopilot(
  services: CopilotServices & Pick<Services, 'context' | 'output'>,
  deps: CopilotDeps = vscodeCopilotDeps,
): CopilotRegistration {
  const listWorkflows = createListWorkflowsTool(services, deps);
  const runWorkflow = createRunWorkflowTool(services, deps);
  const chat = createChatHandler(services, deps);
  const disposables: vscode.Disposable[] = [];

  // Older or stripped-down hosts lack these APIs; the rest of the extension works without them.
  const lm = vscode.lm as Partial<typeof vscode.lm> | undefined;
  const chatApi = vscode.chat as Partial<typeof vscode.chat> | undefined;
  if (typeof lm?.registerTool === 'function') {
    disposables.push(
      lm.registerTool(LIST_WORKFLOWS_TOOL, listWorkflows),
      lm.registerTool(RUN_WORKFLOW_TOOL, runWorkflow),
    );
  }
  if (typeof chatApi?.createChatParticipant === 'function') {
    const participant = chatApi.createChatParticipant(
      CHAT_PARTICIPANT_ID,
      (request, _context, stream, token) => chat(request, stream, token),
    );
    participant.iconPath = vscode.Uri.joinPath(services.context.extensionUri, 'media', 'icon.png');
    disposables.push(participant);
  }
  if (disposables.length === 0) services.output.info(NO_CHAT);

  return {
    listWorkflows,
    runWorkflow,
    chat,
    dispose: () => {
      for (const disposable of disposables.splice(0)) disposable.dispose();
    },
  };
}
