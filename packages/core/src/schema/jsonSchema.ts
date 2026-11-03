import { z } from 'zod';
import { SimulationFileSchema } from './simulation';
import { AgentDefinitionSchema, WorkflowSchema } from './zod';

/** JSON Schema for `*.workflow.yaml`, contributed to the Red Hat YAML extension. */
export function workflowJsonSchema(): Record<string, unknown> {
  return {
    ...z.toJSONSchema(WorkflowSchema, { target: 'draft-7', unrepresentable: 'any' }),
    title: 'Isar Flow workflow',
  };
}

/** JSON Schema for `*.agent.yaml`. */
export function agentJsonSchema(): Record<string, unknown> {
  return {
    ...z.toJSONSchema(AgentDefinitionSchema, { target: 'draft-7', unrepresentable: 'any' }),
    title: 'Isar Flow agent',
  };
}

/** JSON Schema for `.isarflow/simulations/*.sim.yaml`. */
export function simulationJsonSchema(): Record<string, unknown> {
  return {
    ...z.toJSONSchema(SimulationFileSchema, { target: 'draft-7', unrepresentable: 'any' }),
    title: 'Isar Flow simulation mocks',
  };
}
