import type { ToolName } from '../schema/types';
import { errorMessage } from './format';
import { balancedEnd, MAX_SCAN_CHARS, nextOpener } from './json';
import { isToolName } from './tools';

/** A tool call that a model wrote as text instead of a native tool call. */
export interface TextToolCall {
  name: ToolName;
  /** Parsed arguments object. */
  args: Record<string, unknown>;
}

export interface MalformedToolCall {
  name: ToolName;
  /** Lower-case sentence fragment, e.g. `the arguments of readFile are not a JSON object`. */
  problem: string;
}

export interface TextToolCalls {
  /** Readable calls of enabled tools, in the order of the reply. */
  calls: TextToolCall[];
  /** The reply without the markup of the calls; unchanged when nothing was found. */
  text: string;
  /** The first call of an enabled tool that could not be read. */
  malformed?: MalformedToolCall;
}

export interface TextToolCallOptions {
  /**
   * The block expects a JSON answer: apart from `<tool_call>` tags, only an answer that is exactly a call (or a
   * list of calls) counts, so JSON answers are not misread as calls.
   */
  jsonAnswer?: boolean;
}

interface Found {
  calls: TextToolCall[];
  malformed?: MalformedToolCall;
}

interface Region extends Found {
  start: number;
  end: number;
}

type CallRead =
  | { kind: 'call'; call: TextToolCall }
  | { kind: 'malformed'; malformed: MalformedToolCall }
  | { kind: 'none' };

const OPEN_TAG = '<tool_call>';
const CLOSE_TAG = '</tool_call>';
const REASONING = /<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi;
const FENCE = /(`{3,})[ \t]*([^\n`]*)\r?\n([\s\S]*?)\r?\n?\1/g;
const NAME_KEYS = ['name', 'tool'];
const ARGUMENT_KEYS = ['arguments', 'args', 'parameters'];
/** Keys that providers add to calls and that do not change their meaning. */
const IGNORED_KEYS = ['id', 'type'];

/**
 * Finds tool calls that a model wrote as text: `<tool_call>…</tool_call>` tags, ```json and ```tool_call fences, and
 * bare JSON objects or lists shaped `{name, arguments}` (arguments as object or JSON string), `{tool, args}`,
 * `{function: {name, arguments}}` or `{name, parameters}`. Only enabled tools count; everything else stays text.
 * Reasoning blocks (`<think>…</think>`) are skipped.
 */
export function parseTextToolCalls(
  text: string,
  enabled: readonly ToolName[],
  options: TextToolCallOptions = {},
): TextToolCalls {
  const tools = new Set(enabled.filter(isToolName));
  if (tools.size === 0) return { calls: [], text };

  const scanner = new Scanner(
    text.replace(REASONING, (block) => ' '.repeat(block.length)),
    tools,
  );
  scanner.tags();
  if (options.jsonAnswer) {
    if (scanner.regions.length === 0) scanner.wholeAnswer();
  } else {
    scanner.fences();
    scanner.bare();
  }

  const regions = scanner.regions.sort((a, b) => a.start - b.start);
  if (regions.length === 0) return { calls: [], text };
  const result: TextToolCalls = {
    calls: regions.flatMap((r) => r.calls),
    text: withoutRegions(text, regions),
  };
  const malformed = regions.find((r) => r.malformed)?.malformed;
  if (malformed) result.malformed = malformed;
  return result;
}

/** Walks a copy of the reply in which reasoning and already-read calls are blanked out (same length). */
class Scanner {
  readonly regions: Region[] = [];

  constructor(
    private scan: string,
    private readonly tools: ReadonlySet<ToolName>,
  ) {}

  tags(): void {
    const lower = this.scan.toLowerCase();
    let from = 0;
    for (;;) {
      const start = lower.indexOf(OPEN_TAG, from);
      if (start === -1) return;
      const bodyStart = start + OPEN_TAG.length;
      const close = lower.indexOf(CLOSE_TAG, bodyStart);
      const next = lower.indexOf(OPEN_TAG, bodyStart);
      // A missing closing tag ends the call at the next tag or at the end of the reply.
      const closed = close !== -1 && (next === -1 || close < next);
      const bodyEnd = closed ? close : next === -1 ? lower.length : next;
      const end = closed ? close + CLOSE_TAG.length : bodyEnd;
      const found = readExplicit(this.scan.slice(bodyStart, bodyEnd), this.tools);
      if (found) this.add(start, end, found);
      from = Math.max(end, bodyStart);
    }
  }

