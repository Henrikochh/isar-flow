import type { OutputShape } from '../schema/types';

type JsonSchema = Record<string, unknown>;

const COMPACT_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'any']);
const SCHEMA_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']);
const SCHEMA_KEYWORDS = new Set([
  '$schema',
  '$id',
  '$ref',
  '$defs',
  'definitions',
  'type',
  'title',
  'description',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'default',
  'examples',
  'format',
  'pattern',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
  'oneOf',
  'anyOf',
  'allOf',
  'not',
  'nullable',
]);

const UNKNOWN_TYPE_HINT =
  'Use string, number, integer, boolean, object, array or any; add [] for a list and ? for an optional key.';
const SCHEMA_TYPE_HINT = 'Use string, number, integer, boolean, object, array or null.';
const BAD_SPEC_HINT =
  'expected a type name like "string", a nested object or a one-element list like ["string"].';
const MAX_PROBLEMS = 20;
/** Upper bound on characters scanned while looking for JSON in prose, so pathological answers cannot hang. */
const MAX_SCAN_CHARS = 2_000_000;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/* ---------- extraction ---------- */

/** Reasoning models (e.g. DeepSeek R1, Qwen3 via Ollama) may start with a think block that holds draft JSON. */
const LEADING_REASONING = /^\s*<(think|thinking|reasoning)>[\s\S]*?<\/\1>/i;
/** Candidates in prose whose parse errors are worth reporting; "[see below]" is not. */
const LOOKS_LIKE_JSON = /^(?:\{|\[\s*(?:[[{"\d\-\]]|true|false|null))/;

interface ScanReport {
  /** Parse error of the first JSON-looking candidate that did not parse. */
  error?: string;
}

/**
 * Parses JSON from a model answer: plain JSON, a ```json fenced block, or the first balanced
 * `{…}` / `[…]` inside surrounding prose. Throws when nothing parses.
 */
export function extractJson(text: string): unknown {
  const report: ScanReport = {};
  for (const value of jsonCandidates(text, report)) return value;
  throw noJsonError(report);
}

/**
 * Like extractJson, but when the answer holds several JSON values (e.g. a `[ ]` checkbox or a `[1]` citation
 * before the real answer) it returns the first one that fits the shape, else the closest one with its problems.
 */
export function extractJsonMatching(
  text: string,
  shape: OutputShape,
): { value: unknown; problems: string[] } {
  const types = typeList(compileShape(shape).schema);
  const report: ScanReport = {};
  let best: { value: unknown; problems: string[]; rootFits: boolean } | undefined;
  for (const value of jsonCandidates(text, report)) {
    const problems = checkJsonShape(value, shape);
    if (problems.length === 0) return { value, problems };
    const rootFits = !types || types.some((type) => hasType(value, type));
    const better =
      !best ||
      (rootFits && !best.rootFits) ||
      (rootFits === best.rootFits && problems.length < best.problems.length);
    if (better) best = { value, problems, rootFits };
  }
  if (best) return { value: best.value, problems: best.problems };
  throw noJsonError(report);
}

function noJsonError(report: ScanReport): Error {
  if (report.error) return new Error(`The text is not valid JSON: ${report.error}`);
  return new Error('The text does not contain a JSON object or array.');
}

/**
 * JSON values in a model answer, most likely answer first: the whole text, then ``` fenced blocks
 * (json-labelled first), then balanced `{…}` / `[…]` in prose that are not nested in an earlier value.
 */
function* jsonCandidates(text: string, report: ScanReport): Generator<unknown> {
  const attempt = (candidate: string, reportError: boolean): { ok: true; value: unknown } | { ok: false } => {
    try {
      return { ok: true, value: JSON.parse(candidate) };
    } catch (error) {
      if (reportError) report.error ??= error instanceof Error ? error.message : String(error);
      return { ok: false };
    }
  };

  // An answer that is JSON as a whole is the answer; reasoning tags inside its strings must survive.
  for (const whole of new Set([text.trim(), text.replace(LEADING_REASONING, '').trim()])) {
    if (whole === '') continue;
    const parsed = attempt(whole, false);
    if (parsed.ok) {
      yield parsed.value;
      return;
    }
  }

  const body = text.replace(LEADING_REASONING, '');
  for (const block of fencedBlocks(body)) {
    const parsed = attempt(block.trim(), true);
    if (parsed.ok) yield parsed.value;
  }

  let budget = MAX_SCAN_CHARS;
  let start = nextOpener(body, 0);
  while (start !== -1 && budget > 0) {
    const scan = balancedEnd(body, start);
    budget -= scan.scanned;
    let next = start + 1;
    if (scan.end !== -1) {
      const candidate = body.slice(start, scan.end + 1);
      const parsed = attempt(candidate, LOOKS_LIKE_JSON.test(candidate));
      if (parsed.ok) {
        yield parsed.value;
        next = scan.end + 1;
      }
    }
    start = nextOpener(body, next);
  }
}

/** Contents of ``` fenced blocks, json-labelled blocks first. */
function fencedBlocks(text: string): string[] {
  const json: string[] = [];
  const other: string[] = [];
  for (const match of text.matchAll(/(`{3,})[ \t]*([^\n`]*)\r?\n([\s\S]*?)\r?\n?\1/g)) {
    const label = match[2].trim().toLowerCase();
    (label === 'json' || label === 'jsonc' ? json : other).push(match[3]);
  }
  return [...json, ...other];
}

function nextOpener(text: string, from: number): number {
  for (let i = from; i < text.length; i++) {
    if (text[i] === '{' || text[i] === '[') return i;
  }
  return -1;
}

/** Index of the bracket closing the one at `start` (string-aware), or -1. */
function balancedEnd(text: string, start: number): { end: number; scanned: number } {
  const stack: string[] = [];
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') {
      if (stack.pop() !== ch) return { end: -1, scanned: i - start + 1 };
      if (stack.length === 0) return { end: i, scanned: i - start + 1 };
    }
  }
  return { end: -1, scanned: text.length - start };
}

/* ---------- shapes ---------- */

/**
 * True when the shape is a full JSON Schema rather than a compact shape: it has a `properties`
 * object, or a JSON Schema `type` and nothing but JSON Schema keywords.
 */
export function isJsonSchema(shape: OutputShape): boolean {
  if (isPlainObject(shape.properties)) return true;
  const type = shape.type;
  const typeOk =
    (typeof type === 'string' && SCHEMA_TYPES.has(type)) ||
    (Array.isArray(type) &&
      type.length > 0 &&
      type.every((t) => typeof t === 'string' && SCHEMA_TYPES.has(t)));
  return typeOk && Object.keys(shape).every((key) => SCHEMA_KEYWORDS.has(key));
}

interface Compiled {
  schema: JsonSchema;
  optional: boolean;
}

function compileSpec(spec: unknown, path: string, problems: string[]): Compiled {
  if (typeof spec === 'string') {
    let rest = spec.trim();
    const optional = rest.endsWith('?');
    if (optional) rest = rest.slice(0, -1).trim();
    let depth = 0;
    while (rest.endsWith('[]')) {
      rest = rest.slice(0, -2).trim();
      depth++;
    }
    if (!COMPACT_TYPES.has(rest)) {
      problems.push(`${label(path)}unknown type "${spec}". ${UNKNOWN_TYPE_HINT}`);
      return { schema: {}, optional };
    }
    let schema: JsonSchema = rest === 'any' ? {} : { type: rest };
    for (let i = 0; i < depth; i++) schema = { type: 'array', items: schema };
    return { schema, optional };
  }
  if (Array.isArray(spec) && spec.length === 1) {
    return {
      schema: { type: 'array', items: compileSpec(spec[0], `${path}[]`, problems).schema },
      optional: false,
    };
  }
  if (isPlainObject(spec)) {
    if (!isJsonSchema(spec)) return { schema: compileObject(spec, path, problems), optional: false };
    checkSchema(spec, path, problems);
    return { schema: spec, optional: false };
  }
  problems.push(`${label(path)}${BAD_SPEC_HINT}`);
  return { schema: {}, optional: false };
}

function compileObject(shape: Record<string, unknown>, path: string, problems: string[]): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const [rawKey, spec] of Object.entries(shape)) {
    const keyOptional = rawKey.length > 1 && rawKey.endsWith('?');
    const key = keyOptional ? rawKey.slice(0, -1) : rawKey;
    const compiled = compileSpec(spec, joinKey(path, key), problems);
    const optional = keyOptional || compiled.optional;
    properties[key] = optional ? allowNull(compiled.schema) : compiled.schema;
    if (!optional) required.push(key);
  }
  return required.length > 0 ? { type: 'object', properties, required } : { type: 'object', properties };
}

/** Optional keys of compact shapes also accept null, which models often send for "nothing". */
function allowNull(schema: JsonSchema): JsonSchema {
  const result = { ...schema };
  if (typeof schema.type === 'string' && schema.type !== 'null') result.type = [schema.type, 'null'];
  else if (Array.isArray(schema.type) && !schema.type.includes('null'))
    result.type = [...schema.type, 'null'];
  if (Array.isArray(schema.enum) && !schema.enum.includes(null)) result.enum = [...schema.enum, null];
  return result;
}

function compileShape(shape: OutputShape): { schema: JsonSchema; problems: string[] } {
  const problems: string[] = [];
  if (isJsonSchema(shape)) {
    checkSchema(shape, '', problems);
    return { schema: shape, problems };
  }
  return { schema: compileObject(shape, '', problems), problems };
}

/**
 * Problems in a JSON Schema that would make validation pass silently, such as compact types written
 * inside `properties` (`approved: boolean` instead of `approved: { type: boolean }`) or unknown types.
 */
function checkSchema(schema: JsonSchema, path: string, problems: string[]): void {
  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  for (const type of types) {
    if (typeof type !== 'string' || !SCHEMA_TYPES.has(type)) {
      problems.push(`${label(path)}unknown JSON Schema type ${JSON.stringify(type)}. ${SCHEMA_TYPE_HINT}`);
    }
  }
  if (schema.properties !== undefined && !isPlainObject(schema.properties)) {
    problems.push(`${label(path)}"properties" must be an object that maps each key to a JSON Schema.`);
  } else if (isPlainObject(schema.properties)) {
    for (const [key, sub] of Object.entries(schema.properties))
      checkSubschema(sub, joinKey(path, key), problems);
  }
  if (schema.items !== undefined && !Array.isArray(schema.items)) {
    checkSubschema(schema.items, `${path}[]`, problems);
  }
}

function checkSubschema(sub: unknown, path: string, problems: string[]): void {
  if (typeof sub === 'boolean') return;
  if (isPlainObject(sub)) {
    checkSchema(sub, path, problems);
  } else if (typeof sub === 'string') {
    const scratch: string[] = [];
    const { schema } = compileSpec(sub, path, scratch);
    const example = JSON.stringify(scratch.length === 0 ? schema : { type: 'string' });
    problems.push(
      `${label(path)}${JSON.stringify(sub)} is a compact type, but this schema is a JSON Schema ` +
        `(it has "type" or "properties"). Write ${example} instead, or use the compact form throughout.`,
    );
  } else {
    problems.push(
      `${label(path)}expected a JSON Schema object such as {"type":"string"}, got ${describeValue(sub)}.`,
    );
  }
}

/** Problems in the shape itself (unknown type names, unsupported values); empty when usable. */
export function validateOutputShape(shape: OutputShape): string[] {
  return compileShape(shape).problems;
}

/** Converts a compact shape to JSON Schema (required = non-optional keys); full schemas are returned as-is. */
export function shapeToJsonSchema(shape: OutputShape): Record<string, unknown> {
  return compileShape(shape).schema;
}

/**
 * Checks a parsed answer against a compact shape or a JSON Schema (subset: type, required,
 * properties, items, enum). Returns readable problems with paths; empty when the value fits.
 */
export function checkJsonShape(value: unknown, shape: OutputShape): string[] {
  const { schema, problems: shapeProblems } = compileShape(shape);
  const problems = [...shapeProblems];
  validate(value, schema, '', problems);
  if (problems.length <= MAX_PROBLEMS) return problems;
  return [...problems.slice(0, MAX_PROBLEMS), `…and ${problems.length - MAX_PROBLEMS} more problems`];
}

function validate(value: unknown, schema: JsonSchema, path: string, problems: string[]): void {
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => sameJson(option, value))) {
    const options = schema.enum.map((option) => JSON.stringify(option)).join(', ');
    problems.push(`${label(path)}expected one of ${options}, got ${describeValue(value)}`);
    return;
  }
  const types = typeList(schema);
  if (types && !types.some((type) => hasType(value, type))) {
    problems.push(`${label(path)}expected ${describeSchema(schema)}, got ${describeValue(value)}`);
    return;
  }
  if (isPlainObject(value)) {
    const properties = isPlainObject(schema.properties) ? schema.properties : {};
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    // Report in schema order so problems read top to bottom like the expected shape.
    const keys = [
      ...new Set([...Object.keys(properties), ...[...required].filter((k) => typeof k === 'string')]),
    ];
    for (const key of keys) {
      const sub = properties[key];
      if (Object.hasOwn(value, key)) {
        if (isPlainObject(sub)) validate(value[key], sub, joinKey(path, key), problems);
      } else if (required.has(key)) {
        problems.push(
          `${joinKey(path, key)}: missing (expected ${isPlainObject(sub) ? describeSchema(sub) : 'a value'})`,
        );
      }
    }
  }
  if (Array.isArray(value) && isPlainObject(schema.items)) {
    const items = schema.items;
    value.forEach((item, index) => validate(item, items, `${path}[${index}]`, problems));
  }
}

