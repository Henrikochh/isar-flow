import {
  type AgentDefinition,
  type AgentPermissions,
  type AgentScope,
  type AgentSummary,
  applyAgentUpdate,
  DEFAULT_AGENT_MODEL,
  defaultAgentText,
  isToolName,
  newAgentText,
  parseAgentText,
  type PermissionLevel,
  type ToolName,
} from '@isar-flow/core';
import type { AgentRecord } from '../contracts';
import { baseName, dirName, fileId, samePath } from './paths';

export type AgentKind = 'blank' | 'coder' | 'reviewer';

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value : undefined;

const LEVELS: readonly unknown[] = ['none', 'ask', 'auto'] satisfies PermissionLevel[];

/** The valid permission levels of the file (lenient: invalid values are left out); undefined when none. */
function permissionsOf(value: unknown): AgentPermissions | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const permissions: AgentPermissions = {};
  for (const key of ['edits', 'commands'] as const) {
    if (LEVELS.includes(raw[key])) permissions[key] = raw[key] as PermissionLevel;
  }
  return Object.keys(permissions).length ? permissions : undefined;
}

/** Parses an agent file into its sidebar summary and lenient definition. */
export function summarizeAgent(source: string, uri: string, scope: AgentScope, id: string): AgentRecord {
  const parsed = parseAgentText(source);
  const agent = parsed.agent as Partial<Record<keyof AgentDefinition, unknown>> | null;
  const tools: ToolName[] = [];
  if (Array.isArray(agent?.tools)) {
    for (const tool of agent.tools) {
      if (typeof tool === 'string' && isToolName(tool) && !tools.includes(tool)) tools.push(tool);
    }
  }
  const summary: AgentSummary = {
    id,
    name: text(agent?.name) ?? id,
    model: typeof agent?.model === 'string' ? agent.model : '',
    tools,
    scope,
    uri,
    valid: parsed.valid,
  };
  const permissions = permissionsOf(agent?.permissions);
  if (permissions) summary.permissions = permissions;
  const description = text(agent?.description);
  if (description !== undefined) summary.description = description;
  return { summary, definition: parsed.agent };
}

export interface AgentIndex {
  list: AgentSummary[];
  /** Valid definitions of the effective agent per id. */
  definitions: Record<string, AgentDefinition>;
  /** The effective agent per id, also when its file is invalid. */
  effective: Map<string, AgentRecord>;
}

const SCOPE_ORDER: Record<AgentScope, number> = { workspace: 0, user: 1 };

/**
 * Picks the effective agent per id: the first workspace agent, otherwise the first user agent (records come
 * in folder order). Every other agent with that id is flagged `shadowed`.
 */
export function buildAgentIndex(records: AgentRecord[]): AgentIndex {
  const effective = new Map<string, AgentRecord>();
  for (const scope of ['workspace', 'user'] as const) {
    for (const record of records) {
      if (record.summary.scope === scope && !effective.has(record.summary.id)) {
        effective.set(record.summary.id, record);
      }
    }
  }
  const list = records.map((record) => {
    const hidden = effective.get(record.summary.id) !== record;
    return hidden ? { ...record.summary, shadowed: true } : { ...record.summary };
  });
  list.sort(
    (a, b) =>
      SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope] ||
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) ||
      a.id.localeCompare(b.id),
  );
  const definitions = Object.fromEntries(
    [...effective.values()]
      .filter((record) => record.summary.valid && record.definition !== null)
      .map((record) => [record.summary.id, record.definition as AgentDefinition]),
  );
  return { list, definitions, effective };
}

export interface AgentDirs {
  /** `.isarflow/agents` of every workspace folder, as `<scheme>://<authority><path>` keys (see uriKey). */
  workspace: string[];
  user: string;
}

/** Scope and id of an agent file given as uriKey; undefined for files outside the agent folders. */
export function classifyAgentPath(
  path: string,
  dirs: AgentDirs,
  ignoreCase: boolean,
): { id: string; scope: AgentScope } | undefined {
  const id = fileId(baseName(path), 'agent');
  if (id === undefined) return undefined;
  const dir = dirName(path);
  if (dirs.workspace.some((d) => samePath(d, dir, ignoreCase))) return { id, scope: 'workspace' };
  if (samePath(dirs.user, dir, ignoreCase)) return { id, scope: 'user' };
  return undefined;
}

const STARTER_NAMES: Record<Exclude<AgentKind, 'blank'>, string> = { coder: 'Coder', reviewer: 'Reviewer' };

/** File content for a new agent; coder and reviewer starters keep their setup but take the given name. */
export function starterAgentText(name: string, kind: AgentKind): string {
  if (kind === 'blank') return newAgentText(name, DEFAULT_AGENT_MODEL);
  const starter = defaultAgentText(kind, DEFAULT_AGENT_MODEL);
  const clean = name.replace(/\s+/g, ' ').trim();
  if (clean === '' || clean === STARTER_NAMES[kind]) return starter;
  const renamed = applyAgentUpdate(starter, { name: clean });
  return renamed.error ? starter : renamed.text;
}