  fences(): void {
    for (const match of this.scan.matchAll(FENCE)) {
      const start = match.index;
      const end = start + match[0].length;
      const label = match[2].trim().toLowerCase();
      let found: Found | undefined;
      if (label === 'tool_call') found = readExplicit(match[3], this.tools);
      else if (label === '' || label === 'json' || label === 'jsonc')
        found = readImplicit(match[3], this.tools);
      if (found) this.add(start, end, found);
      // Code in other fences is not scanned for bare calls.
      else this.blank(start, end);
    }
  }

  bare(): void {
    let budget = MAX_SCAN_CHARS;
    let start = nextOpener(this.scan, 0);
    while (start !== -1 && budget > 0) {
      const scan = balancedEnd(this.scan, start);
      budget -= scan.scanned;
      let next = start + 1;
      if (scan.end !== -1) {
        const parsed = parseJsonLenient(this.scan.slice(start, scan.end + 1));
        if (parsed.ok) {
          // A JSON value that is not a call is skipped as a whole, so calls nested in it are not read.
          next = scan.end + 1;
          const found = readValue(parsed.value, this.tools, false);
          if (found) this.add(start, next, found);
        }
      }
      start = nextOpener(this.scan, next);
    }
  }

  /** A JSON answer that is exactly a call, possibly in a code fence. */
  wholeAnswer(): void {
    const start = this.scan.search(/\S/);
    if (start === -1) return;
    const end = this.scan.trimEnd().length;
    const body = this.scan.slice(start, end);
    const found = readImplicit(unfence(body) ?? body, this.tools);
    if (found) this.add(start, end, found);
  }

  private add(start: number, end: number, found: Found): void {
    this.regions.push({ start, end, ...found });
    this.blank(start, end);
  }

  private blank(start: number, end: number): void {
    this.scan = this.scan.slice(0, start) + ' '.repeat(end - start) + this.scan.slice(end);
  }
}

/** Content the model marked as a tool call: a missing arguments object is fine, and unreadable JSON is reported. */
function readExplicit(body: string, tools: ReadonlySet<ToolName>): Found | undefined {
  const content = body.trim();
  const json = unfence(content) ?? content;
  const parsed = parseJsonLenient(json);
  if (parsed.ok) return readValue(parsed.value, tools, true);

  const values = jsonSequence(json);
  if (values) return merge(values.map((value) => readValue(value, tools, true)));

  const name = mentionedTool(json, tools);
  if (!name) return undefined;
  const detail = parsed.error.replace(/\s*\(line \d+ column \d+\)$/, '');
  return { calls: [], malformed: { name, problem: `the call of ${name} is not valid JSON (${detail})` } };
}

/** JSON found in a reply without call markup: only exact call shapes with an arguments key count. */
function readImplicit(content: string, tools: ReadonlySet<ToolName>): Found | undefined {
  const parsed = parseJsonLenient(content.trim());
  return parsed.ok ? readValue(parsed.value, tools, false) : undefined;
}

function readValue(value: unknown, tools: ReadonlySet<ToolName>, explicit: boolean): Found | undefined {
  const items = Array.isArray(value) ? value : [value];
  const reads = items.map((item) => readCall(item, tools, explicit));
  // Without markup a list counts only when every item is a call, so ordinary JSON lists stay text.
  if (!explicit && reads.some((read) => read.kind === 'none')) return undefined;
  return toFound(reads);
}

function toFound(reads: CallRead[]): Found | undefined {
  const calls = reads.flatMap((read) => (read.kind === 'call' ? [read.call] : []));
  const malformed = reads.find((read) => read.kind === 'malformed');
  if (calls.length === 0 && !malformed) return undefined;
  return malformed?.kind === 'malformed' ? { calls, malformed: malformed.malformed } : { calls };
}

function merge(parts: (Found | undefined)[]): Found | undefined {
  const found = parts.filter((part): part is Found => part !== undefined);
  if (found.length === 0) return undefined;
  const calls = found.flatMap((part) => part.calls);
  const malformed = found.find((part) => part.malformed)?.malformed;
  return malformed ? { calls, malformed } : { calls };
}

function readCall(value: unknown, tools: ReadonlySet<ToolName>, explicit: boolean): CallRead {
  const shape = callShape(value, explicit);
  if (!shape) return { kind: 'none' };
  const name = enabledTool(shape.name, tools);
  if (!name) return { kind: 'none' };
  if (!shape.hasArguments) return explicit ? { kind: 'call', call: { name, args: {} } } : { kind: 'none' };
  const args = argumentsObject(shape.args);
  if (args) return { kind: 'call', call: { name, args } };
  return {
    kind: 'malformed',
    malformed: { name, problem: `the arguments of ${name} are not a JSON object` },
  };
}

