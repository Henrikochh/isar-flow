/**
 * Pure helpers for the sidebar. The host state is trusted for its shape but not for its content:
 * names, ids or models may be empty when a file is invalid, so every label has a fallback.
 */
import {
  parseWorkflowText,
  stepChildren,
  workflowTemplate,
  type ActiveRunSummary,
  type AgentSummary,
  type ProviderSummary,
  type SidebarToHost,
  type Step,
  type StepType,
  type WorkflowSummary,
  type WorkflowTemplateId,
} from '@isar-flow/core';
import { post } from '../../vscode';

export function send(message: SidebarToHost): void {
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
  return (
    text(agent.name) ||
    text(agent.id) ||
    fileBaseName(text(agent.uri)).replace(/\.agent\.ya?ml$/i, '') ||
    'Unnamed agent'
  );
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

/** Number of distinct tools an agent lists (what it may do with them is in its capability badges). */
export function toolCount(agent: AgentSummary): number {
  return Array.isArray(agent.tools) ? new Set(agent.tools).size : 0;
}

/** Lower-case file-name form used to spot name clashes before the host does. */
export function slugOf(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** The workflow's run in progress, if any; the newest one when the host reports several. */
export function activeRunOf(
  workflow: WorkflowSummary,
  activeRuns: readonly ActiveRunSummary[],
): ActiveRunSummary | undefined {
  let newest: ActiveRunSummary | undefined;
  for (const run of activeRuns) {
    if (run?.workflowUri !== workflow.uri) continue;
    if (!newest || run.startedAt > newest.startedAt) newest = run;
  }
  return newest;
}

/** Time a run has been going, in whole seconds so a ticking counter stays calm: "8 s", "3 m 4 s". */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} m ${seconds % 60} s`;
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
