import {
  type AgentDefinition,
  type AgentDocumentState,
  type AgentScope,
  type AgentSummary,
  type Diagnostic,
  type ModelCatalog,
  parseAgentText,
  parseWorkflowText,
  validateWorkflow,
  type WorkflowDocumentState,
} from '@isar-flow/core';
import { locateDiagnosticRange, splitLines } from './diagnosticRange';

export interface ValidationContext {
  /** Ids of all known agents (workspace and user). */
  agentIds: string[];
  /** Available model refs; empty skips the model check. */
  modelRefs: string[];
}

/** Validation inputs from the stores. While models are loading the model check is skipped to avoid false alarms. */
export function validationContext(agents: AgentSummary[], catalog: ModelCatalog): ValidationContext {
  return {
    agentIds: [...new Set(agents.map((agent) => agent.id))],
    modelRefs: catalog.loading ? [] : catalog.models.map((model) => model.ref),
  };
}

const hasErrors = (diagnostics: Diagnostic[]) => diagnostics.some((d) => d.severity === 'error');

/** Parses and validates a workflow; semantic diagnostics get a range inside their block when they have none. */
export function buildWorkflowDocumentState(
  text: string,
  uri: string,
  fileName: string,
  ctx: ValidationContext,
): WorkflowDocumentState {
  const parsed = parseWorkflowText(text);
  const semantic = parsed.workflow
    ? validateWorkflow(parsed.workflow, { agentIds: ctx.agentIds, modelRefs: ctx.modelRefs })
    : [];
  const lines = semantic.some((d) => !d.range) ? splitLines(text) : [];
  const located = semantic.map((diagnostic): Diagnostic => {
    if (diagnostic.range) return diagnostic;
    const { stepId } = diagnostic;
    const block =
      stepId !== undefined && Object.hasOwn(parsed.stepRanges, stepId)
        ? parsed.stepRanges[stepId]
        : undefined;
    const range = locateDiagnosticRange(lines, diagnostic.path ?? [], block);
    return range ? { ...diagnostic, range } : diagnostic;
  });
  const diagnostics = [...parsed.diagnostics, ...located];
  return {
    uri,
    fileName,
    text,
    workflow: parsed.workflow,
    valid: parsed.valid && !hasErrors(diagnostics),
    diagnostics,
  };
}

/** Warnings for agent models that no provider offers (skipped when `modelRefs` is empty). */
function modelWarnings(agent: AgentDefinition | null, modelRefs: string[], text: string): Diagnostic[] {
  if (!agent || modelRefs.length === 0) return [];
  const known = new Set(modelRefs);
  const lines = splitLines(text);
  const warnings: Diagnostic[] = [];
  const check = (ref: unknown, path: (string | number)[], label: string) => {
    if (typeof ref !== 'string' || ref === '' || known.has(ref)) return;
    const diagnostic: Diagnostic = {
      severity: 'warning',
      code: 'unknown-model',
      message: `${label} '${ref}' is not available. Refresh the model list or pick another model.`,
      path,
    };
    const range = locateDiagnosticRange(lines, path);
    warnings.push(range ? { ...diagnostic, range } : diagnostic);
  };
  check(agent.model, ['model'], 'Model');
  if (Array.isArray(agent.fallbackModels)) {
    agent.fallbackModels.forEach((ref, i) => check(ref, ['fallbackModels', i], 'Fallback model'));
  }
  return warnings;
}

export function buildAgentDocumentState(
  text: string,
  uri: string,
  id: string,
  scope: AgentScope,
  fileName: string,
  usedBy: string[],
  ctx: { modelRefs?: string[] } = {},
): AgentDocumentState {
  const parsed = parseAgentText(text);
  const diagnostics = [...parsed.diagnostics, ...modelWarnings(parsed.agent, ctx.modelRefs ?? [], text)];
  return {
    uri,
    id,
    scope,
    fileName,
    text,
    agent: parsed.agent,
    valid: parsed.valid && !hasErrors(diagnostics),
    diagnostics,
    usedBy,
  };
}
