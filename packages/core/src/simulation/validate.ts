import { checkJsonShape, extractJson, validateOutputShape } from '../agent/json';
import type { Diagnostic, Range } from '../diagnostics';
import { findStep } from '../schema/steps';
import type { AgentStep, SimulationFile, SimulationResult, Step, StepType, Workflow } from '../schema/types';
import { parseSimulationText } from './parse';

type HostStepType = 'console' | 'agent' | 'approval';

const FIELDS: Record<HostStepType, { fields: readonly (keyof SimulationResult)[]; hint: string }> = {
  console: { fields: ['exitCode', 'output'], hint: 'Use exitCode and output.' },
  agent: { fields: ['text', 'json'], hint: 'Use text, or json for JSON answers.' },
  approval: { fields: ['approved', 'comment'], hint: 'Use approved and comment.' },
};

const ALL_FIELDS = Object.values(FIELDS).flatMap((entry) => entry.fields);

const isHostStep = (type: StepType): type is HostStepType => Object.hasOwn(FIELDS, type);

const article = (type: StepType) => (/^[aeiou]/.test(type) ? 'an' : 'a');

function tryExtractJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: extractJson(text) };
  } catch {
    return { ok: false };
  }
}

interface Warning {
  code: 'sim-field-mismatch' | 'sim-json-shape';
  message: string;
}

/** Warning for one result of an agent block: json for a text answer, or an answer that doesn't fit the JSON fields. */
function agentWarning(step: AgentStep, result: SimulationResult, label: string): Warning | undefined {
  if (step.output?.format !== 'json') {
    if (result.json === undefined) return undefined;
    const message = `${label}: this agent answers with text, so json is ignored. Use text.`;
    return { code: 'sim-field-mismatch', message };
  }
  let answer: unknown;
  if (result.json !== undefined) answer = result.json;
  else if (result.text !== undefined) {
    const extracted = tryExtractJson(result.text);
    if (!extracted.ok) {
      const message = `${label}: this agent answers with JSON, but the text isn't JSON. Use json, or write the text as JSON.`;
      return { code: 'sim-json-shape', message };
    }
    answer = extracted.value;
  } else return undefined;
  const shape = step.output.schema;
  // Problems in the shape itself are the workflow's to report.
  if (!shape || validateOutputShape(shape).length > 0) return undefined;
  const problems = checkJsonShape(answer, shape);
  if (problems.length === 0) return undefined;
  return {
    code: 'sim-json-shape',
    message: `${label} doesn't match the JSON fields: ${problems.join('; ')}.`,
  };
}

/**
 * Warnings for mocks that don't fit the workflow: unknown block ids, blocks that make no host calls, fields of
 * other block types and JSON answers that don't match the block's JSON fields. Ranges are the block id keys.
 */
export function validateSimulation(
  file: SimulationFile,
  workflow: Workflow,
  blockRanges: Record<string, Range> = {},
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const [id, results] of Object.entries(file.blocks ?? {})) {
    const range = Object.hasOwn(blockRanges, id) ? blockRanges[id] : undefined;
    const warn = (code: string, message: string, path: (string | number)[]) =>
      diagnostics.push({ severity: 'warning', code, message, path, ...(range && { range }), stepId: id });
    const step: Step | undefined = findStep(workflow.steps ?? [], id)?.step;
    if (!step) {
      const message = `No block "${id}" in this workflow. Remove its mocks or fix the id.`;
      warn('sim-unknown-block', message, ['blocks', id]);
      continue;
    }
    if (!isHostStep(step.type)) {
      const message = `"${id}" is ${article(step.type)} ${step.type} block; only console, agent and approval blocks use mocks.`;
      warn('sim-no-host-call', message, ['blocks', id]);
      continue;
    }
    const { fields, hint } = FIELDS[step.type];
    (results ?? []).forEach((result, index) => {
      const label = `Result ${index + 1} of "${id}"`;
      for (const field of ALL_FIELDS) {
        if (result[field] === undefined || fields.includes(field)) continue;
        const message = `${label}: ${field} doesn't apply to ${step.type} blocks. ${hint}`;
        warn('sim-field-mismatch', message, ['blocks', id, index, field]);
      }
      const warning = step.type === 'agent' ? agentWarning(step, result, label) : undefined;
      if (warning) warn(warning.code, warning.message, ['blocks', id, index]);
    });
  }
  return diagnostics;
}

/** Parses a simulation file and, with a workflow, validates its mocks; `file` is {} when the text has errors. */
export function checkSimulationText(
  text: string,
  workflow: Workflow | null,
): { file: SimulationFile; diagnostics: Diagnostic[] } {
  const parsed = parseSimulationText(text);
  if (!parsed.file) return { file: {}, diagnostics: parsed.diagnostics };
  const warnings = workflow ? validateSimulation(parsed.file, workflow, parsed.blockRanges) : [];
  return { file: parsed.file, diagnostics: [...parsed.diagnostics, ...warnings] };
}
