/**
 * Editing model of the inspector's Simulation section: one row per mocked result. A row keeps the result as it
 * will be written plus the text typed into fields that must parse (exit code, JSON), so typing is never lost.
 */
import {
  type OutputShape,
  SIMULATED_ANSWER,
  type SimulationApprovals,
  type SimulationResult,
  sampleJson,
} from '@isar-flow/core';

/** Which fields a block's results have: console, text agent, JSON agent or approval. */
export type MockKind = 'console' | 'text' | 'json' | 'approval';

export const DEFAULT_ERROR = 'Simulated failure';

export interface MockRow {
  /** Stable React key. */
  key: number;
  /** The result as it is written to the simulation file. */
  result: SimulationResult;
  /** Exit code as typed (console). */
  exitCode: string;
  /** Answer as typed (JSON agents). */
  json: string;
  /** Error message as typed (any kind, while the call fails). */
  error: string;
  /** The result before "Fail this call" was turned on; restored when it is turned off. */
  stash?: SimulationResult;
}

type Raw = Record<string, unknown>;

const isRecord = (value: unknown): value is Raw =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function mockKind(step: Raw): MockKind | null {
  switch (step.type) {
    case 'console':
      return 'console';
    case 'agent':
      return isRecord(step.output) && step.output.format === 'json' ? 'json' : 'text';
    case 'approval':
      return 'approval';
    default:
      return null;
  }
}

/** Sample answer of a JSON agent built from its JSON fields; `{}` when they can't be read. */
export function sampleFor(step: Raw): unknown {
  const schema = isRecord(step.output) ? step.output.schema : undefined;
  if (!isRecord(schema)) return {};
  try {
    return sampleJson(schema as OutputShape);
  } catch {
    return {};
  }
}

export const prettyJson = (value: unknown): string => JSON.stringify(value, null, 2) ?? '';

export function rowFromResult(result: SimulationResult, key: number): MockRow {
  return {
    key,
    result,
    exitCode: result.exitCode === undefined ? '' : String(result.exitCode),
    json: result.json !== undefined ? prettyJson(result.json) : (result.text ?? ''),
    error: result.error ?? '',
  };
}

export function newRow(
  kind: MockKind,
  step: Raw,
  approvals: SimulationApprovals | undefined,
  key: number,
): MockRow {
  switch (kind) {
    case 'json':
      return rowFromResult({ json: sampleFor(step) }, key);
    case 'approval':
      return rowFromResult({ approved: approvals !== 'reject' }, key);
    default:
      return rowFromResult({}, key);
  }
}

function withValue(
  result: SimulationResult,
  field: keyof SimulationResult,
  value: unknown,
): SimulationResult {
  const next = { ...result };
  if (value === undefined) delete next[field];
  else (next as Raw)[field] = value;
  return next;
}

const WHOLE_NUMBER = /^[+-]?\d+$/;

export function setExitCode(row: MockRow, text: string): MockRow {
  const trimmed = text.trim();
  if (trimmed !== '' && !WHOLE_NUMBER.test(trimmed)) return { ...row, exitCode: text };
  const value = trimmed === '' ? undefined : Number(trimmed);
  return { ...row, exitCode: text, result: withValue(row.result, 'exitCode', value) };
}

/** Plain text fields; empty text leaves the field out (the default applies). */
export function setText(row: MockRow, field: 'output' | 'text' | 'comment', text: string): MockRow {
  return { ...row, result: withValue(row.result, field, text === '' ? undefined : text) };
}

function jsonProblem(text: string): string | undefined {
  if (text.trim() === '') return undefined;
  try {
    JSON.parse(text);
    return undefined;
  } catch (error) {
    return `Not valid JSON: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** A typed answer replaces both json and text, so the answer text always matches the JSON. */
export function setJson(row: MockRow, text: string): MockRow {
  if (jsonProblem(text)) return { ...row, json: text };
  const { json: _json, text: _text, ...rest } = row.result;
  const result = text.trim() === '' ? rest : { ...rest, json: JSON.parse(text) as unknown };
  return { ...row, json: text, result };
}

export function setApproved(row: MockRow, approved: boolean): MockRow {
  return { ...row, result: { ...row.result, approved } };
}

export function setFailing(row: MockRow, failing: boolean): MockRow {
  if (failing) {
    if (row.result.error !== undefined) return row;
    return { ...row, stash: row.result, error: DEFAULT_ERROR, result: { error: DEFAULT_ERROR } };
  }
  const { error: _error, ...rest } = row.result;
  return { ...row, stash: undefined, error: '', result: row.stash ?? rest };
}

export function setErrorText(row: MockRow, text: string): MockRow {
  return { ...row, error: text, result: { ...row.result, error: text.trim() === '' ? DEFAULT_ERROR : text } };
}

/** Why the row can't be saved as typed, if anything. */
export function rowProblem(row: MockRow, kind: MockKind): string | undefined {
  if (row.result.error !== undefined) return undefined;
  if (kind === 'console') {
    const trimmed = row.exitCode.trim();
    return trimmed !== '' && !WHOLE_NUMBER.test(trimmed) ? 'Enter a whole number.' : undefined;
  }
  if (kind === 'json') {
    // An answer from the file that was never edited is kept as it is, JSON or not.
    const untouched = row.result.json === undefined && row.json === (row.result.text ?? '');
    return untouched ? undefined : jsonProblem(row.json);
  }
  return undefined;
}

export function toResults(rows: MockRow[]): SimulationResult[] {
  return rows.map((row) => row.result);
}

/** The muted line shown while a block has no results. */
export function defaultsText(kind: MockKind, approvals?: SimulationApprovals): string {
  switch (kind) {
    case 'console':
      return 'Without results, Simulate uses exit code 0 and no output.';
    case 'text':
      return `Without results, the agent answers "${SIMULATED_ANSWER}".`;
    case 'json':
      return 'Without results, the agent answers with sample JSON built from its JSON fields.';
    case 'approval':
      return `Without results, the approval is ${approvals === 'reject' ? 'rejected' : 'approved'}.`;
  }
}
