/** Shown instead of a secret value in run events and the run summary. */
export const SECRET_MASK = '••••••';
/** Shorter values would hide ordinary text, e.g. a PIN "12" inside every number. */
const MIN_SECRET_LENGTH = 4;

function isPlainObject(value: object): value is Record<string, unknown> {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Deep copy of JSON-like data with `text` applied to every string. Objects that are not plain data are
 * cloned as they are (or kept when they cannot be cloned); the engine itself only produces plain data.
 */
export function copyData<T>(value: T, text: (value: string) => string = (s) => s): T {
  const seen = new Map<object, unknown>();
  const copy = (item: unknown): unknown => {
    if (typeof item === 'string') return text(item);
    if (typeof item !== 'object' || item === null) return item;
    if (seen.has(item)) return seen.get(item);
    if (Array.isArray(item)) {
      const result: unknown[] = [];
      seen.set(item, result);
      for (const element of item) result.push(copy(element));
      return result;
    }
    if (!isPlainObject(item)) {
      try {
        return structuredClone(item);
      } catch {
        return item;
      }
    }
    const result: Record<string, unknown> = {};
    seen.set(item, result);
    for (const [key, entry] of Object.entries(item)) {
      // defineProperty keeps a JSON key named "__proto__" as a plain key.
      Object.defineProperty(result, key, {
        value: copy(entry),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return result;
  };
  return copy(value) as T;
}

/** Replaces secret values in text and data shown to the user. */
export class SecretMasker {
  /** Longest first, so a secret that contains another one is masked as a whole. */
  private readonly secrets: readonly string[];

  constructor(secrets: Record<string, string> | undefined) {
    const values = Object.values(secrets ?? {}).filter(
      (value): value is string => typeof value === 'string' && value.length >= MIN_SECRET_LENGTH,
    );
    this.secrets = [...new Set(values)].sort((a, b) => b.length - a.length);
  }

  text(value: string): string {
    let result = value;
    for (const secret of this.secrets) {
      if (result.includes(secret)) result = result.split(secret).join(SECRET_MASK);
    }
    return result;
  }

  /** Deep copy with every string masked. */
  data<T>(value: T): T {
    return copyData(value, (s) => this.text(s));
  }

  /** Length of the longest end of `text` that is the beginning of a secret (and could be completed later). */
  partialLength(text: string): number {
    let longest = 0;
    for (const secret of this.secrets) {
      const first = secret[0];
      // The earliest match is the longest one, so the search stops there.
      for (let at = text.indexOf(first, Math.max(0, text.length - secret.length + 1)); at !== -1;) {
        if (secret.startsWith(text.slice(at))) {
          longest = Math.max(longest, text.length - at);
          break;
        }
        at = text.indexOf(first, at + 1);
      }
    }
    return longest;
  }
}

/**
 * Masks text that arrives in chunks, where a secret may be split between two chunks: an end that could be the
 * beginning of a secret is held back until the next chunk (or `flush`) shows whether it is one.
 */
export class MaskedStream {
  private pending = '';

  constructor(private readonly masker: SecretMasker) {}

  push(chunk: string): string {
    const text = this.masker.text(this.pending + chunk);
    const keep = this.masker.partialLength(text);
    this.pending = text.slice(text.length - keep);
    return text.slice(0, text.length - keep);
  }

  flush(): string {
    const rest = this.pending;
    this.pending = '';
    return rest;
  }
}
