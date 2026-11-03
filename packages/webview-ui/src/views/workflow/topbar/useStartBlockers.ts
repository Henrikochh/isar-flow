import { useEditor } from '../editorContext';
import { useWorkflowState } from '../store';

/** Why the workflow cannot run right now, or null when it can. */
export function runBlocker(
  trusted: boolean,
  valid: boolean,
  readable: boolean,
  problems: number,
  blocks: number,
): string | null {
  if (!trusted) return 'Running is disabled until you trust this workspace.';
  if (!readable) return "Fix the YAML first: the file can't be read.";
  if (!valid)
    return problems === 1
      ? 'Fix the problem before running.'
      : `Fix the ${problems} problems before running.`;
  if (blocks === 0) return 'Add a block before running.';
  return null;
}

/** Why Run and Simulate can't start now (null when they can). Simulations run nothing, so trust doesn't matter. */
export function useStartBlockers(): { run: string | null; simulate: string | null } {
  const { doc, trusted } = useWorkflowState();
  const { model } = useEditor();
  const errorCount = doc?.diagnostics.filter((d) => d.severity === 'error').length ?? 0;
  const blockerFor = (isTrusted: boolean) =>
    doc
      ? runBlocker(isTrusted, doc.valid, doc.workflow !== null, Math.max(1, errorCount), model.entries.length)
      : 'Loading the workflow…';
  return { run: blockerFor(trusted), simulate: blockerFor(true) };
}
