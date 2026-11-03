import * as vscode from 'vscode';

/** View type of the workflow editor (custom editor). */
export const WORKFLOW_EDITOR_VIEW_TYPE = 'isarFlow.workflowEditor';
export const OPEN_WORKFLOW_BUTTON = 'Open workflow';

/** Opens the workflow in its visual editor, which then shows open approvals and questions inline. */
export function openWorkflowEditor(workflowUri: string): Thenable<unknown> {
  return vscode.commands.executeCommand(
    'vscode.openWith',
    vscode.Uri.parse(workflowUri),
    WORKFLOW_EDITOR_VIEW_TYPE,
  );
}

/** "2 min", "45 s", "1 h 30 min": how long is left to answer. */
export function formatTimeLeft(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`;
}

/** The error a withdrawn question or approval rejects with; keeps the message of an Error reason (timeouts). */
export function abortError(reason?: unknown, fallback = 'The question was withdrawn.'): Error {
  const error = new Error(reason instanceof Error ? reason.message : fallback);
  error.name = 'AbortError';
  return error;
}
