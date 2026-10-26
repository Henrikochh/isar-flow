/**
 * Pure helpers for the sidebar. The host state is trusted for its shape but not for its content:
 * names, ids or models may be empty when a file is invalid, so every label has a fallback.
 */
import {
  parseWorkflowText,
  stepChildren,
  TOOL_INFO,
  workflowTemplate,
  type AgentSummary,
  type ProviderSummary,
  type RunRecordSummary,
  type SidebarState,
  type SidebarToHost,
  type Step,
  type StepType,
  type ToolName,
  type WorkflowSummary,
  type WorkflowTemplateId,
} from '@isar-flow/core';
import { post } from '../../vscode';

export type AgentStarter = 'blank' | 'coder' | 'reviewer';

/**
 * The protocol's createAgent has no starter yet; it is sent as an extra field so a host that knows it can
 * use the matching agent template, and the starter also pre-fills the name.
 */
export type CreateAgentMessage = Extract<SidebarToHost, { type: 'createAgent' }> & {
  starter?: Exclude<AgentStarter, 'blank'>;
};

export function send(message: SidebarToHost | CreateAgentMessage): void {
  post(message);
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** Last path segment of a URI or path, URI-decoded. */
export function fileBaseName(uri: string): string {
  const last = uri.split(/[\\/]/).pop() ?? '';
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

export function agentLabel(agent: AgentSummary): string {
  return text(agent.name) || text(agent.id) || fileBaseName(text(agent.uri)).replace(/\.agent\.ya?ml$/i, '') || 'Unnamed agent';
}

export function workflowLabel(workflow: WorkflowSummary): string {
  return (
    text(workflow.name) ||
    fileBaseName(text(workflow.relativePath) || text(workflow.uri)).replace(/\.workflow\.ya?ml$/i, '') ||
    'Unnamed workflow'
  );
}

/**
 * Shortens a relative path to `columns` characters by dropping whole leading folders ("…/workflows/a.yaml"),
 * never cutting a folder name in half. Falls back to the bare file name, which CSS may still cut at its end.
 */
export function fitPath(path: string, columns: number): string {
  if (path.length <= columns) return path;
  const folders = path.split('/');
  const file = folders.pop() ?? path;
  for (let keep = folders.length - 1; keep >= 1; keep--) {
    const candidate = `…/${folders.slice(folders.length - keep).join('/')}/${file}`;
    if (candidate.length <= columns) return candidate;
  }
  return file;
}

/** Stable React keys from ids that may be missing or duplicated. */
export function uniqueKeys<T>(items: readonly T[], keyOf: (item: T) => string | undefined): string[] {
  const seen = new Map<string, number>();
  return items.map((item, index) => {
    const base = keyOf(item) || `#${index}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}~${count}`;
  });
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

export interface AgentReach {
  tools: number;
  edits: boolean;
  commands: boolean;
}

/** What an agent can do, derived from its tools (the summary carries no permission levels). */
export function agentReach(agent: AgentSummary): AgentReach {
  const tools = Array.isArray(agent.tools) ? [...new Set(agent.tools)] : [];
  const risk = (tool: ToolName) => TOOL_INFO[tool]?.risk;
  return {
    tools: tools.length,
    edits: tools.some((tool) => risk(tool) === 'edit'),
    commands: tools.some((tool) => risk(tool) === 'command'),
  };
}

/** Lower-case file-name form used to spot name clashes before the host does. */
export function slugOf(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export interface WorkflowRunState {
  running: boolean;
  /** Needed to stop the run; unknown while the host has not reported the run record yet. */
  runId?: string;
  startedAt?: number;
}

/**
 * Whether a workflow has an active run. `activeRuns` may list workflow URIs or run ids, so both are matched,
 * and run records with status `running` count too.
 */
export function workflowRunState(workflow: WorkflowSummary, state: Pick<SidebarState, 'activeRuns' | 'recentRuns'>): WorkflowRunState {
  const active = new Set(state.activeRuns ?? []);
  const records = [...(state.recentRuns ?? []), ...(workflow.lastRun ? [workflow.lastRun] : [])].filter(
    (run): run is RunRecordSummary => Boolean(run) && run.workflowUri === workflow.uri,
  );
  const record = records.find((run) => active.has(run.runId)) ?? records.find((run) => run.status === 'running');
  const running = active.has(workflow.uri) || record !== undefined;
  return running ? { running, runId: record?.runId, startedAt: record?.startedAt } : { running: false };
}

export function providerCountText(provider: ProviderSummary): string {
  switch (provider.status) {
    case 'loading':
      return 'Fetching models…';
    case 'error':
      return 'Not reachable';
    case 'unknown':
      return provider.modelCount > 0 ? plural(provider.modelCount, 'model') : 'Not fetched yet';
    default:
      return provider.modelCount > 0 ? plural(provider.modelCount, 'model') : 'No models';
  }
}

export const PROVIDER_STATUS_LABELS: Record<ProviderSummary['status'], string> = {
  ok: 'Connected',
  loading: 'Fetching models',
  error: 'Error',
  unknown: 'Not checked yet',
};

/* ---------- template previews ---------- */

export interface OutlineNode {
  type: StepType;
  children: OutlineNode[];
}

const outlines = new Map<WorkflowTemplateId, OutlineNode[]>();

/** Block structure of a workflow template, read from the real template so the preview never drifts. */
export function templateOutline(id: WorkflowTemplateId): OutlineNode[] {
  const cached = outlines.get(id);
  if (cached) return cached;
  const toNode = (step: Step): OutlineNode => ({
    type: step.type,
    children: stepChildren(step).flatMap((list) => list.steps.map(toNode)),
  });
  let outline: OutlineNode[];
  try {
    outline = parseWorkflowText(workflowTemplate(id, 'Preview')).workflow?.steps.map(toNode) ?? [];
  } catch {
    outline = [];
  }
  outlines.set(id, outline);
  return outline;
}
