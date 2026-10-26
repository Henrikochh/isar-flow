import type { AgentDefinition, AgentSettings, AgentStep } from '../schema/types';
import { StepSetupError } from './context';
import type { ResolvedAgent } from './types';

const SETTING_KEYS = [
  'fallbackModels',
  'systemPrompt',
  'temperature',
  'maxTokens',
  'maxTurns',
  'tools',
  'permissions',
] as const satisfies readonly (keyof AgentSettings)[];

/** Merges the referenced agent file or inline settings with the block's model override. */
export function resolveAgent(
  step: AgentStep,
  agents: Record<string, AgentDefinition>,
): { agentId?: string; agent: ResolvedAgent } {
  let agentId: string | undefined;
  let settings: AgentSettings = {};
  let name = step.id;
  if (typeof step.agent === 'string') {
    agentId = step.agent;
    const definition = Object.hasOwn(agents, agentId) ? agents[agentId] : undefined;
    if (!definition) {
      throw new StepSetupError(
        `Agent '${agentId}' not found. Create .isarflow/agents/${agentId}.agent.yaml or pick another agent.`,
      );
    }
    settings = definition;
    name = definition.name || agentId;
  } else if (step.agent) {
    settings = step.agent;
  }

  const model = step.model ?? settings.model;
  if (!model) {
    throw new StepSetupError(
      `No model set for block '${step.id}'. Choose a model on the block or on its agent.`,
    );
  }

  const agent: ResolvedAgent = { name, model };
  for (const key of SETTING_KEYS) {
    if (settings[key] !== undefined) Object.assign(agent, { [key]: settings[key] });
  }
  return agentId === undefined ? { agent } : { agentId, agent };
}
