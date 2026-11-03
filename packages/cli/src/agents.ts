import fs from 'node:fs';
import path from 'node:path';
import { type AgentDefinition, parseAgentText } from '@isar-flow/core';
import { displayPath, formatDiagnostic } from './diagnostics';
import { readTextFile } from './files';

const AGENT_FILE = /\.agent\.ya?ml$/i;

/**
 * The agent files of the workspace (`<root>/.isarflow/agents/<id>.agent.yaml`), by id. Invalid files are skipped
 * with a warning line; the first of two files with the same id wins.
 */
export async function loadAgents(
  root: string,
  cwd: string,
): Promise<{ agents: Record<string, AgentDefinition>; warnings: string[] }> {
  const folder = path.join(root, '.isarflow', 'agents');
  let names: string[];
  try {
    names = (await fs.promises.readdir(folder)).filter((name) => AGENT_FILE.test(name)).sort();
  } catch {
    return { agents: {}, warnings: [] };
  }
  const agents: Record<string, AgentDefinition> = {};
  const fileOf: Record<string, string> = {};
  const warnings: string[] = [];
  for (const name of names) {
    const id = name.replace(AGENT_FILE, '');
    if (id === '') continue;
    const file = path.join(folder, name);
    const display = displayPath(file, cwd);
    const skip = (reason: string) => warnings.push(`${display} warning Skipped this agent: ${reason}`);
    if (Object.hasOwn(agents, id)) {
      skip(`${fileOf[id]} has the same id '${id}'.`);
      continue;
    }
    const text = await readTextFile(file);
    if (text === undefined) continue;
    const parsed = parseAgentText(text);
    if (!parsed.agent || !parsed.valid) {
      const error = parsed.diagnostics.find((d) => d.severity === 'error');
      warnings.push(
        error
          ? formatDiagnostic(
              display,
              { ...error, severity: 'warning' },
              `Skipped this agent: ${error.message}`,
            )
          : `${display} warning Skipped this agent: it has no agent in it.`,
      );
      continue;
    }
    agents[id] = parsed.agent;
    fileOf[id] = name;
  }
  return { agents, warnings };
}
