import { ToolError } from './types';

export interface HunkLine {
  kind: ' ' | '-' | '+';
  text: string;
}

export interface PatchHunk {
  /** The @@ line as written, without the section heading after it, e.g. '@@ -40,7 +40,8 @@'. */
  header: string;
  /** 1-based; undefined for '@@ @@' (search the whole file). */
  oldStart?: number;
  /** Undefined when the header leaves it out ('@@ -12 +12 @@'): then the lines decide where the hunk ends. */
  oldCount?: number;
  newStart?: number;
  newCount?: number;
  lines: HunkLine[];
  /** "\ No newline at end of file" follows the hunk's last new line (used when the patch creates a file). */
  noNewlineAtEnd: boolean;
}

export interface FilePatch {
  /** Workspace path before the change; null when the patch creates the file ("--- /dev/null"). */
  oldPath: string | null;
  /** Workspace path after the change; null when the patch deletes the file ("+++ /dev/null"). */
  newPath: string | null;
  hunks: PatchHunk[];
}

export const patchPath = (file: FilePatch): string => file.newPath ?? file.oldPath ?? '';

const NO_CHANGES =
  'The patch has no file changes. Write a unified diff: "--- a/src/app.ts" and "+++ b/src/app.ts", ' +
  'then hunks that start with "@@ -<line>,<count> +<line>,<count> @@".';
const HUNK_HEADER = /^@@+\s*(?:-(\d+)(?:,(\d+))?)?\s*(?:\+(\d+)(?:,(\d+))?)?\s*(@@+)?/;
const TIMESTAMP = /\s+\d{4}-\d\d-\d\d(?:[ T]\d\d:\d\d(?::\d\d(?:\.\d+)?)?)?(?:\s*[+-]\d{4})?$/;

/** Extended header lines of one "diff --git" section. */
interface GitSection {
  paths: [string, string] | undefined;
  newFile: boolean;
  deletedFile: boolean;
  binary: boolean;
  renameFrom?: string;
  renameTo?: string;
}

/**
 * Parses a unified diff as models write it: prose and code fences around it, "diff --git" and "index" lines,
 * a/ b/ prefixes, timestamps, quoted paths, CRLF text, hunks without counts or line numbers. Throws ToolError
 * with a message for the model when it cannot be applied as a whole (renames, binary files, a file twice).
 */
export function parseUnifiedDiff(patch: string): FilePatch[] {
  const lines = patch.split(/\r\n|\n|\r/);
  const files: FilePatch[] = [];
  let git: GitSection | undefined;
  // The file whose hunks follow; hunks after prose still belong to it, so none is silently dropped.
  let current: FilePatch | undefined;
  const endGitSection = () => {
    if (git) files.push(...headerOnlyFile(git));
    git = undefined;
  };

  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      endGitSection();
      current = undefined;
      git = newGitSection(line.slice('diff --git '.length));
      i++;
    } else if (git && readExtendedHeader(git, line)) {
      i++;
    } else if (isFileHeaderAt(lines, i)) {
      current = fileFromHeaders(lines[i], lines[i + 1], git);
      files.push(current);
      git = undefined;
      i += 2;
    } else if (current && line.startsWith('@@')) {
      const { hunk, next } = readHunk(lines, i);
      current.hunks.push(hunk);
      i = next;
    } else {
      // Prose, fences and blank lines between files; a git section without "---"/"+++" ends here.
      if (git && line.trim() !== '') endGitSection();
      i++;
    }
  }
  endGitSection();
  validate(files);
  return files;
}

function newGitSection(rest: string): GitSection {
  return { paths: gitPaths(rest), newFile: false, deletedFile: false, binary: false };
}

function readExtendedHeader(git: GitSection, line: string): boolean {
  if (line.startsWith('new file mode')) git.newFile = true;
  else if (line.startsWith('deleted file mode')) git.deletedFile = true;
  else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) git.binary = true;
  else if (line.startsWith('rename from ') || line.startsWith('copy from '))
    git.renameFrom = afterWord(line, 2);
  else if (line.startsWith('rename to ') || line.startsWith('copy to ')) git.renameTo = afterWord(line, 2);
  else if (!/^(index |old mode |new mode |similarity index |dissimilarity index )/.test(line)) return false;
  return true;
}

function afterWord(line: string, words: number): string {
  return parsePath(line.split(' ').slice(words).join(' ')) ?? '';
}

