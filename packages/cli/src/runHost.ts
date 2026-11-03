import { type EngineHost, SecretMasker } from '@isar-flow/core';
import {
  createFsWorkspaceAdapter,
  createToolHostFactory,
  createWorkspaceContextReader,
  type PermissionPrompt,
  runConsoleCommand,
} from '@isar-flow/core/node';
import { createCliHost } from './host';
import type { CliIo } from './io';
import type { LineReader } from './lineReader';
import { createFsProjectMemory } from './memory';
import { createCliModelResolver } from './models';
import type { PreparedRun } from './prepare';
import { createTerminalPrompts } from './prompts';

export interface RunHostOptions {
  run: PreparedRun;
  runId: string;
  io: CliIo;
  yes: boolean;
  /** Reads answers from the terminal; omitted without one. */
  reader?: LineReader;
}

/**
 * The host of a real command line run: console commands, agents with their tools (file system of the workspace
 * folder), context files and project memory, and prompts in the terminal.
 */
export function createRunHost({ run, runId, io, yes, reader }: RunHostOptions): EngineHost {
  const runCommand = io.runCommand ?? runConsoleCommand;
  const masker = new SecretMasker(run.secrets);
  const prompts = createTerminalPrompts({ output: io.stderr, yes, ...(reader && { reader }) });
  const permission: PermissionPrompt = (request) =>
    prompts.permission({
      ...request,
      summary: masker.text(request.summary),
      ...(request.detail !== undefined && { detail: masker.text(request.detail) }),
    });
  const workspace = createFsWorkspaceAdapter(run.root);
  const toolHost = createToolHostFactory({
    defaultRoot: () => run.root,
    workspace: (root) => (root === run.root ? workspace : createFsWorkspaceAdapter(root)),
    defaultShell: () => 'auto',
    runCommand,
    prompt: permission,
  })(runId, run.root);

  return createCliHost({
    root: run.root,
    runCommand,
    models: createCliModelResolver({
      config: run.config,
      env: io.env,
      ...(io.platform && { platform: io.platform }),
      ...(io.fetch && { fetch: io.fetch }),
    }),
    prompts: { ...prompts, permission },
    secrets: run.secrets,
    toolHost,
    readContextFiles: createWorkspaceContextReader(run.root, workspace),
    memory: createFsProjectMemory(run.root, { secrets: Object.values(run.secrets) }),
  });
}
