/**
 * Defensive accessors for the lenient workflow model: while the YAML is invalid, any field may be missing
 * or have the wrong type, so the inspector never trusts the declared TypeScript shape.
 */
import {
  type BlockNode,
  type Diagnostic,
  listBlocks,
  STEP_TYPES,
  type StepType,
  type Workflow,
} from '@isar-flow/core';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function asStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(asString) : [];
}

export function asStringEntries(value: unknown): [string, string][] {
  return isRecord(value) ? Object.entries(value).map(([key, v]) => [key, asString(v)]) : [];
}

export function isStepType(value: unknown): value is StepType {
  return typeof value === 'string' && (STEP_TYPES as string[]).includes(value);
}

/** The block with this id, with its document path and ancestors. */
export function findBlock(workflow: Workflow | null | undefined, id: string | null): BlockNode | undefined {
  if (!workflow || !id) return undefined;
  return listBlocks(workflow).find((block) => block.id === id);
}

export function isInsideLoop(block: BlockNode): boolean {
  return block.ancestors.some((a) => a.step.type === 'loop');
}

/** Title shown for a block: its name, else its id. */
export function blockTitle(step: unknown): string {
  if (!isRecord(step)) return '';
  return asString(step.name).trim() || asString(step.id);
}

export interface BlockIssues {
  /** Diagnostics keyed by the block property they point at (`prompt`, `until`, …). */
  byField: Map<string, Diagnostic[]>;
  /** Diagnostics that no rendered field shows; listed at the top of the inspector. */
  general: Diagnostic[];
}

/** Block-level diagnostics that belong to one field although their path ends at the block. */
const CODE_FIELDS: Record<string, string> = { 'agent-missing': 'agent' };

/**
 * Splits the block's diagnostics between the fields that render them and a general list. A diagnostic belongs
 * to a field when its path continues the block's path with that property name.
 */
export function blockIssues(
  diagnostics: readonly Diagnostic[],
  block: BlockNode,
  fields: readonly string[],
): BlockIssues {
  const byField = new Map<string, Diagnostic[]>();
  const general: Diagnostic[] = [];
  const shown = new Set(fields);
  for (const diagnostic of diagnostics) {
    if (diagnostic.stepId !== block.id) continue;
    const path = diagnostic.path ?? [];
    const inside = block.path.every((segment, i) => path[i] === segment);
    const key = inside ? (path[block.path.length] ?? CODE_FIELDS[diagnostic.code]) : undefined;
    if (typeof key === 'string' && shown.has(key) && diagnostic.code !== 'unknown-property') {
      byField.set(key, [...(byField.get(key) ?? []), diagnostic]);
    } else {
      general.push(diagnostic);
    }
  }
  return { byField, general };
}

/** Diagnostics of top-level workflow keys (`name`, `inputs`, `env`, …), keyed by that key. */
export function workflowIssues(diagnostics: readonly Diagnostic[]): Map<string, Diagnostic[]> {
  const map = new Map<string, Diagnostic[]>();
  for (const diagnostic of diagnostics) {
    const key = diagnostic.path?.[0];
    if (typeof key !== 'string' || key === 'steps' || diagnostic.stepId) continue;
    map.set(key, [...(map.get(key) ?? []), diagnostic]);
  }
  return map;
}

/** First error message (or warning when there is no error) of a diagnostic list. */
export function firstProblem(issues: readonly Diagnostic[] | undefined): Diagnostic | undefined {
  if (!issues || issues.length === 0) return undefined;
  return issues.find((d) => d.severity === 'error') ?? issues[0];
}
