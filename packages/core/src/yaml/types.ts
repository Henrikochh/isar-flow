import type { Diagnostic, Range } from '../diagnostics';
import type { AgentDefinition, Step, StepSlot, Workflow } from '../schema/types';

export interface WorkflowParseResult {
  /**
   * Lenient model for rendering: present whenever the text is a YAML mapping, even if schema
   * validation failed. Null only for YAML syntax errors, empty documents or non-mapping roots.
   */
  workflow: Workflow | null;
  /** True when the document passed schema validation (semantic validation is separate). */
  valid: boolean;
  diagnostics: Diagnostic[];
  /** Range of each block's mapping node, keyed by block id. */
  stepRanges: Record<string, Range>;
}

export interface AgentParseResult {
  /** Lenient model (see WorkflowParseResult.workflow). */
  agent: AgentDefinition | null;
  valid: boolean;
  diagnostics: Diagnostic[];
}

/** Where a block goes: the list `slot` of container `parentId` (null = workflow root), before `index`. */
export interface InsertTarget {
  parentId: string | null;
  slot: StepSlot;
  /** Insertion index in the list as it is before the operation; clamped to the list length. */
  index: number;
}

export type WorkflowOp =
  | { op: 'insertStep'; target: InsertTarget; step: Step }
  | { op: 'moveStep'; stepId: string; target: InsertTarget }
  | { op: 'deleteStep'; stepId: string }
  | { op: 'duplicateStep'; stepId: string }
  /** Sets top-level keys of a block (values replace whole subtrees); `unset` removes keys. `id` is not allowed. */
  | { op: 'updateStep'; stepId: string; set: Record<string, unknown>; unset?: string[] }
  /** Changes a block id and rewrites `steps.<old>` references in all templates. */
  | { op: 'renameStep'; stepId: string; newId: string }
  /** Sets top-level workflow keys (name, description, inputs, env). */
  | { op: 'updateWorkflow'; set: Record<string, unknown>; unset?: string[] };

export interface ApplyOpsResult {
  /** New document text; equals the input text when `error` is set (ops are atomic). */
  text: string;
  error?: string;
}

export interface TextEdit {
  /** Offset in the old text where the replaced range starts. */
  start: number;
  /** Offset in the old text where the replaced range ends (exclusive). */
  end: number;
  text: string;
}
