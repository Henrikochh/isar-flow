import { type Alias, type Document, isMap, isNode, isSeq, parseDocument, visit } from 'yaml';
import type { Diagnostic, Range } from '../diagnostics';
import { SimulationFileSchema } from '../schema/simulation';
import type { SimulationFile } from '../schema/types';
import { STEP_ID_PATTERN } from '../schema/zod';
import { describeYamlError, PARSE_OPTIONS } from '../yaml/document';
import { schemaDiagnostics } from '../yaml/issues';
import { findPair, focusRange, keyString } from '../yaml/nodePath';
import { createPositionMapper, offsetsToRange, type PositionMapper } from '../yaml/position';

export interface SimulationParseResult {
  /** The mocks; null when the file has errors. */
  file: SimulationFile | null;
  diagnostics: Diagnostic[];
  /** Range of each block id key under `blocks:`, for warnings and "go to mocks". */
  blockRanges: Record<string, Range>;
}

interface Loaded {
  doc: Document;
  map: PositionMapper;
  diagnostics: Diagnostic[];
  /** Plain data of the root mapping; missing when the text can't be used. */
  data?: Record<string, unknown>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const START = { line: 0, character: 0 };

function syntaxError(message: string, range: Range): Diagnostic {
  return { severity: 'error', code: 'yaml-syntax', message, range };
}

/** Parses like workflow files: same options, messages and ranges. */
function load(text: string): Loaded {
  const doc: Document = parseDocument(text, PARSE_OPTIONS);
  const map = createPositionMapper(text);
  const toDiagnostic =
    (severity: 'error' | 'warning') =>
    (error: (typeof doc.errors)[number]): Diagnostic => {
      const problem = describeYamlError(error, text);
      const range = offsetsToRange(map, problem.start, problem.end);
      return { severity, code: 'yaml-syntax', message: problem.message, range };
    };
  const diagnostics = [
    ...doc.errors.map(toDiagnostic('error')),
    ...doc.warnings.map(toDiagnostic('warning')),
  ];
  if (doc.errors.length > 0) return { doc, map, diagnostics };
  const root = doc.contents;
  if (root === null) return { doc, map, diagnostics, data: {} };
  if (!isMap(root)) {
    const found = isSeq(root) ? 'a list' : 'a single value';
    const diagnostic: Diagnostic = {
      severity: 'error',
      code: 'not-a-mapping',
      message: `A simulation file must be a YAML mapping with version and blocks, but this file contains ${found}.`,
    };
    const range = focusRange(root, text, map);
    if (range) diagnostic.range = range;
    return { doc, map, diagnostics: [...diagnostics, diagnostic] };
  }
  const aliases: Alias[] = [];
  visit(doc, { Alias: (_, alias) => void aliases.push(alias) });
  const aliasRange = (alias: Alias | undefined) =>
    (alias && focusRange(alias, text, map)) ?? offsetsToRange(map, 0, 0);
  const unknown = aliases.find((alias) => alias.resolve(doc) === undefined);
  if (unknown) {
    const message = `Unknown alias '*${unknown.source}'. Mark the value to reuse with '&${unknown.source}' above this line.`;
    return { doc, map, diagnostics: [...diagnostics, syntaxError(message, aliasRange(unknown))] };
  }
  try {
    return { doc, map, diagnostics, data: doc.toJS({ maxAliasCount: 100 }) as Record<string, unknown> };
  } catch {
    // The only failure left is the alias limit, which stops "billion laughs" documents from expanding.
    const message =
      'The YAML could not be read: its aliases (*name) expand to too much data. Write the values out instead.';
    return { doc, map, diagnostics: [...diagnostics, syntaxError(message, aliasRange(aliases[0]))] };
  }
}

function collectBlockRanges(doc: Document, text: string, map: PositionMapper): Record<string, Range> {
  const ranges: Record<string, Range> = {};
  const blocks = isMap(doc.contents) ? findPair(doc.contents, 'blocks')?.value : undefined;
  if (!isMap(blocks)) return ranges;
  for (const pair of blocks.items) {
    const id = keyString(pair.key);
    const range = id !== undefined && isNode(pair.key) ? focusRange(pair.key, text, map) : undefined;
    if (id !== undefined && range && !Object.hasOwn(ranges, id)) {
      Object.defineProperty(ranges, id, {
        value: range,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  return ranges;
}

const compareRanges = (a: Diagnostic, b: Diagnostic) => {
  if (!a.range || !b.range) return a.range ? -1 : b.range ? 1 : 0;
  return a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character;
};

/** Block id a diagnostic under `blocks.<id>` belongs to. */
function withStepId(diagnostic: Diagnostic): Diagnostic {
  const [root, id] = diagnostic.path ?? [];
  if (root !== 'blocks' || typeof id !== 'string' || !STEP_ID_PATTERN.test(id)) return diagnostic;
  return { ...diagnostic, stepId: id };
}

const RESULT_FIELDS = ['exitCode', 'output', 'text', 'json', 'approved', 'comment', 'error'] as const;
const RESULT_FIELDS_TEXT = `${RESULT_FIELDS.slice(0, -1).join(', ')} or ${RESULT_FIELDS[RESULT_FIELDS.length - 1]}`;

const looseKey = (key: string) => key.toLowerCase().replace(/[_-]/g, '');

/** Adds how to fix an unknown key: where the mocks of a block go, or the result field that was meant. */
function explainUnknown(diagnostic: Diagnostic, data: Record<string, unknown>): Diagnostic {
  const path = diagnostic.path ?? [];
  const key = path[path.length - 1];
  if (diagnostic.code !== 'unknown-property' || typeof key !== 'string') return diagnostic;
  let hint: string | undefined;
  if (path.length === 1) {
    const value = Object.hasOwn(data, key) ? data[key] : undefined;
    hint = Array.isArray(value)
      ? `Put the mocks of block ${key} under blocks:, indented one level.`
      : 'The top level has version, approvals and blocks.';
  } else if (path.length === 4 && path[0] === 'blocks') {
    const meant = RESULT_FIELDS.find((field) => looseKey(field) === looseKey(key));
    hint = meant ? `Did you mean '${meant}'?` : `A result has ${RESULT_FIELDS_TEXT}.`;
  }
  return hint ? { ...diagnostic, message: `${diagnostic.message}. ${hint}` } : diagnostic;
}

/** Reads a simulation file (`.isarflow/simulations/<workflow>.sim.yaml`). */
export function parseSimulationText(text: string): SimulationParseResult {
  const loaded = load(text);
  if (!loaded.data) return { file: null, diagnostics: loaded.diagnostics, blockRanges: {} };
  const { doc, map } = loaded;
  const data = loaded.data.blocks === null ? { ...loaded.data, blocks: {} } : loaded.data;
  const blockRanges = collectBlockRanges(doc, text, map);
  const parsed = SimulationFileSchema.safeParse(data);
  if (parsed.success) return { file: parsed.data, diagnostics: loaded.diagnostics, blockRanges };

  const single = new Set(
    isRecord(data.blocks)
      ? Object.entries(data.blocks).flatMap(([id, results]) => (isRecord(results) ? [id] : []))
      : [],
  );
  const listHints = [...single].map((id): Diagnostic => ({
    severity: 'error',
    code: 'invalid-value',
    message: `Use a list of results for "${id}", e.g. "- exitCode: 0".`,
    path: ['blocks', id],
    range: blockRanges[id] ?? { start: START, end: START },
  }));
  const issues = parsed.error.issues.filter(
    (issue) => !(issue.path[0] === 'blocks' && single.has(String(issue.path[1]))),
  );
  const fromSchema = schemaDiagnostics(issues, { doc, data, text, map, blocks: false });
  const diagnostics = [...listHints, ...fromSchema]
    .map((diagnostic) => explainUnknown(withStepId(diagnostic), data))
    .sort(compareRanges);
  return { file: null, diagnostics: [...loaded.diagnostics, ...diagnostics], blockRanges };
}