/** A "diff --git" section without "---"/"+++": an empty file created or deleted, a mode change, or refused. */
function headerOnlyFile(git: GitSection): FilePatch[] {
  const [oldPath, newPath] = git.paths ?? ['', ''];
  checkRenameAndBinary(git, newPath || oldPath);
  if (git.newFile && newPath) return [{ oldPath: null, newPath, hunks: [] }];
  if (git.deletedFile && oldPath) return [{ oldPath, newPath: null, hunks: [] }];
  return [];
}

function checkRenameAndBinary(git: GitSection | undefined, path: string): void {
  if (git?.renameFrom !== undefined || git?.renameTo !== undefined) {
    throw renameError(git.renameFrom ?? path, git.renameTo ?? path);
  }
  if (git?.binary) {
    throw new ToolError(
      `applyPatch cannot change binary files (${path}). Leave binary files out of the patch.`,
    );
  }
}

function renameError(from: string, to: string): ToolError {
  return new ToolError(
    `applyPatch cannot rename or copy files (${from} to ${to}). Create the new file with writeFile; ` +
      'to remove the old one, use a patch with "+++ /dev/null" that removes all its lines.',
  );
}

function isFileHeaderAt(lines: string[], i: number): boolean {
  return lines[i].startsWith('--- ') && (lines[i + 1]?.startsWith('+++ ') ?? false);
}

function fileFromHeaders(oldLine: string, newLine: string, git: GitSection | undefined): FilePatch {
  const oldRaw = parsePath(oldLine.slice(4));
  const newRaw = parsePath(newLine.slice(4));
  const path = (newRaw ?? oldRaw ?? '').replace(/^[ab]\//, '');
  checkRenameAndBinary(git, path);
  if (oldRaw === null && newRaw === null) {
    throw new ToolError(
      'The patch has "/dev/null" on both sides of a file. Name the file in "--- a/<path>" or "+++ b/<path>".',
    );
  }
  if (oldRaw === null) return { oldPath: null, newPath: stripPrefix(newRaw ?? '', 'b/'), hunks: [] };
  if (newRaw === null) return { oldPath: stripPrefix(oldRaw, 'a/'), newPath: null, hunks: [] };
  const same = samePath(oldRaw, newRaw);
  if (same === undefined) throw renameError(stripPrefix(oldRaw, 'a/'), stripPrefix(newRaw, 'b/'));
  return { oldPath: same, newPath: same, hunks: [] };
}

/** The path both headers name, allowing git's a/ and b/ prefixes on either side; undefined for two paths. */
function samePath(oldPath: string, newPath: string): string | undefined {
  if (oldPath === newPath) return oldPath;
  const oldBare = stripPrefix(oldPath, 'a/');
  const newBare = stripPrefix(newPath, 'b/');
  if (oldBare === newBare || oldBare === newPath) return oldBare;
  if (newBare === oldPath) return newBare;
  return undefined;
}

function stripPrefix(path: string, prefix: string): string {
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

/** Path of a "---"/"+++" line: quoted or plain, without a timestamp; null for /dev/null. */
function parsePath(rest: string): string | null {
  const text = rest.trimStart();
  const path = text.startsWith('"')
    ? (unquote(text)?.value ?? text)
    : text.split('\t')[0].replace(TIMESTAMP, '').trimEnd();
  return path === '/dev/null' ? null : path;
}

/** The two paths of "diff --git a/x b/x": quoted, or split where both halves name the same file. */
function gitPaths(rest: string): [string, string] | undefined {
  if (rest.startsWith('"')) {
    const first = unquote(rest);
    if (!first) return undefined;
    const tail = rest.slice(first.length).trimStart();
    const second = tail.startsWith('"') ? unquote(tail)?.value : tail;
    return second === undefined ? undefined : [stripPrefix(first.value, 'a/'), stripPrefix(second, 'b/')];
  }
  const splits = [...rest.matchAll(/ /g)].map((m) => [rest.slice(0, m.index), rest.slice(m.index + 1)]);
  const [a, b] =
    splits.find(([x, y]) => stripPrefix(x, 'a/') === stripPrefix(y, 'b/')) ??
    splits.find(([, y]) => y.startsWith('b/') || y.startsWith('"')) ??
    [];
  if (a === undefined || b === undefined) return undefined;
  return [stripPrefix(a, 'a/'), stripPrefix(b.startsWith('"') ? (unquote(b)?.value ?? b) : b, 'b/')];
}

const ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };

/** A C-style quoted string as git writes it (octal bytes for non-ASCII), and how many characters it used. */
function unquote(text: string): { value: string; length: number } | undefined {
  const bytes: number[] = [];
  for (let i = 1; i < text.length; i++) {
    const c = text[i];
    if (c === '"') return { value: Buffer.from(bytes).toString('utf8'), length: i + 1 };
    if (c !== '\\') {
      bytes.push(...Buffer.from(c, 'utf8'));
      continue;
    }
    const next = text[i + 1] ?? '';
    const octal = /^[0-7]{1,3}/.exec(text.slice(i + 1))?.[0];
    if (octal) {
      bytes.push(parseInt(octal, 8) & 0xff);
      i += octal.length;
    } else {
      bytes.push(ESCAPES[next] ?? next.charCodeAt(0));
      i++;
    }
  }
  return undefined;
}

/**
 * Reads one hunk starting at its @@ line. Counts in the header are a guide only: models often get them wrong,
 * so the hunk also ends at the next header, a fence or prose, and goes on when more hunk lines follow.
 */
function readHunk(lines: string[], start: number): { hunk: PatchHunk; next: number } {
  const header = lines[start];
  const match = HUNK_HEADER.exec(header);
  const num = (index: number) => (match?.[index] === undefined ? undefined : Number(match[index]));
  const hunk: PatchHunk = {
    header: match?.[5] ? match[0].trim() : header.trim(),
    ...(num(1) !== undefined && { oldStart: num(1) }),
    ...(num(2) !== undefined && { oldCount: num(2) }),
    ...(num(3) !== undefined && { newStart: num(3) }),
    ...(num(4) !== undefined && { newCount: num(4) }),
    lines: [],
    noNewlineAtEnd: false,
  };
  const { oldCount, newCount } = hunk;
  let oldSeen = 0;
  let newSeen = 0;
  let bareTail = 0;
  const countsDone = () =>
    oldCount !== undefined && newCount !== undefined && oldSeen >= oldCount && newSeen >= newCount;
  const countsOpen = () => oldCount !== undefined && newCount !== undefined && !countsDone();

  let i = start + 1;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('\\')) {
      if (hunk.lines.length > 0 && hunk.lines[hunk.lines.length - 1].kind !== '-') hunk.noNewlineAtEnd = true;
      continue;
    }
    if (line.startsWith('@@') || line.startsWith('diff ') || line.startsWith('Index: ') || isFence(line))
      break;
    if (!countsOpen() && isFileHeaderAt(lines, i)) break;
    if (line === '') {
      if (countsDone()) break;
      hunk.lines.push({ kind: ' ', text: '' });
      oldSeen++;
      newSeen++;
      bareTail++;
      continue;
    }
    const kind = line[0];
    if (kind !== ' ' && kind !== '-' && kind !== '+') break;
    hunk.lines.push({ kind, text: line.slice(1) });
    if (kind !== '+') oldSeen++;
    if (kind !== '-') newSeen++;
    bareTail = 0;
  }
  // Blank lines after a hunk usually separate it from what follows; they are not context.
  if (bareTail > 0) hunk.lines.splice(hunk.lines.length - bareTail, bareTail);
  return { hunk, next: i };
}

