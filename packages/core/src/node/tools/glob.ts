/**
 * A small glob matcher for workspace-relative paths with forward slashes, used where VS Code's search does not
 * reach (folders outside the workspace): `**` (any number of folders), `*` and `?` (within one name),
 * `{a,b}` (nested too) and `[abc]` / `[a-z]` / `[!abc]`.
 */
export function globMatcher(glob: string, options: { ignoreCase?: boolean } = {}): (path: string) => boolean {
  const regex = new RegExp(`^${translate(glob, 0, false).source}$`, options.ignoreCase ? 'i' : '');
  return (path) => regex.test(path);
}

interface Piece {
  source: string;
  end: number;
}

function translate(glob: string, start: number, inBraces: boolean): Piece {
  let source = '';
  let i = start;
  while (i < glob.length) {
    const c = glob[i];
    if (inBraces && (c === ',' || c === '}')) break;
    if (c === '*') {
      let end = i;
      while (glob[end] === '*') end++;
      const wholeName =
        end - i > 1 &&
        (i === start || glob[i - 1] === '/') &&
        (end === glob.length || glob[end] === '/' || (inBraces && (glob[end] === ',' || glob[end] === '}')));
      if (wholeName && glob[end] === '/') {
        source += '(?:[^/]*/)*';
        i = end + 1;
      } else {
        source += wholeName ? '.*' : '[^/]*';
        i = end;
      }
      continue;
    }
    const piece = c === '[' ? charClass(glob, i) : c === '{' ? alternatives(glob, i) : undefined;
    if (piece) {
      source += piece.source;
      i = piece.end;
      continue;
    }
    source += c === '?' ? '[^/]' : escapeRegExp(c);
    i++;
  }
  return { source, end: i };
}

/** `{a,b}` as a group of alternatives; undefined when the brace is never closed (then it is literal). */
function alternatives(glob: string, open: number): Piece | undefined {
  const parts: string[] = [];
  let i = open + 1;
  for (;;) {
    const part = translate(glob, i, true);
    parts.push(part.source);
    if (glob[part.end] === ',') {
      i = part.end + 1;
      continue;
    }
    if (glob[part.end] === '}') return { source: `(?:${parts.join('|')})`, end: part.end + 1 };
    return undefined;
  }
}

/** `[abc]`, `[a-z]`, `[!abc]` or `[^abc]` (never matching `/`); undefined when not closed. */
function charClass(glob: string, open: number): Piece | undefined {
  let i = open + 1;
  const negate = glob[i] === '!' || glob[i] === '^';
  if (negate) i++;
  const bodyStart = i;
  if (glob[i] === ']') i++;
  while (i < glob.length && glob[i] !== ']') i++;
  if (i >= glob.length) return undefined;
  const body = glob.slice(bodyStart, i).replace(/[\\\]^]/g, '\\$&');
  return { source: negate ? `[^/${body}]` : `[${body}]`, end: i + 1 };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
