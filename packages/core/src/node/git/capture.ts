import type { GitContext } from '../../engine/types';
import type { CaptureGitContext, GitCaptureOptions } from '../types';
import { capDiff, GIT_DIFF_MAX_BYTES } from './capDiff';
import { type CappedRunResult, runCapped } from './process';
import { parseStatusZ } from './status';

const DEFAULT_TIMEOUT_MS = 5000;
/** Status output kept for sorting; a repository with more changes gets the first paths git printed. */
const STATUS_MAX_BYTES = 8 * 1024 * 1024;
const SMALL_OUTPUT_BYTES = 64 * 1024;
/** Read a little past the cap, so the cut can find a character boundary and knows there was more. */
const DIFF_SLACK_BYTES = 4;

/**
 * Raw UTF-8 paths, no colors, long paths on Windows. Optional locks and terminal prompts are turned off through
 * the environment.
 */
const BASE_ARGS = [
  '-c',
  'core.quotepath=off',
  '-c',
  'color.ui=never',
  ...(process.platform === 'win32' ? ['-c', 'core.longpaths=true'] : []),
];
const DIFF_ARGS = ['--no-color', '--no-ext-diff', '--relative', '--', '.'];

/** Variables that would point git at another repository or index than the one of the folder. */
const INHERITED = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY'];

type Git = (args: string[], maxBytes: number) => Promise<CappedRunResult>;

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of INHERITED) delete env[name];
  return { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
}

/**
 * `git.*` of a folder: branch, changed files relative to the folder, and `git diff HEAD` limited to the folder and
 * cut at 100 KB. Never rejects; outside a repository, without git, after a timeout or an abort the affected fields
 * are empty. Never runs a shell.
 */
export const captureGitContext: CaptureGitContext = async (root, options = {}) => {
  const git = gitRunner(root, options);
  const top = await git(['rev-parse', '--is-inside-work-tree', '--show-prefix'], SMALL_OUTPUT_BYTES);
  const [inside, prefix = ''] = text(top).split('\n');
  if (!top.ok || inside.trim() !== 'true') return emptyGitContext();

  const maxDiffBytes = Math.max(1, options.maxDiffBytes ?? GIT_DIFF_MAX_BYTES);
  const [branch, changedFiles, diff] = await Promise.all([
    git(['symbolic-ref', '--short', '-q', 'HEAD'], SMALL_OUTPUT_BYTES).then((r) =>
      r.ok ? text(r).trim() : '',
    ),
    git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.'], STATUS_MAX_BYTES).then((r) =>
      r.ok ? parseStatusZ(text(r), prefix.replace(/\r$/, '')) : [],
    ),
    captureDiff(git, maxDiffBytes),
  ]);
  return { branch, changedFiles, diff };
};

function emptyGitContext(): GitContext {
  return { branch: '', changedFiles: [], diff: '' };
}

function gitRunner(root: string, options: GitCaptureOptions): Git {
  const env = gitEnv();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return (args, maxBytes) =>
    runCapped(options.gitPath ?? 'git', [...BASE_ARGS, ...args], {
      cwd: root,
      env,
      timeoutMs,
      maxBytes,
      ...(options.signal && { signal: options.signal }),
    });
}

const text = (result: CappedRunResult) => result.stdout.toString('utf8');

/**
 * `git diff HEAD`; on an unborn branch (no commit yet) the staged changes followed by the unstaged ones. Stops
 * reading at the cap and adds git's `--shortstat` of the whole diff to the note.
 */
async function captureDiff(git: Git, maxBytes: number): Promise<string> {
  const head = await git(['rev-parse', '--verify', '-q', 'HEAD'], SMALL_OUTPUT_BYTES);
  if (head.failure) return '';
  const parts = head.ok ? [['diff', 'HEAD']] : [['diff', '--cached'], ['diff']];
  const labels = head.ok ? [''] : ['staged: ', 'not staged: '];

  let diff = '';
  let room = maxBytes + DIFF_SLACK_BYTES;
  for (const part of parts) {
    if (room <= 0) break;
    const result = await git([...part, ...DIFF_ARGS], room);
    if (!result.ok) return '';
    diff += text(result);
    room -= result.stdout.length;
    if (result.truncated) break;
  }
  if (new TextEncoder().encode(diff).length <= maxBytes) return diff;

  const totals = await Promise.all(
    parts.map((part) => git([...part, '--shortstat', ...DIFF_ARGS], SMALL_OUTPUT_BYTES)),
  );
  const total = totals
    .map((result, i) => (result.ok && text(result).trim() !== '' ? `${labels[i]}${text(result).trim()}` : ''))
    .filter((line) => line !== '')
    .join('; ');
  return capDiff(diff, maxBytes, total);
}