function isFence(line: string): boolean {
  return line.startsWith('```') || line.startsWith('~~~');
}

function validate(files: FilePatch[]): void {
  if (files.length === 0) throw new ToolError(NO_CHANGES);
  const seen = new Set<string>();
  for (const file of files) {
    const path = patchPath(file);
    if (seen.has(path)) {
      throw new ToolError(
        `The patch changes ${path} more than once. Put all changes to a file into one section.`,
      );
    }
    seen.add(path);
    const headerOnly = file.hunks.length === 0 && (file.oldPath === null || file.newPath === null);
    if (file.hunks.length === 0 && !headerOnly) {
      throw new ToolError(
        `The patch for ${path} has no hunks. Add the changes as hunks that start with "@@".`,
      );
    }
    file.hunks.forEach((hunk, index) => {
      if (hunk.lines.length === 0) {
        throw new ToolError(
          `Hunk ${index + 1} of ${path} (${hunk.header}) has no lines. ` +
            'Add the lines to remove ("-"), add ("+") and keep (" ").',
        );
      }
      if (file.oldPath === null && hunk.lines.some((line) => line.kind !== '+')) {
        throw new ToolError(
          `The patch creates ${path} ("--- /dev/null"), so its hunks can only add lines ("+").`,
        );
      }
      if (file.newPath === null && hunk.lines.some((line) => line.kind === '+')) {
        throw new ToolError(
          `The patch deletes ${path} ("+++ /dev/null"), so its hunks cannot add lines ("+").`,
        );
      }
    });
  }
}
