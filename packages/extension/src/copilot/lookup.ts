import type { WorkflowSummary } from '@isar-flow/core';

export type WorkflowLookup =
  | { kind: 'found'; summary: WorkflowSummary }
  | { kind: 'ambiguous'; candidates: WorkflowSummary[]; message: string }
  | { kind: 'unavailable'; message: string };

/** Workflows Copilot may run: `expose: true` in their file. */
export const isExposed = (summary: WorkflowSummary) => summary.exposed === true;

export const unavailableMessage = (query: string) =>
  `'${query}' isn't available to Copilot. Set expose: true in its workflow file to allow it.`;

const normalize = (text: string) =>
  text
    .trim()
    .replace(/\\/g, '/')
    .replace(/^(?:\.\/)+/, '')
    .toLowerCase();

const fileName = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const fileId = (path: string) => fileName(path).replace(/\.workflow\.ya?ml$/, '');

/**
 * Finds the workflow Copilot means among the exposed ones: by workspace-relative path (also the end of an
 * absolute path), then by file name (with or without `.workflow.yaml`), then by name; case does not matter.
 * Workflows that are not exposed are never found, so the answer is the same as for unknown names.
 */
export function lookupWorkflow(list: WorkflowSummary[], query: string): WorkflowLookup {
  const wanted = normalize(query);
  const label = query.trim();
  const exposed = list.filter(isExposed);
  const levels: ((summary: WorkflowSummary) => boolean)[] = [
    ({ relativePath }) => {
      const path = normalize(relativePath);
      return wanted === path || wanted.endsWith(`/${path}`);
    },
    ({ relativePath }) => {
      const path = normalize(relativePath);
      return wanted === fileName(path) || wanted === fileId(path);
    },
    ({ name }) => normalize(name) === wanted,
  ];
  if (wanted !== '') {
    for (const matches of levels) {
      const found = exposed.filter(matches);
      if (found.length === 1) return { kind: 'found', summary: found[0] };
      if (found.length > 1) {
        const names = found.map((summary) => `${summary.name} (${summary.relativePath})`).join(', ');
        return {
          kind: 'ambiguous',
          candidates: found,
          message: `'${label}' matches several workflows: ${names}. Use the workspace-relative path.`,
        };
      }
    }
  }
  return { kind: 'unavailable', message: unavailableMessage(label) };
}
