/** Per-render data every canvas block needs, computed once per state change. */
import { createContext, type ReactNode, useContext, useMemo } from 'react';
import type { AgentSummary, Diagnostic, ModelPrices, RunView } from '@isar-flow/core';
import { useEditor } from '../editorContext';
import { useWorkflowActions, useWorkflowState } from '../store';

export interface CanvasData {
  selection: string | null;
  /** Card that is reachable with Tab (roving tabindex): the selection, else the first block. */
  tabStop: string | null;
  select(id: string | null): void;
  run: RunView | null;
  problems: Map<string, Diagnostic[]>;
  agents: Map<string, AgentSummary>;
  /** `isarFlow.modelPrices`, for cost estimates on the cards. */
  prices: ModelPrices | undefined;
  /** Blocks waiting for an approval decision. */
  awaitingApproval: Set<string>;
  /** Opens the block menu, at the pointer when `at` is given, else below the block's card. */
  openMenu(stepId: string, at?: { x: number; y: number }): void;
}

const CanvasContext = createContext<CanvasData | null>(null);

export function CanvasDataProvider({
  children,
  openMenu,
}: {
  children: ReactNode;
  openMenu: CanvasData['openMenu'];
}) {
  const state = useWorkflowState();
  const { select } = useWorkflowActions();
  const { model } = useEditor();

  const problems = useMemo(() => {
    const map = new Map<string, Diagnostic[]>();
    for (const d of state.doc?.diagnostics ?? []) {
      if (!d.stepId || d.severity === 'info') continue;
      map.set(d.stepId, [...(map.get(d.stepId) ?? []), d]);
    }
    return map;
  }, [state.doc?.diagnostics]);

  const agents = useMemo(() => new Map(state.agents.map((a) => [a.id, a])), [state.agents]);
  const awaitingApproval = useMemo(() => new Set(state.approvals.map((a) => a.stepId)), [state.approvals]);
  const selection = state.selection;
  const tabStop = selection && model.byId.has(selection) ? selection : (model.order[0] ?? null);

  const prices = state.catalog.prices;
  const value = useMemo<CanvasData>(
    () => ({
      selection,
      tabStop,
      select,
      run: state.run,
      problems,
      agents,
      prices,
      awaitingApproval,
      openMenu,
    }),
    [selection, tabStop, select, state.run, problems, agents, prices, awaitingApproval, openMenu],
  );
  return <CanvasContext.Provider value={value}>{children}</CanvasContext.Provider>;
}

export function useCanvas(): CanvasData {
  const value = useContext(CanvasContext);
  if (!value) throw new Error('useCanvas must be used inside CanvasDataProvider');
  return value;
}
