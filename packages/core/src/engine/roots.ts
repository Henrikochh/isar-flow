import { analyzeExpression, findTemplateExpressions } from '../expr';
import type { Workflow } from '../schema/types';
import { isRecord, listBlocks } from '../variables';
import type { EditorContext, GitContext } from './types';

export const EDITOR_FIELDS = ['selection', 'file', 'language', 'line'] as const;
export const GIT_FIELDS = ['branch', 'changedFiles', 'diff'] as const;

/** `editor.*` of a run started without an editor. */
export function emptyEditorContext(): EditorContext {
  return { selection: '', file: '', language: '', line: 0 };
}

/** `git.*` of a run without captured git state. */
export function emptyGitContext(): GitContext {
  return { branch: '', changedFiles: [], diff: '' };
}

const textOf = (value: unknown): string => (typeof value === 'string' ? value : '');

/** `editor.*` for a run: a copy of what the host captured (fields it left out are empty), else empty values. */
export function editorScope(editor: EditorContext | undefined): EditorContext {
  if (!isRecord(editor)) return emptyEditorContext();
  const line: unknown = editor.line;
  return {
    selection: textOf(editor.selection),
    file: textOf(editor.file),
    language: textOf(editor.language),
    line: typeof line === 'number' && Number.isFinite(line) ? line : 0,
  };
}

/** `git.*` for a run: a copy of what the host captured (fields it left out are empty), else empty values. */
export function gitScope(git: GitContext | undefined): GitContext {
  if (!isRecord(git)) return emptyGitContext();
  const files: unknown = git.changedFiles;
  return {
    branch: textOf(git.branch),
    changedFiles: Array.isArray(files)
      ? files.filter((file): file is string => typeof file === 'string')
      : [],
    diff: textOf(git.diff),
  };
}

/** Text of the `${{ }}` templates in a field; nothing for fields that aren't text or can't be read. */
function templateExpressions(text: unknown): string[] {
  if (typeof text !== 'string' || !text.includes('${{')) return [];
  try {
    return findTemplateExpressions(text).map((match) => match.expr);
  } catch {
    return [];
  }
}

/** Expressions of a condition, mirroring evaluateCondition: plain text is one expression. */
function conditionExpressions(condition: unknown): string[] {
  if (typeof condition === 'string') {
    if (condition.includes('${{')) return templateExpressions(condition);
    return condition.trim() === '' ? [] : [condition];
  }
  if (!isRecord(condition)) return [];
  const group = condition.all ?? condition.any;
  if (Array.isArray(group)) return group.flatMap(conditionExpressions);
  if ('not' in condition) return conditionExpressions(condition.not);
  return [...templateExpressions(condition.value), ...templateExpressions(condition.to)];
}

const values = (map: unknown): unknown[] => (isRecord(map) ? Object.values(map) : []);
const items = (list: unknown): unknown[] => (Array.isArray(list) ? list : []);

/** Every expression the engine evaluates for a block (templates in rendered fields and conditions). */
function blockExpressions(step: Record<string, unknown>): string[] {
  const fields: unknown[] = [];
  const conditions: unknown[] = [];
  switch (step.type) {
    case 'console':
      fields.push(step.run, step.cwd, ...values(step.env));
      break;
    case 'agent':
      fields.push(step.prompt, ...items(isRecord(step.context) ? step.context.files : undefined));
      break;
    case 'approval':
    case 'stop':
      fields.push(step.message);
      break;
    case 'ask':
      fields.push(step.question, ...items(step.choices), step.default);
      break;
    case 'if':
      conditions.push(step.condition);
      break;
    case 'loop':
      conditions.push(step.until, step.while);
      break;
  }
  return [...fields.flatMap(templateExpressions), ...conditions.flatMap(conditionExpressions)];
}

function readsRoot(expression: string, root: string): boolean {
  try {
    return analyzeExpression(expression).references.some(([name]) => name === root);
  } catch {
    return false;
  }
}

/**
 * True when any template or condition of the workflow (block fields the engine renders, workflow env, input
 * defaults) reads `editor.*` or `git.*`. Hosts capture the root at run start only for workflows that read it.
 */
export function workflowUsesRoot(workflow: Workflow | null | undefined, root: 'editor' | 'git'): boolean {
  if (!isRecord(workflow)) return false;
  const expressions = [
    ...values(workflow.env).flatMap(templateExpressions),
    ...values(workflow.inputs).flatMap((input) =>
      templateExpressions(isRecord(input) ? input.default : undefined),
    ),
    ...listBlocks(workflow).flatMap((block) =>
      blockExpressions(block.step as unknown as Record<string, unknown>),
    ),
  ];
  return expressions.some((expression) => readsRoot(expression, root));
}
