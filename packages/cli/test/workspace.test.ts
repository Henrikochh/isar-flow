import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CliError } from '../src/errors';
import { findWorkflowFile, findWorkspaceRoot, gitTopLevel } from '../src/workspace';
import { makeTempDir, removeDir, writeFile } from './helpers';

let dir: string;

beforeEach(() => {
  dir = makeTempDir('isar cli workspace-');
});
afterEach(() => removeDir(dir));

describe('findWorkflowFile', () => {
  it('takes a path relative to the current folder, also with spaces', async () => {
    const file = writeFile(dir, 'flows/my flow.workflow.yaml', 'x');
    expect(await findWorkflowFile('flows/my flow.workflow.yaml', dir)).toBe(file);
    expect(await findWorkflowFile(file, path.join(dir, 'elsewhere'))).toBe(file);
  });

  it('finds a workflow by name in .isarflow/workflows', async () => {
    const yaml = writeFile(dir, '.isarflow/workflows/fix-tests.workflow.yaml', 'x');
    const yml = writeFile(dir, '.isarflow/workflows/lint.workflow.yml', 'x');
    expect(await findWorkflowFile('fix-tests', dir)).toBe(yaml);
    expect(await findWorkflowFile('lint', dir)).toBe(yml);
    expect(await findWorkflowFile('fix-tests.workflow.yaml', dir)).toBe(yaml);
  });

  it('says how to name the file when it is missing', async () => {
    await expect(findWorkflowFile('fix-tests', dir)).rejects.toThrow(
      new CliError(
        "Could not find 'fix-tests'. Pass the path of a .workflow.yaml file, e.g. .isarflow/workflows/fix-tests.workflow.yaml.",
      ),
    );
    await expect(findWorkflowFile('flows/fix.workflow.yaml', dir)).rejects.toThrow(
      "Could not find 'flows/fix.workflow.yaml'. Pass the path of a .workflow.yaml file, e.g. .isarflow/workflows/fix.workflow.yaml.",
    );
  });

  it('refuses folders', async () => {
    fs.mkdirSync(path.join(dir, 'flows'));
    await expect(findWorkflowFile('flows', dir)).rejects.toThrow(
      "'flows' is a folder. Pass the path of a .workflow.yaml file, e.g. .isarflow/workflows/flows.workflow.yaml.",
    );
  });
});

describe('findWorkspaceRoot', () => {
  it('uses the nearest folder that contains .isarflow', async () => {
    const file = writeFile(dir, 'repo/.isarflow/workflows/a.workflow.yaml', 'x');
    writeFile(dir, '.isarflow/config.yaml', '');
    const git = vi.fn(async () => dir);
    expect(await findWorkspaceRoot(file, dir, git)).toBe(path.join(dir, 'repo'));
    expect(git).not.toHaveBeenCalled();
  });

  it('falls back to the git top-level folder, then the current folder', async () => {
    const file = writeFile(dir, 'pkg/flows/a.workflow.yaml', 'x');
    const top = path.join(dir, 'pkg');
    expect(await findWorkspaceRoot(file, dir, async () => top)).toBe(top);
    expect(await findWorkspaceRoot(file, dir, async () => undefined)).toBe(dir);
  });
});

describe('gitTopLevel', () => {
  it('is undefined outside a repository or without git', async () => {
    expect(await gitTopLevel(dir, 'git-that-does-not-exist')).toBeUndefined();
  });

  it('finds the top-level folder of this repository', async () => {
    const top = await gitTopLevel(__dirname);
    if (top === undefined) return; // No git, or the sources are not a git checkout.
    expect(fs.existsSync(path.join(top, 'packages', 'cli'))).toBe(true);
  });
});
