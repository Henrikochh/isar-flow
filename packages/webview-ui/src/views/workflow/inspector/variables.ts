import { useMemo } from 'react';
import {
  availableVariables,
  listBlocks,
  type OutputType,
  type StepType,
  type VariableInfo,
} from '@isar-flow/core';
import { useWorkflowState } from '../store';
import { isStepType } from './model';

export const GROUP_LABELS: Record<VariableInfo['group'], string> = {
  inputs: 'Inputs',
  steps: 'Blocks',
  loop: 'Loop',
  workflow: 'Workflow',
  env: 'Environment',
  run: 'Run',
  editor: 'Editor',
  git: 'Git',
};

/** Codicons of the groups captured from VS Code, so they stand out from workflow data. */
export const GROUP_ICONS: Partial<Record<VariableInfo['group'], string>> = {
  editor: 'code',
  git: 'git-branch',
};

export const TYPE_LABELS: Record<OutputType, string> = {
  string: 'text',
  number: 'number',
  boolean: 'yes/no',
  object: 'object',
  list: 'list',
  any: 'any',
};

/** Part of a block variable's label after the block id, e.g. `json.approved` for `review.json.approved`. */
export function variableKey(variable: VariableInfo): string {
  const id = variable.stepId;
  if (!id || !variable.label.startsWith(id)) return variable.label;
  const rest = variable.label.slice(id.length);
  return rest.startsWith('.') ? rest.slice(1) : rest;
}

/** Label shown in pickers: `tests › exitCode` for block outputs, the expression for everything else. */
export function variableLabel(variable: VariableInfo): string {
  return variable.stepId ? `${variable.stepId} › ${variableKey(variable)}` : variable.label;
}

export interface VariableScope {
  variables: VariableInfo[];
  /** Type of each block, for the stones in the picker. */
  blockTypes: Map<string, StepType>;
}

/** Variables readable inside block `stepId` (null = workflow level), memoized per document. */
export function useVariables(stepId: string | null): VariableScope {
  const workflow = useWorkflowState().doc?.workflow ?? null;
  return useMemo(() => {
    if (!workflow) return { variables: [], blockTypes: new Map() };
    const blockTypes = new Map<string, StepType>();
    for (const block of listBlocks(workflow)) {
      if (block.id && isStepType(block.step.type)) blockTypes.set(block.id, block.step.type);
    }
    return { variables: availableVariables(workflow, stepId), blockTypes };
  }, [workflow, stepId]);
}
