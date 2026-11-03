import path from 'node:path';
import {
  type AskRequest,
  type EngineHost,
  executeAgentRequest,
  type ModelResolver,
  type ProjectMemory,
  SecretMasker,
  type StepIO,
  type ToolHost,
} from '@isar-flow/core';
import type { ReadContextFiles, RunConsoleCommand } from '@isar-flow/core/node';
import type { TerminalPrompts } from './prompts';

/** Context size for compaction when a model reports none (the VS Code default of isarFlow.agentContextTokens). */
export const CLI_CONTEXT_TOKENS = 24_000;

export interface CliHostDeps {
  /** Workspace folder; relative working folders of console blocks are resolved against it. */
  root: string;
  runCommand: RunConsoleCommand;
  models: ModelResolver;
  prompts: TerminalPrompts;
  /** Secret values of the run, masked in everything shown in the terminal. */
  secrets: Record<string, string>;
  toolHost: ToolHost;
  readContextFiles: ReadContextFiles;
  memory?: ProjectMemory;
}

/** Engine host of a command line run: console runner, agents with OpenAI-compatible models, terminal prompts. */
export function createCliHost(deps: CliHostDeps): EngineHost {
  const masker = new SecretMasker(deps.secrets);

  /** Shows the question masked like run events; a masked choice or default comes back as the real text. */
  async function askUser(req: AskRequest, io: StepIO) {
    const choices = req.choices?.map((choice) => masker.text(choice));
    const shownDefault = req.default === undefined ? undefined : masker.text(req.default);
    const { answer } = await deps.prompts.ask(
      {
        stepId: req.stepId,
        question: masker.text(req.question),
        ...(choices && { choices }),
        ...(shownDefault !== undefined && { default: shownDefault }),
        ...(req.timeoutMs !== undefined && { timeoutMs: req.timeoutMs }),
      },
      io.signal,
    );
    const index = choices?.indexOf(answer) ?? -1;
    if (req.choices && index >= 0) return { answer: req.choices[index] };
    if (req.default !== undefined && answer === shownDefault) return { answer: req.default };
    return { answer };
  }

  return {
    runConsole: (req, io) =>
      deps.runCommand({
        command: req.command,
        shell: req.shell,
        cwd: path.resolve(deps.root, req.cwd),
        env: req.env,
        ...(req.timeoutMs !== undefined && { timeoutMs: req.timeoutMs }),
        signal: io.signal,
        onData: (stream, text) => io.log(stream, text),
      }),
    runAgent: (req, io) =>
      executeAgentRequest(req, {
        resolver: deps.models,
        io,
        toolHost: deps.toolHost,
        readContextFiles: deps.readContextFiles,
        contextTokens: CLI_CONTEXT_TOKENS,
        ...(deps.memory && { memory: deps.memory }),
      }),
    requestApproval: (req, io) =>
      deps.prompts.approve({ stepId: req.stepId, message: masker.text(req.message) }, io.signal),
    askUser,
  };
}
