import type { Step, Workflow } from '../schema/types';

/** Keys that hold nested blocks, which have hashes of their own. */
function childKeys(type: unknown): readonly string[] {
  if (type === 'loop') return ['steps'];
  if (type === 'if') return ['then', 'else'];
  return [];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** cyrb53: a fast, synchronous 53-bit string hash (public domain, by bryc). */
function cyrb53(text: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/**
 * JSON text with object keys sorted at every level, so equal content gives equal text. Values JSON can't hold
 * are treated like JSON.stringify treats them; a value that contains itself is cut off.
 */
function canonicalJson(value: unknown, path: readonly object[] = []): string | undefined {
  switch (typeof value) {
    case 'string':
    case 'number':
    case 'boolean':
      return JSON.stringify(value);
    case 'bigint':
      return value.toString();
    case 'object':
      break;
    default:
      return undefined;
  }
  if (value === null) return 'null';
  if (path.includes(value)) return '"[circular]"';
  const inner = [...path, value];
  if (Array.isArray(value)) {
    return `[${value.map((item: unknown) => canonicalJson(item, inner) ?? 'null').join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .flatMap((key) => {
      const text = canonicalJson(record[key], inner);
      return text === undefined ? [] : [`${JSON.stringify(key)}:${text}`];
    });
  return `{${entries.join(',')}}`;
}

/**
 * Hash of a block's own YAML content: without its display name and without the blocks nested in it, so a
 * container keeps its hash when only its children change. 14 lowercase hex characters.
 */
export function blockHash(step: Step): string {
  const record: Record<string, unknown> = isRecord(step) ? step : {};
  const skipped = new Set(['name', ...childKeys(record.type)]);
  const own = Object.fromEntries(Object.entries(record).filter(([key]) => !skipped.has(key)));
  return cyrb53(canonicalJson(own) ?? '')
    .toString(16)
    .padStart(14, '0');
}

/** Hash of every block with an id, by id, in document order; the first of duplicate ids wins. */
export function blockHashes(workflow: Workflow | null | undefined): Record<string, string> {
  const hashes = new Map<string, string>();
  const visit = (list: unknown) => {
    if (!Array.isArray(list)) return;
    for (const item of list) {
      if (!isRecord(item)) continue;
      const id = item.id;
      if (typeof id === 'string' && id !== '' && !hashes.has(id)) {
        hashes.set(id, blockHash(item as unknown as Step));
      }
      for (const key of childKeys(item.type)) visit(item[key]);
    }
  };
  visit(isRecord(workflow) ? workflow.steps : undefined);
  return Object.fromEntries(hashes);
}
