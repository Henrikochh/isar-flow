import * as vscode from 'vscode';
import type { PermissionAnswer, PermissionPrompt } from '../contracts';

/** Asks with a modal warning: Allow, Allow for this run, or Deny (also what closing the dialog means). */
export function createPermissionPrompt(): PermissionPrompt {
  return async (request) => {
    const answers = new Map<vscode.MessageItem, PermissionAnswer>([
      [{ title: 'Allow' }, 'allow'],
      [{ title: 'Allow for this run' }, 'allowRun'],
      [{ title: 'Deny', isCloseAffordance: true }, 'deny'],
    ]);
    const detail = [`The agent in block "${request.stepId}" asks for permission.`, request.detail]
      .filter((part) => part !== undefined && part !== '')
      .join('\n\n');
    const choice = await vscode.window.showWarningMessage(
      `${request.summary}?`,
      { modal: true, detail },
      ...answers.keys(),
    );
    return (choice && answers.get(choice)) ?? 'deny';
  };
}
