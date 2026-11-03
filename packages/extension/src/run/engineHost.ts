import * as path from 'node:path';
import {
  executeAgentRequest,
  MaskedStream,
  SecretMasker,
  type ApprovalRequest,
  type ApprovalResult,
  type AskPrompt,
  type AskRequest,
  type AskResult,
  type ConsoleRequest,
  type EngineHost,
  type ModelResolver,
  type ProjectMemory,
  type StepIO,
  type ToolHost,
} from '@isar-flow/core';
import type { RunConsoleCommand, RunManagerDeps, RunTerminal } from '../contracts';
import { dim, errorMessage, formatDuration, green, red, toTerminalText } from './format';

export interface EngineHostDeps {
  runId: string;
  workspaceRoot: string;
  runCommand: RunConsoleCommand;
  /** Mirror terminal of the workflow. */
  terminal: RunTerminal;
  models: ModelResolver;
  toolHost: ToolHost;
  readContextFiles: RunManagerDeps['readContextFiles'];
  /** `signal` aborts when the step times out or the run is cancelled. */
  approve: (req: ApprovalRequest, signal: AbortSignal) => Promise<ApprovalResult>;
  /** Clock for durations; defaults to Date.now. */
  now?: () => number;
  /** Secret values of the run; they are masked in the terminal and in approval prompts like in run events. */
  secrets?: Record<string, string>;
  /** Context size for models that report none (`isarFlow.agentContextTokens`); agents compact above 70 %. */
  contextTokens?: number;
  /**
   * Asks an ask block's question (already masked) and resolves with the answer; `signal` aborts when the block times
   * out or the run is cancelled. Without it the engine answers with the block's default.
   */
  ask?: (prompt: Omit<AskPrompt, 'requestId' | 'runId'>, signal: AbortSignal) => Promise<AskResult>;
  /** Project memory of the run's folder for agents (memory read / write). */
  memory?: ProjectMemory;
}

/** Connects the core engine to VS Code: console blocks run in the console runner and are mirrored to the terminal. */
export function createEngineHost(deps: EngineHostDeps): EngineHost {
  const now = deps.now ?? Date.now;
  const { terminal } = deps;
  const masker = new SecretMasker(deps.secrets);
  let consoleSteps = 0;

  async function runConsole(req: ConsoleRequest, io: StepIO) {
    if (consoleSteps++ === 0) terminal.show(true);
    else terminal.write('\r\n');
    const command = masker.text(req.command).replace(/\r?\n/g, '\n  ');
    terminal.write(`${dim(`▶ ${req.stepId}`)} ${toTerminalText(command)}\r\n`);

    // Commands and their output contain the secret values; the terminal shows them masked.
    const mirror = new MaskedStream(masker);
    let atLineStart = true;
    const show = (text: string) => {
      if (text === '') return;
      terminal.write(toTerminalText(text));
      atLineStart = text.endsWith('\n');
    };
    const startedAt = now();
    const footer = (text: string) => {
      show(mirror.flush());
      const duration = formatDuration(now() - startedAt);
      terminal.write(`${atLineStart ? '' : '\r\n'}${text.replace('{duration}', duration)}\r\n`);
    };

    try {
      const result = await deps.runCommand({
        command: req.command,
        shell: req.shell,
        cwd: path.resolve(deps.workspaceRoot, req.cwd),
        env: req.env,
        ...(req.timeoutMs !== undefined && { timeoutMs: req.timeoutMs }),
        signal: io.signal,
        onData(stream, text) {
          if (text === '') return;
          show(mirror.push(text));
          io.log(stream, text);
        },
      });
      if (result.timedOut) footer(red('✗ timed out · {duration}'));
      else if (result.exitCode === 0) footer(green('✓ exit 0 · {duration}'));
      else footer(red(`✗ exit ${result.exitCode} · {duration}`));
      return result;
    } catch (error) {
      footer(red(`✗ ${io.signal.aborted ? 'cancelled' : masker.text(errorMessage(error))} · {duration}`));
      throw error;
    }
  }

  /** Shows the question masked like run events; a masked choice or default comes back as the real text. */
  async function askUser(ask: NonNullable<EngineHostDeps['ask']>, req: AskRequest, io: StepIO) {
    const choices = req.choices?.map((choice) => masker.text(choice));
    const shownDefault = req.default === undefined ? undefined : masker.text(req.default);
    const { answer } = await ask(
      {
        stepId: req.stepId,
        question: masker.text(req.question),
        ...(choices && { choices }),
        ...(shownDefault !== undefined && { default: shownDefault }),
        ...(req.timeoutMs !== undefined && { expiresAt: now() + req.timeoutMs }),
      },
      io.signal,
    );
    const index = choices?.indexOf(answer) ?? -1;
    if (req.choices && index >= 0) return { answer: req.choices[index] };
    if (req.default !== undefined && answer === shownDefault) return { answer: req.default };
    return { answer };
  }

  const { ask, memory } = deps;
  return {
    runConsole,
    runAgent: (req, io) =>
      executeAgentRequest(req, {
        resolver: deps.models,
        io,
        toolHost: deps.toolHost,
        readContextFiles: deps.readContextFiles,
        ...(deps.contextTokens !== undefined && { contextTokens: deps.contextTokens }),
        ...(memory && { memory }),
      }),
    // The prompt is shown in the canvas or a dialog, so it gets the same masking as run events.
    requestApproval: (req, io) => deps.approve({ ...req, message: masker.text(req.message) }, io.signal),
    ...(ask && { askUser: (req: AskRequest, io: StepIO) => askUser(ask, req, io) }),
  };
}
