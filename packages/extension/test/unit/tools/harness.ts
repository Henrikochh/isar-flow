import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  AgentPermissions,
  ConsoleResult,
  LogStream,
  StepIO,
  ToolHost,
  ToolResult,
} from '@isar-flow/core';
import type {
  ConsoleRunOptions,
  EditJournalWriter,
  PermissionAnswer,
  PermissionRequest,
} from '../../../src/contracts';
import { createToolHost } from '../../../src/tools/toolHost';
import type { ToolWorkspace } from '../../../src/tools/types';
import { removeTempDir } from '../runner/fixtures';

/** WorkspaceAdapter backed by the real file system below `root`. */
export function createFsWorkspace(root: string): ToolWorkspace {
  return {
    readFile: (absPath) => fs.promises.readFile(absPath, 'utf8'),
    writeFile: async (absPath, content) => {
      await fs.promises.mkdir(path.dirname(absPath), { recursive: true });
      await fs.promises.writeFile(absPath, content);
    },
    findFiles: async (glob, max) => {
      const found: string[] = [];
      for await (const entry of fs.promises.glob(glob, { cwd: root })) {
        const rel = entry.split(path.sep).join('/');
        if (rel.split('/').some((part) => part === 'node_modules' || part === '.git')) continue;
        if (!fs.statSync(path.join(root, entry)).isFile()) continue;
        found.push(rel);
        if (found.length >= max) break;
      }
      return found;
    },
    deleteFile: (absPath) => fs.promises.unlink(absPath),
    realPath: (absPath) => fs.promises.realpath(absPath),
    exists: (absPath) =>
      fs.promises.stat(absPath).then(
        () => true,
        () => false,
      ),
    fileSize: (absPath) =>
      fs.promises.stat(absPath).then(
        (stat) => stat.size,
        () => undefined,
      ),
  };
}

export interface Harness {
  root: string;
  host: ToolHost;
  /** Permission requests seen by the fake prompt. */
  prompts: PermissionRequest[];
  /** Answers the fake prompt gives, in order; 'deny' when empty. */
  answers: PermissionAnswer[];
  /** Replaces the scripted answers when set. */
  prompt?: (request: PermissionRequest) => Promise<PermissionAnswer>;
  /** Calls seen by the fake console runner. */
  commands: ConsoleRunOptions[];
  /** What the fake console runner does; default: exit code 0 with "ok". */
  runCommand: (options: ConsoleRunOptions) => Promise<ConsoleResult>;
  logs: { stream: LogStream; text: string }[];
  controller: AbortController;
  write(rel: string, content: string | Buffer): void;
  read(rel: string): string;
  call(name: string, args: Record<string, unknown>, permissions?: AgentPermissions): Promise<ToolResult>;
  cleanup(): void;
}

export function consoleResult(partial: Partial<ConsoleResult> = {}): ConsoleResult {
  const stdout = partial.stdout ?? '';
  const stderr = partial.stderr ?? '';
  return { exitCode: 0, stdout, stderr, output: stdout + stderr, timedOut: false, ...partial };
}

export interface HarnessOptions {
  /** Passed to the tool host, which tells it about every write. */
  journal?: EditJournalWriter;
  /** Changes the file system workspace, e.g. to remove deleteFile or make writes fail. */
  wrap?: (workspace: ToolWorkspace) => ToolWorkspace;
}

export function createHarness(options: HarnessOptions = {}): Harness {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'isar-tools-')));
  const harness: Harness = {
    root,
    host: undefined as unknown as ToolHost,
    prompts: [],
    answers: [],
    commands: [],
    runCommand: async () => consoleResult({ stdout: 'ok\n' }),
    logs: [],
    controller: new AbortController(),
    write: (rel, content) => {
      const file = path.join(root, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    },
    read: (rel) => fs.readFileSync(path.join(root, rel), 'utf8'),
    call: (name, args, permissions = { edits: 'auto', commands: 'auto' }) => {
      const io: StepIO = {
        runId: 'run-1',
        stepId: 'fix',
        signal: harness.controller.signal,
        log: (stream, text) => harness.logs.push({ stream, text }),
      };
      return harness.host.execute({ name, args }, io, permissions);
    },
    cleanup: () => removeTempDir(root),
  };
  harness.host = createToolHost({
    runId: 'run-1',
    workspaceRoot: root,
    workspace: (options.wrap ?? ((workspace) => workspace))(createFsWorkspace(root)),
    defaultShell: 'auto',
    ...(options.journal && { journal: options.journal }),
    runCommand: (options) => {
      harness.commands.push(options);
      return harness.runCommand(options);
    },
    prompt: async (request) => {
      harness.prompts.push(request);
      if (harness.prompt) return harness.prompt(request);
      return harness.answers.shift() ?? 'deny';
    },
  });
  return harness;
}
