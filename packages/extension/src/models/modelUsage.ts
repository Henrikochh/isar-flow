import {
  type AgentDefinition,
  type AgentSettings,
  type AgentSummary,
  listBlocks,
  type SetupFix,
  type ToolMode,
  type Workflow,
} from '@isar-flow/core';

/** A parsed workflow file, as the setup check reads it. */
export interface UsageWorkflow {
  uri: string;
  name: string;
  relativePath: string;
  workflow: Workflow;
}

/** An agent file or inline agent that runs a model; its Tool calls setting decides about text tool mode. */
export interface AgentTarget {
  name: string;
  toolMode?: ToolMode;
  /** Agents without tools work with any model, so their Tool calls setting does not matter. */
  usesTools: boolean;
  /** Opens the agent (or the workflow of an inline agent) where Tool calls can be changed. */
  fix: SetupFix;
}

export interface ModelUse {
  ref: string;
  /** Workflow paths, then agent ids. */
  usedBy: string[];
  targets: AgentTarget[];
}

interface Collected {
  workflows: Set<string>;
  agents: Set<string>;
  targets: Map<string, AgentTarget>;
}

const isRef = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '' && !value.includes('${{');

/**
 * The models the agent blocks of these workflows run: the block's model, else the agent's model, plus the
 * agent's fallback models. Templates (`${{ … }}`) are skipped because their value is known only in a run.
 */
export function modelUsage(
  workflows: UsageWorkflow[],
  agents: AgentSummary[],
  definitions: Record<string, AgentDefinition>,
): ModelUse[] {
  const uses = new Map<string, Collected>();
  const use = (
    ref: string,
    path: string,
    agentId: string | undefined,
    target: [string, AgentTarget] | undefined,
  ) => {
    const key = ref.trim();
    let entry = uses.get(key);
    if (!entry) {
      entry = { workflows: new Set(), agents: new Set(), targets: new Map() };
      uses.set(key, entry);
    }
    entry.workflows.add(path);
    if (agentId !== undefined) entry.agents.add(agentId);
    if (target && !entry.targets.has(target[0])) entry.targets.set(...target);
  };

  for (const file of workflows) {
    for (const { step } of listBlocks(file.workflow)) {
      if (step.type !== 'agent') continue;
      let agentId: string | undefined;
      let settings: AgentSettings | undefined;
      let target: [string, AgentTarget] | undefined;
      if (typeof step.agent === 'string') {
        agentId = step.agent;
        settings = Object.hasOwn(definitions, agentId) ? definitions[agentId] : undefined;
        const summary = agents.find((a) => a.id === agentId && !a.shadowed);
        if (settings && summary) {
          const name = definitions[agentId].name || agentId;
          target = [
            `agent:${agentId}`,
            agentTarget(name, settings, {
              label: `Open ${name}`,
              message: { type: 'openAgent', uri: summary.uri },
            }),
          ];
        }
      } else if (step.agent && typeof step.agent === 'object') {
        settings = step.agent;
        target = [
          `block:${file.uri}#${step.id}`,
          agentTarget(`block ${step.id} of ${file.relativePath}`, settings, {
            label: `Open ${file.name}`,
            message: { type: 'openWorkflow', uri: file.uri },
          }),
        ];
      }
      const model = step.model ?? settings?.model;
      if (isRef(model)) use(model, file.relativePath, agentId, target);
      for (const fallback of Array.isArray(settings?.fallbackModels) ? settings.fallbackModels : []) {
        if (isRef(fallback)) use(fallback, file.relativePath, agentId, target);
      }
    }
  }

  return [...uses.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([ref, entry]) => ({
      ref,
      usedBy: [...[...entry.workflows].sort(), ...[...entry.agents].sort()],
      targets: [...entry.targets.values()],
    }));
}

function agentTarget(name: string, settings: AgentSettings, fix: SetupFix): AgentTarget {
  const target: AgentTarget = {
    name,
    usesTools: Array.isArray(settings.tools) && settings.tools.length > 0,
    fix,
  };
  if (settings.toolMode !== undefined) target.toolMode = settings.toolMode;
  return target;
}
