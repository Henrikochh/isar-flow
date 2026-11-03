import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CliError } from './errors';

const WORKFLOW_SUFFIX = /\.workflow\.ya?ml$/i;
const GIT_TIMEOUT_MS = 5000;

type Kind = 'file' | 'folder' | undefined;

async function kindOf(target: string): Promise<Kind> {
  try {
    return (await fs.promises.stat(target)).isDirectory() ? 'folder' : 'file';
  } catch {
    return undefined;
  }
}

/**
 * The workflow file for the `run` argument: a path relative to `cwd` (or absolute), or, for a bare name, the
 * workflow of that name in `<cwd>/.isarflow/workflows`.
 */
export async function findWorkflowFile(arg: string, cwd: string): Promise<string> {
  const direct = path.resolve(cwd, arg);
  const kind = await kindOf(direct);
  if (kind === 'file') return direct;
  const name = path.basename(arg).replace(WORKFLOW_SUFFIX, '');
  const hint = `Pass the path of a .workflow.yaml file, e.g. .isarflow/workflows/${name}.workflow.yaml.`;
  if (kind === 'folder') throw new CliError(`'${arg}' is a folder. ${hint}`);
  if (!/[\\/]/.test(arg)) {
    const folder = path.join(cwd, '.isarflow', 'workflows');
    const candidates = WORKFLOW_SUFFIX.test(arg) ? [arg] : [`${arg}.workflow.yaml`, `${arg}.workflow.yml`];
    for (const candidate of candidates) {
      const file = path.join(folder, candidate);
      if ((await kindOf(file)) === 'file') return file;
    }
  }
  throw new CliError(`Could not find '${arg}'. ${hint}`);
}

/**
 * The workspace folder of a run: the nearest folder above the workflow file that contains `.isarflow`, else the
 * top-level folder of its git repository, else the current folder.
 */
export async function findWorkspaceRoot(
  workflowFile: string,
  cwd: string,
  topLevel: (folder: string) => Promise<string | undefined> = gitTopLevel,
): Promise<string> {
  const start = path.dirname(workflowFile);
  for (let folder = start; ; folder = path.dirname(folder)) {
    if ((await kindOf(path.join(folder, '.isarflow'))) === 'folder') return folder;
    if (path.dirname(folder) === folder) break;
  }
  const top = await topLevel(start);
  return top === undefined ? path.resolve(cwd) : path.resolve(top);
}

/** `git rev-parse --show-toplevel` in `folder`; undefined outside a repository, without git or on any failure. */
export function gitTopLevel(folder: string, gitPath = 'git'): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      gitPath,
      ['rev-parse', '--show-toplevel'],
      {
        cwd: folder,
        timeout: GIT_TIMEOUT_MS,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      },
      (error, stdout) => {
        const top = String(stdout).trim();
        resolve(error || top === '' ? undefined : path.normalize(top));
      },
    );
  });
}
