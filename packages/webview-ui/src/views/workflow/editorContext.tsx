/** Derived editor data shared by the palette, canvas and top bar: the shown workflow and its canvas model. */
import { createContext, type ReactNode, useContext, useMemo } from 'react';
import type { Workflow } from '@isar-flow/core';
import { buildCanvasModel, type CanvasModel } from './canvas/model';
import type { PlannedEdit } from './canvas/ops';
import { useWorkflowActions, useWorkflowState } from './store';

export interface EditorContextValue {
  /** Workflow shown on the canvas: the current one, or the last readable one while the YAML has a syntax error. */
  workflow: Workflow | null;
  model: CanvasModel;
  /** True while the YAML cannot be read; the canvas then shows `workflow` dimmed and read-only. */
  stale: boolean;
  editable: boolean;
  /** Sends the edit's ops and selects the block it names. */
  edit(plan: PlannedEdit): void;
}

const EditorContext = createContext<EditorContextValue | null>(null);

export function EditorProvider({ children }: { children: ReactNode }) {
  const { doc, lastWorkflow } = useWorkflowState();
  const actions = useWorkflowActions();
  const current = doc?.workflow ?? null;
  const workflow = current ?? lastWorkflow ?? null;
  const stale = doc !== null && current === null;
  const model = useMemo(() => buildCanvasModel(workflow), [workflow]);

  const value = useMemo<EditorContextValue>(
    () => ({
      workflow,
      model,
      stale,
      editable: !stale && workflow !== null,
      edit: (plan) => {
        if (!plan.ops.length) return;
        actions.applyOps(plan.ops);
        if (plan.select) actions.select(plan.select);
      },
    }),
    [workflow, model, stale, actions],
  );

  return <EditorContext.Provider value={value}>{children}</EditorContext.Provider>;
}

export function useEditor(): EditorContextValue {
  const value = useContext(EditorContext);
  if (!value) throw new Error('useEditor must be used inside EditorProvider');
  return value;
}
