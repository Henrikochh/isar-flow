import {
  listBlocks,
  parseWorkflowText,
  triggerSummaries,
  type Workflow,
  type WorkflowSummary,
  workflowUsesRoot,
} from '@isar-flow/core';
import { baseName, fileId } from './paths';

export interface WorkflowRecord {
  /** Summary without `lastRun`, which comes from the run history when listing. */
  summary: Omit<WorkflowSummary, 'lastRun'>;
  /** Agent ids referenced by agent blocks (`agent: <id>`), sorted and unique. */
  agents: string[];
}

/** Agent ids referenced by name anywhere in the workflow, nested blocks included. */
export function agentReferences(workflow: Workflow | null): string[] {
  if (!workflow) return [];
  const ids = new Set<string>();
  for (const { step } of listBlocks(workflow)) {
    if (step.type === 'agent' && typeof step.agent === 'string' && step.agent !== '') ids.add(step.agent);
  }
  return [...ids].sort();
}

export function summarizeWorkflow(text: string, uri: string, relativePath: string): WorkflowRecord {
  const parsed = parseWorkflowText(text);
  const workflow = parsed.workflow as (Workflow & Record<string, unknown>) | null;
  const fileName = baseName(relativePath);
  const name =
    typeof workflow?.name === 'string' && workflow.name.trim() !== ''
      ? workflow.name
      : (fileId(fileName, 'workflow') ?? fileName);
  const summary: WorkflowRecord['summary'] = {
    uri,
    name,
    relativePath,
    valid: parsed.valid,
    stepCount: workflow ? listBlocks(workflow).length : 0,
  };
  if (typeof workflow?.description === 'string' && workflow.description.trim() !== '') {
    summary.description = workflow.description;
  }
  // From the lenient model, so the sidebar and the canvas show them also while the file has problems.
  if (workflow?.expose === true) summary.exposed = true;
  const triggers = triggerSummaries(workflow?.on);
  if (triggers.length > 0) summary.triggers = triggers;
  if (workflowUsesRoot(workflow, 'editor')) summary.usesEditor = true;
  return { summary, agents: agentReferences(workflow) };
}

/** Relative paths of the workflows that reference the agent id, sorted. */
export function usersOfAgent(records: Iterable<WorkflowRecord>, agentId: string): string[] {
  const paths: string[] = [];
  for (const record of records) {
    if (record.agents.includes(agentId)) paths.push(record.summary.relativePath);
  }
  return paths.sort();
}
