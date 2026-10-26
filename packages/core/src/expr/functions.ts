import { ExpressionError } from './ast';
import { looseEquals, splitLines, stringifyValue, toNumber } from './values';

type Fn = (...args: unknown[]) => unknown;

const str = (value: unknown) => stringifyValue(value);

export function compileRegex(pattern: unknown, flags?: unknown): RegExp {
  try {
    return new RegExp(str(pattern), flags == null ? '' : str(flags));
  } catch (e) {
    throw new ExpressionError(`Invalid regular expression '${str(pattern)}': ${(e as Error).message}`);
  }
}

export interface FunctionInfo {
  name: string;
  signature: string;
  description: string;
}

const FUNCTIONS: Record<string, { fn: Fn; signature: string; description: string }> = {
  contains: {
    signature: 'contains(haystack, needle, ignoreCase?)',
    description: 'True if a text contains a substring, or a list contains a value.',
    fn: (haystack, needle, ignoreCase) => {
      if (haystack == null) return false;
      if (Array.isArray(haystack)) return haystack.some((item) => looseEquals(item, needle));
      if (ignoreCase) return str(haystack).toLowerCase().includes(str(needle).toLowerCase());
      return str(haystack).includes(str(needle));
    },
  },
  startsWith: {
    signature: 'startsWith(text, prefix)',
    description: 'True if the text starts with the prefix.',
    fn: (text, prefix) => str(text).startsWith(str(prefix)),
  },
  endsWith: {
    signature: 'endsWith(text, suffix)',
    description: 'True if the text ends with the suffix.',
    fn: (text, suffix) => str(text).endsWith(str(suffix)),
  },
  matches: {
    signature: 'matches(text, pattern, flags?)',
    description: 'True if the regular expression matches the text.',
    fn: (text, pattern, flags) => compileRegex(pattern, flags).test(str(text)),
  },
  length: {
    signature: 'length(value)',
    description: 'Length of a text or list, number of keys of an object.',
    fn: (value) => {
      if (value == null) return 0;
      if (typeof value === 'string' || Array.isArray(value)) return value.length;
      if (typeof value === 'object') return Object.keys(value).length;
      return str(value).length;
    },
  },
  lower: { signature: 'lower(text)', description: 'Lowercase text.', fn: (text) => str(text).toLowerCase() },
  upper: { signature: 'upper(text)', description: 'Uppercase text.', fn: (text) => str(text).toUpperCase() },
  trim: {
    signature: 'trim(text)',
    description: 'Text without surrounding whitespace.',
    fn: (text) => str(text).trim(),
  },
  head: {
    signature: 'head(text, n)',
    description: 'First n lines of a text.',
    fn: (text, n) =>
      splitLines(str(text))
        .slice(0, Math.max(0, toNumber(n)))
        .join('\n'),
  },
  tail: {
    signature: 'tail(text, n)',
    description: 'Last n lines of a text.',
    fn: (text, n) => {
      const count = Math.max(0, toNumber(n));
      return count === 0 ? '' : splitLines(str(text)).slice(-count).join('\n');
    },
  },
  lines: {
    signature: 'lines(text)',
    description: 'List of lines in a text.',
    fn: (text) => splitLines(str(text)),
  },
  json: {
    signature: 'json(text)',
    description: 'Parses JSON text into a value.',
    fn: (text) => {
      try {
        return JSON.parse(str(text));
      } catch (e) {
        throw new ExpressionError(`json(): invalid JSON (${(e as Error).message})`);
      }
    },
  },
  toJSON: {
    signature: 'toJSON(value)',
    description: 'Formats a value as JSON text.',
    fn: (value) => JSON.stringify(value ?? null, null, 2),
  },
  join: {
    signature: 'join(list, separator?)',
    description: 'Joins list items into one text.',
    fn: (list, separator) =>
      Array.isArray(list)
        ? list.map((item) => str(item)).join(separator == null ? ', ' : str(separator))
        : str(list),
  },
  default: {
    signature: 'default(value, fallback)',
    description: 'The value, or the fallback when it is empty.',
    fn: (value, fallback) => (value == null || value === '' ? fallback : value),
  },
  number: {
    signature: 'number(value)',
    description: 'Converts to a number.',
    fn: (value) => toNumber(value),
  },
  string: { signature: 'string(value)', description: 'Converts to text.', fn: (value) => str(value) },
};

export const FUNCTION_NAMES: readonly string[] = Object.keys(FUNCTIONS);

export const FUNCTION_INFO: readonly FunctionInfo[] = Object.entries(FUNCTIONS).map(([name, f]) => ({
  name,
  signature: f.signature,
  description: f.description,
}));

export function callFunction(name: string, args: unknown[], offset?: number): unknown {
  const entry = Object.prototype.hasOwnProperty.call(FUNCTIONS, name) ? FUNCTIONS[name] : undefined;
  if (!entry) throw new ExpressionError(`Unknown function '${name}'`, offset);
  return entry.fn(...args);
}
