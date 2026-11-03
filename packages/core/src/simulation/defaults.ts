import { shapeToJsonSchema } from '../agent/json';
import type { OutputShape, SimulationApprovals, SimulationResult, Step } from '../schema/types';

/** Answer of text agents without mocks in simulated runs. */
export const SIMULATED_ANSWER = '(simulated answer)';

const SAMPLE_TEXT = '(simulated)';
/** Schemas are plain data from YAML; this only stops pathological nesting. */
const MAX_DEPTH = 32;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function firstType(schema: Record<string, unknown>): unknown {
  if (Array.isArray(schema.type)) return schema.type[0];
  if (schema.type !== undefined) return schema.type;
  if (isRecord(schema.properties)) return 'object';
  return schema.items !== undefined ? 'array' : undefined;
}

function sample(schema: unknown, depth: number): unknown {
  if (!isRecord(schema) || depth > MAX_DEPTH) return null;
  if (Object.hasOwn(schema, 'const')) return schema.const;
  if (Object.hasOwn(schema, 'default')) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  for (const key of ['anyOf', 'oneOf'] as const) {
    const options = schema[key];
    if (Array.isArray(options) && options.length > 0) return sample(options[0], depth + 1);
  }
  switch (firstType(schema)) {
    case 'object': {
      const properties = isRecord(schema.properties) ? schema.properties : {};
      return Object.fromEntries(
        Object.entries(properties).map(([key, sub]) => [key, sample(sub, depth + 1)]),
      );
    }
    case 'array':
      return [];
    case 'string':
      return SAMPLE_TEXT;
    case 'number':
    case 'integer':
      return 0;
    case 'boolean':
      return true;
    default:
      return null;
  }
}

/**
 * Sample answer for a JSON agent: every property of the shape (optional ones too) with a placeholder value of
 * its type; `const`, `default` and the first `enum` value win; unions take their first option.
 */
export function sampleJson(shape: OutputShape | undefined): unknown {
  if (!shape) return {};
  return sample(shapeToJsonSchema(shape), 0);
}

/** What a block returns in a simulated run when it has no mocks. */
export function defaultSimulationResult(step: Step, approvals?: SimulationApprovals): SimulationResult {
  switch (step.type) {
    case 'console':
      return { exitCode: 0, output: '' };
    case 'agent': {
      if (step.output?.format !== 'json') return { text: SIMULATED_ANSWER };
      const json = sampleJson(step.output.schema);
      return { json, text: JSON.stringify(json, null, 2) };
    }
    case 'approval':
      return { approved: approvals !== 'reject' };
    case 'ask':
      return { answer: step.default ?? step.choices?.[0] ?? SIMULATED_ANSWER };
    default:
      return {};
  }
}
