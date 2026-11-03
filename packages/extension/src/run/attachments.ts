import * as vscode from 'vscode';

export interface Attachments {
  /** Registers a visible editor of the workflow until the disposable is disposed (repeated disposes are ignored). */
  attach(workflowUri: string): vscode.Disposable;
  isAttached(workflowUri: string): boolean;
  clear(): void;
}

/**
 * Counts the visible workflow editors per workflow. `onAttached` runs when the first editor of a workflow
 * attaches, `onDetached` when the last one goes.
 */
export function createAttachments(
  onAttached: (workflowUri: string) => void,
  onDetached: (workflowUri: string) => void,
): Attachments {
  const counts = new Map<string, number>();
  return {
    attach(workflowUri) {
      const count = (counts.get(workflowUri) ?? 0) + 1;
      counts.set(workflowUri, count);
      if (count === 1) onAttached(workflowUri);
      let disposed = false;
      return new vscode.Disposable(() => {
        if (disposed) return;
        disposed = true;
        const left = (counts.get(workflowUri) ?? 1) - 1;
        if (left > 0) {
          counts.set(workflowUri, left);
          return;
        }
        counts.delete(workflowUri);
        onDetached(workflowUri);
      });
    },
    isAttached: (workflowUri) => (counts.get(workflowUri) ?? 0) > 0,
    clear: () => counts.clear(),
  };
}