function typeList(schema: JsonSchema): string[] | undefined {
  if (typeof schema.type === 'string') return [schema.type];
  if (Array.isArray(schema.type)) return schema.type.filter((t): t is string => typeof t === 'string');
  return undefined;
}

function hasType(value: unknown, type: string): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return isPlainObject(value);
    case 'array':
      return Array.isArray(value);
    case 'null':
      return value === null;
    default:
      return true;
  }
}

function sameJson(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/** Type summary like `string`, `string[]` or `number or null`. */
function describeSchema(schema: JsonSchema): string {
  const types = typeList(schema);
  if (!types || types.length === 0) return 'any';
  return types
    .map((type) => {
      if (type !== 'array' || !isPlainObject(schema.items)) return type;
      const inner = describeSchema(schema.items);
      return inner.includes(' ') ? `(${inner})[]` : `${inner}[]`;
    })
    .join(' or ');
}

function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') return 'object';
  const preview = typeof value === 'string' ? JSON.stringify(value) : String(value);
  return `${typeof value} ${preview.length > 40 ? `${preview.slice(0, 39)}…` : preview}`;
}

function joinKey(path: string, key: string): string {
  if (!/^[A-Za-z_$][\w$-]*$/.test(key)) return `${path}[${JSON.stringify(key)}]`;
  return path ? `${path}.${key}` : key;
}

