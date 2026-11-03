import fs from 'node:fs';
import path from 'node:path';
import { globMatcher } from './glob';

const SKIPPED_FOLDERS = new Set(['node_modules', '.git']);
/** Keeps a search in a huge folder tree finite even when few files match. */
const MAX_ENTRIES = 200_000;

/**
 * Files below `root` whose relative path (forward slashes) matches `glob`, at most `max`, for folders that VS
 * Code's search does not cover (git worktrees in extension storage). Skips node_modules and .git and does not
 * follow linked folders, which may lead anywhere or loop. Folders are read in name order, shallow ones first.
 */
export async function walkFiles(root: string, glob: string, max: number): Promise<string[]> {
  const matches = globMatcher(glob, { ignoreCase: process.platform === 'win32' });
  const found: string[] = [];
  const folders = [''];
  let entriesSeen = 0;
  for (let next = 0; next < folders.length && found.length < max && entriesSeen < MAX_ENTRIES; next++) {
    const folder = folders[next];
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(path.join(root, folder), { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      entriesSeen++;
      const rel = folder === '' ? entry.name : `${folder}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIPPED_FOLDERS.has(entry.name.toLowerCase())) folders.push(rel);
        continue;
      }
      if (!matches(rel) || !(await isFile(root, rel, entry))) continue;
      found.push(rel);
      if (found.length >= max) break;
    }
  }
  return found;
}

/** Plain files, and links that lead to a file (links to folders, junctions included, are not followed). */
async function isFile(root: string, rel: string, entry: fs.Dirent): Promise<boolean> {
  if (entry.isFile()) return true;
  if (!entry.isSymbolicLink()) return false;
  return fs.promises.stat(path.join(root, rel)).then(
    (stat) => stat.isFile(),
    () => false,
  );
}
