/**
 * Data for live values and the Simulation section: the simulation file's state and the last finished run's
 * expression context, both pushed by the host. Mounted inside the workflow store so it subscribes to host
 * messages before 'ready' goes out.
 */
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react';
import {
  type HostToWorkflowEditor,
  type LiveContext,
  liveContext,
  type RunView,
  type SimulationResult,
  type SimulationState,
  type WorkflowEditorToHost,
} from '@isar-flow/core';
import { post, useHostMessages } from '../../../vscode';
import { useWorkflowState } from '../store';

export interface LiveData {
  simulation: SimulationState | null;
  /** The newest finished run of this workflow, used while the canvas shows no run. */
  lastRunContext: LiveContext | null;
  /** Replaces a block's mocks (null removes them); shown at once, before the host answers. */
  setSimulationMocks(stepId: string, results: SimulationResult[] | null): void;
  openSimulationFile(): void;
}

export type LiveSource = 'shown' | 'last';

export interface LiveSnapshot {
  context: LiveContext;
  /** 'shown': the run on the canvas ("This run"); 'last': the newest finished run ("Last run"). */
  source: LiveSource;
}

const NONE: LiveData = {
  simulation: null,
  lastRunContext: null,
  setSimulationMocks: () => {},
  openSimulationFile: () => {},
};

const LiveDataContext = createContext<LiveData>(NONE);

const send = (message: WorkflowEditorToHost) => post(message);

function withMocks(
  state: SimulationState,
  stepId: string,
  results: SimulationResult[] | null,
): SimulationState {
  const blocks = { ...state.file.blocks };
  if (results && results.length) blocks[stepId] = results;
  else delete blocks[stepId];
  return { ...state, file: { ...state.file, blocks } };
}

export function LiveDataProvider({ children }: { children: ReactNode }) {
  const [simulation, setSimulation] = useState<SimulationState | null>(null);
  const [lastRunContext, setLastRunContext] = useState<LiveContext | null>(null);
  useHostMessages<HostToWorkflowEditor>((message) => {
    if (message.type === 'simulation') setSimulation(message.simulation);
    else if (message.type === 'lastRunContext') setLastRunContext(message.context);
  });

  const setSimulationMocks = useCallback((stepId: string, results: SimulationResult[] | null) => {
    send({ type: 'setSimulationMocks', stepId, results });
    setSimulation((state) => (state ? withMocks(state, stepId, results) : state));
  }, []);
  const openSimulationFile = useCallback(() => send({ type: 'openSimulationFile' }), []);

  const value = useMemo<LiveData>(
    () => ({ simulation, lastRunContext, setSimulationMocks, openSimulationFile }),
    [simulation, lastRunContext, setSimulationMocks, openSimulationFile],
  );
  return <LiveDataContext.Provider value={value}>{children}</LiveDataContext.Provider>;
}

export function useLiveData(): LiveData {
  return useContext(LiveDataContext);
}

/** One context per run snapshot, shared by every template that asks for it. */
const contexts = new WeakMap<RunView, LiveContext>();

export function liveContextFor(run: RunView): LiveContext {
  let context = contexts.get(run);
  if (!context) {
    context = liveContext(run);
    contexts.set(run, context);
  }
  return context;
}

/** Values for templates: the run the canvas shows, else the last finished run; null when there is neither. */
export function useLiveContext(): LiveSnapshot | null {
  const { run } = useWorkflowState();
  const { lastRunContext } = useLiveData();
  return useMemo<LiveSnapshot | null>(() => {
    if (run) return { context: liveContextFor(run), source: 'shown' };
    return lastRunContext ? { context: lastRunContext, source: 'last' } : null;
  }, [run, lastRunContext]);
}

/** Where values would come from, without building the shown run's context (for hover targets). */
export function useLiveSource(): LiveSource | null {
  const { run } = useWorkflowState();
  const { lastRunContext } = useLiveData();
  return run ? 'shown' : lastRunContext ? 'last' : null;
}