function callShape(
  value: unknown,
  explicit: boolean,
): { name: unknown; args: unknown; hasArguments: boolean } | undefined {
  if (!isPlainObject(value)) return undefined;
  if (isPlainObject(value.function)) {
    return onlyKeys(value, ['function'], explicit) ? callShape(value.function, explicit) : undefined;
  }
  const nameKey = NAME_KEYS.find((key) => Object.hasOwn(value, key));
  const argumentKeys = ARGUMENT_KEYS.filter((key) => Object.hasOwn(value, key));
  if (!nameKey || argumentKeys.length > 1 || !onlyKeys(value, [nameKey, ...argumentKeys], explicit)) {
    return undefined;
  }
  const argumentKey = argumentKeys[0];
  return {
    name: value[nameKey],
    args: argumentKey ? value[argumentKey] : undefined,
    hasArguments: !!argumentKey,
  };
}

/** Marked calls may carry extra keys (a reason, a thought); unmarked JSON must be exactly a call. */
function onlyKeys(value: Record<string, unknown>, keys: string[], explicit: boolean): boolean {
  return explicit || Object.keys(value).every((key) => keys.includes(key) || IGNORED_KEYS.includes(key));
}

function argumentsObject(args: unknown): Record<string, unknown> | undefined {
  if (args === null || args === undefined) return {};
  if (isPlainObject(args)) return args;
  if (typeof args !== 'string') return undefined;
  if (args.trim() === '') return {};
  const parsed = parseJsonLenient(args);
  return parsed.ok && isPlainObject(parsed.value) ? parsed.value : undefined;
}

function enabledTool(name: unknown, tools: ReadonlySet<ToolName>): ToolName | undefined {
  return typeof name === 'string' && isToolName(name) && tools.has(name) ? name : undefined;
}

/** The enabled tool that unreadable call text is about: its name key, else the first enabled tool it mentions. */
function mentionedTool(content: string, tools: ReadonlySet<ToolName>): ToolName | undefined {
  const named = /["']?(?:name|tool)["']?\s*[:=]\s*["']([\w-]+)["']/.exec(content);
  if (named) return enabledTool(named[1], tools);
  for (const word of content.match(/[A-Za-z]+/g) ?? []) {
    const tool = enabledTool(word, tools);
    if (tool) return tool;
  }
  return undefined;
}

/** Several JSON values one after another (some models put each call on its own line); undefined otherwise. */
function jsonSequence(content: string): unknown[] | undefined {
  const values: unknown[] = [];
  let i = 0;
  while (i < content.length) {
    if (/[\s,]/.test(content[i])) {
      i++;
      continue;
    }
    if (content[i] !== '{' && content[i] !== '[') return undefined;
    const { end } = balancedEnd(content, i);
    if (end === -1) return undefined;
    const parsed = parseJsonLenient(content.slice(i, end + 1));
    if (!parsed.ok) return undefined;
    values.push(parsed.value);
    i = end + 1;
  }
  return values.length > 1 ? values : undefined;
}

/** The content of a text that is one code fence, or undefined. */
function unfence(text: string): string | undefined {
  return /^(`{3,})[^\n`]*\r?\n([\s\S]*?)\r?\n?\1$/.exec(text.trim())?.[2];
}

function withoutRegions(text: string, regions: Region[]): string {
  let result = '';
  let position = 0;
  for (const region of regions) {
    result += text.slice(position, region.start);
    position = region.end;
  }
  result += text.slice(position);
  return result.replace(/(?:[ \t]*\r?\n){3,}/g, '\n\n').trim();
}

/** JSON.parse, then once more with trailing commas removed and raw line breaks and tabs in strings escaped. */
export function parseJsonLenient(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    const relaxed = relaxJson(text);
    if (relaxed !== text) {
      try {
        return { ok: true, value: JSON.parse(relaxed) };
      } catch {
        // Report the problem of the original text.
      }
    }
    return { ok: false, error: errorMessage(error) };
  }
}

const ESCAPES: Record<string, string> = { '\n': '\\n', '\r': '\\r', '\t': '\\t' };

function relaxJson(text: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') {
        out += text.slice(i, i + 2);
        i++;
        continue;
      }
      if (ch === '"') inString = false;
      out += ESCAPES[ch] ?? ch;
      continue;
    }
    if (ch === '"') inString = true;
    if (ch === ',' && closesNext(text, i + 1)) continue;
    out += ch;
  }
  return out;
}

function closesNext(text: string, from: number): boolean {
  let i = from;
  while (i < text.length && /\s/.test(text[i])) i++;
  return text[i] === '}' || text[i] === ']';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
