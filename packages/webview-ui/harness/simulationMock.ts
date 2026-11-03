/**
 * The workflow's simulation file in the mock host: kept in memory, checked against the current workflow and edited
 * with the real core ops, like the extension's simulation store.
 */
import {
  checkSimulationText,
  renameSimulationBlock,
  setSimulationResults,
  type HostToWorkflowEditor,
  type SimulationFile,
  type SimulationResult,
  type Workflow,
} from '@isar-flow/core';
import { isEverydayScenario } from './everydayScenarios';
import {
  RELEASE_SIMULATION_PATH,
  RELEASE_SIMULATION_TEXT,
  SIMULATION_BROKEN_TEXT,
  SIMULATION_ERRORS_TEXT,
  SIMULATION_TEXT,
} from './fixtures';
import { probe, type Send } from './mockShared';

export const SIMULATION_PATH = '.isarflow/simulations/review-loop.sim.yaml';

function initialText(scenario: string): string {
  if (isEverydayScenario(scenario)) return RELEASE_SIMULATION_TEXT;
  if (scenario === 'simulation-errors') return SIMULATION_ERRORS_TEXT;
  if (scenario === 'simulation-broken') return SIMULATION_BROKEN_TEXT;
  return SIMULATION_TEXT;
}

export function simulationMock(scenario: string, send: Send<HostToWorkflowEditor>) {
  let text = initialText(scenario);
  const path = isEverydayScenario(scenario) ? RELEASE_SIMULATION_PATH : SIMULATION_PATH;
  let opened = 0;
  probe.simulationText = () => text;
  probe.openedSimulation = () => opened;

  const sendState = (workflow: Workflow | null) => {
    const { file, diagnostics } = checkSimulationText(text, workflow);
    send({ type: 'simulation', simulation: { path, exists: true, file, diagnostics } });
  };

  return {
    sendState,
    setMocks(stepId: string, results: SimulationResult[] | null, workflow: Workflow | null) {
      try {
        text = setSimulationResults(text, stepId, results);
      } catch (error) {
        // The extension shows this as an error message; the file stays as it is.
        console.info('[mock host] Could not save the simulation mocks:', (error as Error).message);
      }
      sendState(workflow);
    },
    /** Renamed blocks keep their mocks, as the extension does after a renameStep op. */
    rename(oldId: string, newId: string) {
      text = renameSimulationBlock(text, oldId, newId);
    },
    open() {
      opened += 1;
    },
    /** The mocks Simulate uses, or the first error that stops it. */
    load(workflow: Workflow | null): { file: SimulationFile } | { error: string } {
      const { file, diagnostics } = checkSimulationText(text, workflow);
      const error = diagnostics.find((d) => d.severity === 'error');
      return error ? { error: `Fix ${path} before simulating: ${error.message}` } : { file };
    },
  };
}
