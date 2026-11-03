import type { AgentDefinition, ProjectConfig, SimulationFile, Workflow } from '@isar-flow/core';
import { loadAgents } from './agents';
import type { CliCommand } from './args';
import { loadProjectConfig } from './config';
import { displayPath } from './diagnostics';
import { CliError } from './errors';
import { readTextFile } from './files';
import { resolveCliInputs } from './inputs';
import type { CliIo } from './io';
import { readSecrets, referencedSecretNames } from './secrets';
import { loadSimulation } from './simulation';
import { checkWorkflow } from './workflow';
import { findWorkflowFile, findWorkspaceRoot, gitTopLevel } from './workspace';

export type RunCommand = Extract<CliCommand, { kind: 'run' }>;

const WORKTREE =
  "The command line can't run workflows in a separate worktree (isolation: worktree). Run it in VS Code, set " +
  'isolation: workspace to run it in the workspace folder, or try it with --simulate.';

/** Everything a run needs, read and checked before anything is executed. */
export interface PreparedRun {
  /** Absolute path of the workflow file. */
  file: string;
  /** Workspace folder: console blocks, agent tools and memory work here. */
  root: string;
  workflow: Workflow;
  agents: Record<string, AgentDefinition>;
  secrets: Record<string, string>;
  inputs: Record<string, unknown>;
  config: ProjectConfig;
  /** --simulate: the mocks, and the file they come from (none: block defaults). */
  simulation?: { file: SimulationFile; path?: string };
  /** Printable warning lines (workflow, agent files, inputs, simulation file). */
  warnings: string[];
}

/** Finds and checks the workflow, its agents, inputs, secrets and config. Throws a CliError for problems. */
export async function prepareRun(command: RunCommand, io: CliIo): Promise<PreparedRun> {
  const platform = io.platform ?? process.platform;
  const file = await findWorkflowFile(command.file, io.cwd);
  const root = await findWorkspaceRoot(file, io.cwd, io.gitTopLevel ?? gitTopLevel);
  const text = await readTextFile(file);
  if (text === undefined) {
    throw new CliError(`Could not find '${command.file}'. It was removed while starting.`);
  }

  const agents = await loadAgents(root, io.cwd);
  const secrets = readSecrets(io.env, referencedSecretNames(text), platform);
  const checked = checkWorkflow(text, displayPath(file, io.cwd), {
    agentIds: Object.keys(agents.agents),
    secretNames: Object.keys(secrets),
  });
  const { workflow } = checked;
  if (workflow.isolation === 'worktree' && !command.simulate) throw new CliError(WORKTREE);
  const inputs = resolveCliInputs(workflow, command.inputs);
  // A simulated run calls no models, so it needs no (valid) config.
  const config = command.simulate ? {} : (await loadProjectConfig(root, io.cwd)).config;
  const simulation = command.simulate ? await loadSimulation(root, file, workflow, io.cwd) : undefined;

  return {
    file,
    root,
    workflow,
    agents: agents.agents,
    secrets,
    inputs: inputs.inputs,
    config,
    ...(simulation && {
      simulation: { file: simulation.file, ...(simulation.path !== undefined && { path: simulation.path }) },
    }),
    warnings: [...agents.warnings, ...checked.warnings, ...inputs.warnings, ...(simulation?.warnings ?? [])],
  };
}
