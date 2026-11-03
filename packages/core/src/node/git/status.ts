import { GIT_CHANGED_FILES_MAX } from './capDiff';

/**
 * Paths of `git status --porcelain=v1 -z` output (always relative to the repository root), made relative to the
 * folder with the repository-relative `prefix` (`rev-parse --show-prefix`, e.g. "packages/app/"); files outside it
 * are dropped. Renames and copies count with their new path. Sorted, unique, at most 1,000. Only entries that end
 * with NUL count, so output cut in the middle of an entry is fine.
 */
export function parseStatusZ(output: string, prefix: string): string[] {
  const parts = output.split('\0');
  parts.pop();
  const files = new Set<string>();
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4 || entry[2] !== ' ') continue;
    // In the -z format the original path of a rename or copy follows as its own entry.
    if (/[RC]/.test(entry.slice(0, 2))) i++;
    const path = relativeTo(entry.slice(3), prefix);
    if (path) files.add(path);
  }
  return [...files].sort().slice(0, GIT_CHANGED_FILES_MAX);
}

/** Case-insensitive, because Windows paths may spell the folder differently than the index. */
function relativeTo(path: string, prefix: string): string | undefined {
  if (prefix === '') return path;
  if (path.length <= prefix.length || path.slice(0, prefix.length).toLowerCase() !== prefix.toLowerCase()) {
    return undefined;
  }
  return path.slice(prefix.length);
}
