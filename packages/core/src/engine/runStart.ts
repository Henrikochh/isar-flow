import { cutString } from '../live/context';
import { blockHashes } from '../run/blockHash';
import type { Workflow } from '../schema/types';
import type { SecretMasker } from './mask';
import { resumePath, splitAtTarget, storedOutput } from './resume';
import { editorScope, gitScope } from './roots';
import type { ResumeOptions, RunContextSnapshot, RunEvent, RunOptions } from './types';

/** Changed files a run's snapshot keeps for live values. */
export const SNAPSHOT_CHANGED_FILES_MAX = 200;

const keysOf = (value: unknown): string[] =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? Object.keys(value) : [];

/**
 * What expressions can read besides inputs and block outputs; names only, never env or secret values. `editor`
 * and `git` are recorded when the run got them: secrets masked first, then long text cut like live values.
 */
export function runContextSnapshot(
  workflow: Workflow,
  options: RunOptions,
  masker: SecretMasker,
): RunContextSnapshot {
  const cut = (text: string) => cutString(masker.text(text));
  const editor = options.editor && editorScope(options.editor);
  const git = options.git && gitScope(options.git);
  return {
    env: [...new Set([...keysOf(options.env), ...keysOf(workflow.env)])].sort(),
    secrets: keysOf(options.secrets).sort(),
    workflow: { name: workflow.name, file: options.workflowFile ?? '' },
    workspace: { root: options.workspaceRoot },
    ...(editor && {
      editor: {
        selection: cut(editor.selection),
        file: masker.text(editor.file),
        language: masker.text(editor.language),
        line: editor.line,
      },
    }),
    ...(git && {
      git: {
        branch: masker.text(git.branch),
        changedFiles: git.changedFiles.slice(0, SNAPSHOT_CHANGED_FILES_MAX).map((file) => masker.text(file)),
        diff: cut(git.diff),
      },
    }),
  };
}

/**
 * Hash of each block's YAML at run start. A block a resumed run reuses keeps the source run's hash (none when that
 * run has none), because its output was made by that YAML: a later Run from here still sees that it changed.
 */
function recordedHashes(workflow: Workflow, resume: ResumeOptions | undefined): Record<string, string> {
  const hashes = new Map(Object.entries(blockHashes(workflow)));
  const steps = Array.isArray(workflow.steps) ? workflow.steps : [];
  const path = resume && resumePath(steps, resume.stepId);
  if (!resume || !path) return Object.fromEntries(hashes);
  const source = resume.blockHashes;
  for (const [id, step] of splitAtTarget(steps, path).before) {
    if (!storedOutput(resume, step)) continue;
    if (source && Object.hasOwn(source, id)) hashes.set(id, source[id]);
    else hashes.delete(id);
  }
  return Object.fromEntries(hashes);
}

export function runStartEvent(
  workflow: Workflow,
  options: RunOptions,
  startedAt: number,
  inputs: Record<string, unknown>,
  masker: SecretMasker,
): Extract<RunEvent, { type: 'run-start' }> {
  const { resume, simulated, origin } = options;
  return {
    type: 'run-start',
    runId: options.runId,
    workflowName: workflow.name,
    startedAt,
    inputs,
    ...(resume && { resumedFrom: { runId: resume.fromRunId, stepId: resume.stepId } }),
    ...(simulated === true && { simulated: true }),
    context: runContextSnapshot(workflow, options, masker),
    blockHashes: recordedHashes(workflow, resume),
    ...(origin && origin.kind !== 'manual' && { origin: { ...origin } }),
  };
}