function label(path: string): string {
  return path ? `${path}: ` : '';
}

/* ---------- prompt text ---------- */

/** Human/model-readable rendering of the expected shape: TypeScript-like for compact shapes, JSON for schemas. */
export function describeOutputShape(shape: OutputShape): string {
  if (isJsonSchema(shape)) return JSON.stringify(shape, null, 2);
  return renderObject(shape, '');
}

function renderObject(shape: Record<string, unknown>, indent: string): string {
  const inner = `${indent}  `;
  const lines = Object.entries(shape).map(([rawKey, spec]) => {
    const keyOptional = rawKey.length > 1 && rawKey.endsWith('?');
    const key = keyOptional ? rawKey.slice(0, -1) : rawKey;
    const specOptional = typeof spec === 'string' && spec.trim().endsWith('?');
    return `${inner}${JSON.stringify(key)}${keyOptional || specOptional ? '?' : ''}: ${renderSpec(spec, inner)}`;
  });
  return lines.length === 0 ? '{}' : `{\n${lines.join(',\n')}\n${indent}}`;
}

function renderSpec(spec: unknown, indent: string): string {
  if (typeof spec === 'string') return spec.trim().replace(/\?$/, '').trim();
  if (Array.isArray(spec) && spec.length === 1) return `${renderSpec(spec[0], indent)}[]`;
  if (isPlainObject(spec)) return isJsonSchema(spec) ? JSON.stringify(spec) : renderObject(spec, indent);
  return JSON.stringify(spec);
}
