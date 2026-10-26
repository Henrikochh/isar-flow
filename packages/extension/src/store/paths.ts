/** Pure name and path helpers for the stores. Paths are URI paths (forward slashes). */

const MAX_SLUG_LENGTH = 48;
const GERMAN: Record<string, string> = { ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' };

/** File-name-safe id: lowercase ASCII letters, digits and single dashes, at most 48 characters. */
export function slugify(name: string, fallback: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[äöüß]/g, (c) => GERMAN[c])
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/, '');
  return slug === '' ? fallback : slug;
}

/** `base` when free, otherwise `base-2`, `base-3`, … */
export function uniqueName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

const SUFFIX = {
  agent: /\.agent\.ya?ml$/i,
  workflow: /\.workflow\.ya?ml$/i,
};

/** Id of an agent or workflow file (`coder.agent.yaml` → `coder`); undefined for other files. */
export function fileId(fileName: string, kind: 'agent' | 'workflow'): string | undefined {
  const match = SUFFIX[kind].exec(fileName);
  if (!match || match.index === 0) return undefined;
  return fileName.slice(0, match.index);
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

export function dirName(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? '' : path.slice(0, index);
}

const trimSlash = (path: string) => path.replace(/\/+$/, '');

export function samePath(a: string, b: string, ignoreCase: boolean): boolean {
  const [x, y] = [trimSlash(a), trimSlash(b)];
  return ignoreCase ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/** `filePath` relative to `folderPath`; the file name when the file is not inside the folder. */
export function relativeTo(folderPath: string, filePath: string, ignoreCase: boolean): string {
  const prefix = `${trimSlash(folderPath)}/`;
  const inside = ignoreCase
    ? filePath.toLowerCase().startsWith(prefix.toLowerCase())
    : filePath.startsWith(prefix);
  return inside ? filePath.slice(prefix.length) : baseName(filePath);
}

/** File systems on Windows and macOS are case-insensitive by default. */
export const IGNORE_PATH_CASE = process.platform === 'win32' || process.platform === 'darwin';
