import { type Alias, type Document, isMap, isSeq, parseDocument, visit } from 'yaml';
import type { Diagnostic, Range } from '../diagnostics';
import { AgentDefinitionSchema, WorkflowSchema } from '../schema';
import type { AgentDefinition, Step, Workflow } from '../schema/types';
import { describeYamlError, PARSE_OPTIONS } from './document';
import { schemaDiagnostics } from './issues';
import { walkBlockNodes } from './locate';
import { focusRange, fullRange } from './nodePath';
import { createPositionMapper, offsetsToRange, type PositionMapper } from './position';
import type { AgentParseResult, WorkflowParseResult } from './types';

/** Workflow, agent or project config file; decides the messages for empty files and files that aren't mappings. */
export type FileKind = 'workflow' | 'agent' | 'config';

export interface LoadedYaml {
  doc: Document;
  map: PositionMapper;
  diagnostics: Diagnostic[];
  /** Plain data of the root mapping; missing when the text cannot be used. */
  data?: Record<string, unknown>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Without a message an empty file is valid and reads as an empty mapping. */
const EMPTY_MESSAGE: Record<FileKind, string | undefined> = {
  workflow: 'The file is empty. Add version, name and steps.',
  agent: 'The file is empty. Add name and model.',
  config: undefined,
};

const MAPPING_MESSAGE: Record<FileKind, string> = {
  workflow: 'A workflow file must be a YAML mapping with version, name and steps',
  agent: 'An agent file must be a YAML mapping with name and model',
  config: 'A config file must be a YAML mapping with version and providers',
};

export function loadYaml(text: string, kind: FileKind): LoadedYaml {
  const doc: Document = parseDocument(text, PARSE_OPTIONS);
  const map = createPositionMapper(text);
  const toDiagnostic =
    (severity: 'error' | 'warning') =>
    (error: (typeof doc.errors)[number]): Diagnostic => {
      const problem = describeYamlError(error, text);
      return {
        severity,
        code: 'yaml-syntax',
        message: problem.message,
        range: offsetsToRange(map, problem.start, problem.end),
      };
    };
  const diagnostics = [
    ...doc.errors.map(toDiagnostic('error')),
    ...doc.warnings.map(toDiagnostic('warning')),
  ];
  if (doc.errors.length > 0) return { doc, map, diagnostics };

  const root = doc.contents;
  if (root === null) {
    const message = EMPTY_MESSAGE[kind];
    if (message === undefined) return { doc, map, diagnostics, data: {} };
    const start = { line: 0, character: 0 };
    diagnostics.push({
      severity: 'error',
      code: 'empty-document',
      message,
      range: { start, end: start },
    });
    return { doc, map, diagnostics };
  }
  if (!isMap(root)) {
    const diagnostic: Diagnostic = {
      severity: 'error',
      code: 'not-a-mapping',
      message: `${MAPPING_MESSAGE[kind]}, but this file contains ${isSeq(root) ? 'a list' : 'a single value'}.`,
    };
    const range = focusRange(root, text, map);
    if (range) diagnostic.range = range;
    diagnostics.push(diagnostic);
    return { doc, map, diagnostics };
  }
  const aliases: Alias[] = [];
  visit(doc, { Alias: (_, alias) => void aliases.push(alias) });
  const aliasRange = (alias: Alias | undefined) =>
    (alias && focusRange(alias, text, map)) ?? offsetsToRange(map, 0, 0);
  const unknown = aliases.find((alias) => alias.resolve(doc) === undefined);
  if (unknown) {
    diagnostics.push({
      severity: 'error',
      code: 'yaml-syntax',
      message: `Unknown alias '*${unknown.source}'. Mark the value to reuse with '&${unknown.source}' above this line.`,
      range: aliasRange(unknown),
    });
    return { doc, map, diagnostics };
  }
  try {
    const data: unknown = doc.toJS({ maxAliasCount: 100 });
    if (isRecord(data)) return { doc, map, diagnostics, data };
  } catch (err) {
    // The only other failure is the alias limit, which stops "billion laughs" documents from expanding.
    const reason = err instanceof Error ? err.message : String(err);
    diagnostics.push({
      severity: 'error',
      code: 'yaml-syntax',
      message: /alias/i.test(reason)
        ? 'The YAML could not be read: its aliases (*name) expand to too much data. Write the values out instead.'
        : `The YAML could not be read: ${reason}`,
      range: aliasRange(aliases[0]),
    });
  }
  return { doc, map, diagnostics };
}

/** Keeps object items only and makes sure container blocks always have their lists. */
function lenientSteps(value: unknown): Step[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((raw) => {
    const step: Record<string, unknown> = { ...raw };
    if (raw.type === 'loop') step.steps = lenientSteps(raw.steps);
    if (raw.type === 'if') {
      step.then = lenientSteps(raw.then);
      if (raw.else !== undefined) step.else = lenientSteps(raw.else);
    }
    return step as unknown as Step;
  });
}

function lenientWorkflow(data: Record<string, unknown>): Workflow {
  return { ...data, steps: lenientSteps(data.steps) } as unknown as Workflow;
}

function collectStepRanges(doc: Document, text: string, map: PositionMapper): Record<string, Range> {
  const ranges: Record<string, Range> = {};
  if (!isMap(doc.contents)) return ranges;
  walkBlockNodes(doc.contents, ({ node, id }) => {
    if (id === undefined || Object.hasOwn(ranges, id)) return;
    const range = fullRange(node, text, map);
    if (range) ranges[id] = range;
  });
  return ranges;
}

export function parseWorkflowText(text: string): WorkflowParseResult {
  const loaded = loadYaml(text, 'workflow');
  if (!loaded.data) return { workflow: null, valid: false, diagnostics: loaded.diagnostics, stepRanges: {} };
  const stepRanges = collectStepRanges(loaded.doc, text, loaded.map);
  const parsed = WorkflowSchema.safeParse(loaded.data);
  if (parsed.success) {
    return { workflow: parsed.data, valid: true, diagnostics: loaded.diagnostics, stepRanges };
  }
  const issues = schemaDiagnostics(parsed.error.issues, { ...loaded, data: loaded.data, text, blocks: true });
  return {
    workflow: lenientWorkflow(loaded.data),
    valid: false,
    diagnostics: [...loaded.diagnostics, ...issues],
    stepRanges,
  };
}

export function parseAgentText(text: string): AgentParseResult {
  const loaded = loadYaml(text, 'agent');
  if (!loaded.data) return { agent: null, valid: false, diagnostics: loaded.diagnostics };
  const parsed = AgentDefinitionSchema.safeParse(loaded.data);
  if (parsed.success) return { agent: parsed.data, valid: true, diagnostics: loaded.diagnostics };
  const issues = schemaDiagnostics(parsed.error.issues, {
    ...loaded,
    data: loaded.data,
    text,
    blocks: false,
  });
  return {
    agent: { ...loaded.data } as unknown as AgentDefinition,
    valid: false,
    diagnostics: [...loaded.diagnostics, ...issues],
  };
}
