import { type ExpressionContext, stringifyValue } from '../expr';
import type { ChatMessage } from '../models/types';
import { STEP_TYPES, walkSteps } from '../schema/steps';
import type { IfStep, LoopStep, Step, Workflow } from '../schema/types';
import {
  checkCondition,
  errorMessage,
  expressionContext,
  type LoopVars,
  renderEnv,
  renderField,
  resolveInputs,
  type RunScope,
  StepSetupError,
} from './context';
import { toolCallsOfError, usageOfError } from './errors';
import {
  type LeafDeps,
  type PreparedLeaf,
  prepareAgent,
  prepareApproval,
  prepareConsole,
  timeoutMessage,
} from './leaves';
import { copyData, MaskedStream, SecretMasker } from './mask';
import { EventQueue } from './queue';
import type { BlockResult, Flow } from './result';
import { AbortScope, onAbort, settle, sleep, stepTimeoutMs } from './timing';
import { addUsage, usageOfOutput } from './usage';
import type {
  LogStream,
  RunEvent,
  RunOptions,
  RunStatus,
  RunSummary,
  StepIO,
  StepOutput,
  Usage,
} from './types';

/** How long a cancelled or timed-out host call may take to wind down before the engine stops waiting for it. */
const ABORT_GRACE_MS = 1000;
const DEFAULT_MAX_ITERATIONS = 5;
const MAX_ITERATIONS_LIMIT = 100;
const MAX_RETRIES = 10;
/** Error text of cancelled blocks, in the step-end event and as `steps.<id>.error`. */
const CANCELLED = 'Cancelled';

interface Frame {
  /** Aborts on cancellation and on timeouts of enclosing blocks. */
  signal: AbortSignal;
  /** Innermost enclosing loop. */
  loop?: LoopVars;
}

interface PreparedBlock {
  detail?: string;
  run(scope: AbortScope): Promise<BlockResult>;
}

interface StepLogger {
  log(stream: LogStream, text: string): void;
  close(): void;
}

/** Schema validation guarantees 1–100; this keeps runs finite even for unvalidated input. */
function iterationLimit(value: number): number {
  if (!Number.isFinite(value) || value < 1) return DEFAULT_MAX_ITERATIONS;
  return Math.min(Math.floor(value), MAX_ITERATIONS_LIMIT);
}

/** Schema validation guarantees 1–10 retries and a delay ≥ 0; invalid values fall back to no retry / no delay. */
function retryPolicy(retry: Step['retry']): { max: number; delaySeconds: number } {
  const max = retry?.max;
  const delay = retry?.delay;
  return {
    max: max !== undefined && max >= 1 ? Math.min(Math.floor(max), MAX_RETRIES) : 0,
    delaySeconds: delay !== undefined && Number.isFinite(delay) && delay > 0 ? delay : 0,
  };
}

function failure(error: string, retryable = true, output: Record<string, unknown> = {}): BlockResult {
  return { status: 'failure', output, error, ...(retryable ? {} : { retryable: false }) };
}

/** Tokens and tool calls of a block's attempts so far. */
interface AttemptTotals {
  usage?: Usage;
  toolCalls: number;
}

const toolCallsOfOutput = (output: Record<string, unknown>) =>
  typeof output.toolCalls === 'number' && Number.isFinite(output.toolCalls) && output.toolCalls > 0
    ? output.toolCalls
    : 0;

/** Adds the earlier attempts to the result, so a retried block's numbers cover every attempt. */
function withEarlierAttempts(result: BlockResult, earlier: AttemptTotals): BlockResult {
  if (!earlier.usage && earlier.toolCalls === 0) return result;
  const output = { ...result.output };
  if (earlier.usage) {
    output.usage = addUsage(
      earlier.usage,
      usageOfOutput(result.output) ?? { inputTokens: 0, outputTokens: 0 },
    );
  }
  if (earlier.toolCalls > 0) output.toolCalls = earlier.toolCalls + toolCallsOfOutput(result.output);
  return { ...result, output };
}

function retryMessage(attempt: number, max: number, error: string | undefined, delaySeconds: number): string {
  const wait = delaySeconds > 0 ? `Retrying in ${delaySeconds}s` : 'Retrying';
  return `Attempt ${attempt} failed: ${error ?? 'unknown error'}. ${wait} (retry ${attempt} of ${max}).\n`;
}

class WorkflowRun {
  private readonly now: () => number;
  private readonly steps: Record<string, StepOutput> = {};
  private readonly sessions = new Map<string, ChatMessage[]>();
  private readonly usage: Usage = { inputTokens: 0, outputTokens: 0 };
  private readonly masker: SecretMasker;
  private scope!: RunScope;
  private workflowEnv: Record<string, string> = {};

  constructor(
    private readonly workflow: Workflow,
    private readonly options: RunOptions,
    private readonly signal: AbortSignal,
    private readonly send: (event: RunEvent) => void,
  ) {
    this.now = options.now ?? Date.now;
    this.masker = new SecretMasker(options.secrets);
  }

  /**
   * Emits a copy of the event with secrets masked, so listeners never see secret values and cannot change
   * what expressions read. Log text is masked by the step logger, which also catches secrets split over chunks.
   */
  private emit(event: RunEvent): void {
    const mask = this.masker;
    switch (event.type) {
      case 'run-start':
        return this.send({ ...event, inputs: copyData(event.inputs) });
      case 'step-start':
        return this.send(event.detail === undefined ? event : { ...event, detail: mask.text(event.detail) });
      case 'step-end':
        return this.send({
          ...event,
          output: mask.data(event.output),
          ...(event.error !== undefined && { error: mask.text(event.error) }),
        });
      case 'run-end':
        return this.send({
          ...event,
          usage: { ...event.usage },
          ...(event.error !== undefined && { error: mask.text(event.error) }),
        });
      default:
        return this.send(event);
    }
  }

  private get runId(): string {
    return this.options.runId;
  }

  async execute(): Promise<RunSummary> {
    const startedAt = this.now();
    let inputs = this.options.inputs ?? {};
    let flow: Flow | undefined;
    try {
      inputs = resolveInputs(this.workflow.inputs, inputs);
    } catch (error) {
      flow = { kind: 'fail', error: errorMessage(error) };
    }
    this.emit({ type: 'run-start', runId: this.runId, workflowName: this.workflow.name, startedAt, inputs });

    if (!flow) {
      try {
        this.initScope(inputs);
        flow = await this.executeList(this.workflow.steps ?? [], { signal: this.signal });
      } catch (error) {
        const message = errorMessage(error);
        flow = {
          kind: 'fail',
          error: error instanceof StepSetupError ? message : `Unexpected engine error: ${message}`,
        };
      }
    }

    const { status, error } = runOutcome(flow);
    const durationMs = this.now() - startedAt;
    this.emit({
      type: 'run-end',
      runId: this.runId,
      status,
      ...(error !== undefined && { error }),
      durationMs,
      usage: this.usage,
    });
    return {
      runId: this.runId,
      status,
      ...(error !== undefined && { error: this.masker.text(error) }),
      steps: this.masker.data(this.steps),
      usage: { ...this.usage },
      durationMs,
    };
  }

  private initScope(inputs: Record<string, unknown>): void {
    const base: RunScope = {
      inputs,
      env: { ...this.options.env },
      workflow: { name: this.workflow.name, file: this.options.workflowFile ?? '' },
      workspace: { root: this.options.workspaceRoot },
      run: { id: this.runId },
      secrets: { ...this.options.secrets },
    };
    this.scope = base;
    this.workflowEnv = renderEnv('env', this.workflow.env, this.context(undefined));
    this.scope = { ...base, env: { ...base.env, ...this.workflowEnv } };
  }

  private context(loop: LoopVars | undefined): ExpressionContext {
    return expressionContext(this.scope, this.steps, loop);
  }

  private async executeList(list: Step[], frame: Frame): Promise<Flow> {
    for (const step of list) {
      if (frame.signal.aborted) return { kind: 'abort' };
      const flow = await this.executeStep(step, frame);
      if (flow.kind !== 'next') return flow;
    }
    return { kind: 'next' };
  }

  private async executeStep(step: Step, frame: Frame): Promise<Flow> {
    const startedAt = this.now();
    const logger = this.createLogger(step.id);
    let prepared: PreparedBlock;
    try {
      prepared = this.prepare(step, frame, logger);
    } catch (error) {
      this.emitStart(step, frame, startedAt, undefined);
      return this.finishStep(step, startedAt, logger, failure(errorMessage(error), false));
    }
    this.emitStart(step, frame, startedAt, prepared.detail);
    const result = await this.runWithRetry(step, frame, logger, prepared);
    return this.finishStep(step, startedAt, logger, result);
  }

  private prepare(step: Step, frame: Frame, logger: StepLogger): PreparedBlock {
    switch (step.type) {
      case 'console':
        return this.hostBlock(step, logger, prepareConsole(step, this.leafDeps(frame)));
      case 'agent':
        return this.hostBlock(step, logger, prepareAgent(step, this.leafDeps(frame)));
      case 'approval':
        return this.hostBlock(step, logger, prepareApproval(step, this.leafDeps(frame)));
      case 'loop':
        return { run: (scope) => this.runLoop(step, scope) };
      case 'if':
        return { run: (scope) => this.runIf(step, frame, scope) };
      case 'break':
        return {
          run: async () =>
            frame.loop
              ? { status: 'success', output: {}, control: { kind: 'break' } }
              : failure(
                  `Break block '${step.id}' is not inside a loop. Move it into a loop or remove it.`,
                  false,
                ),
        };
      case 'stop': {
        const message =
          step.message === undefined ? '' : renderField('message', step.message, this.context(frame.loop));
        return {
          ...(step.message !== undefined && { detail: message }),
          run: async () => {
            if (step.outcome === 'success') {
              return { status: 'success', output: {}, control: { kind: 'stop', outcome: 'success' } };
            }
            const error = message || `Stopped by block '${step.id}'`;
            return {
              status: 'failure',
              output: {},
              error,
              control: { kind: 'stop', outcome: 'failure', error },
            };
          },
        };
      }
      default: {
        // Unreachable for schema-valid workflows; keeps hand-built or unvalidated ones from crashing the engine.
        const type = stringifyValue((step as { type?: unknown }).type);
        throw new StepSetupError(`Unknown block type '${type}'. Use one of: ${STEP_TYPES.join(', ')}.`);
      }
    }
  }

  private leafDeps(frame: Frame): LeafDeps {
    return {
      host: this.options.host,
      ctx: this.context(frame.loop),
      workflowEnv: this.workflowEnv,
      ...(this.options.defaultShell !== undefined && { defaultShell: this.options.defaultShell }),
      workspaceRoot: this.options.workspaceRoot,
      agents: this.options.agents ?? {},
      sessions: this.sessions,
    };
  }

  /** Runs a host call, honoring the attempt's abort signal without trusting the host to honor it too. */
  private hostBlock(step: Step, logger: StepLogger, leaf: PreparedLeaf): PreparedBlock {
    return {
      ...(leaf.detail !== undefined && { detail: leaf.detail }),
      run: async (scope) => {
        const io: StepIO = { runId: this.runId, stepId: step.id, signal: scope.signal, log: logger.log };
        const settled = await settle(leaf.invoke(io), scope.signal, ABORT_GRACE_MS);
        // A failed agent call still counts when the model used tokens before it failed.
        const errorUsage = settled.kind === 'error' ? usageOfError(settled.error) : undefined;
        const usage = settled.kind === 'value' ? settled.value.usage : errorUsage;
        if (usage) this.addUsage(usage);
        const errorToolCalls = settled.kind === 'error' ? toolCallsOfError(settled.error) : undefined;
        const failedOutput = {
          ...(errorUsage && { usage: errorUsage }),
          ...(errorToolCalls !== undefined && { toolCalls: errorToolCalls }),
        };
        if (scope.signal.aborted || settled.kind === 'abandoned') {
          const partial = settled.kind === 'value' ? settled.value.output : failedOutput;
          // The engine's timer usually fires before the host's own, so the host cannot be relied on to set timedOut.
          const timedOut = scope.timedOut && step.type === 'console';
          return this.interrupted(step, scope, timedOut ? { ...partial, timedOut: true } : partial);
        }
        if (settled.kind === 'error') return failure(errorMessage(settled.error), true, failedOutput);
        const { usage: _usage, commit, ...result } = settled.value;
        commit?.();
        return result;
      },
    };
  }

  private async runWithRetry(
    step: Step,
    frame: Frame,
    logger: StepLogger,
    prepared: PreparedBlock,
  ): Promise<BlockResult> {
    const { max: maxRetries, delaySeconds } = retryPolicy(step.retry);
    const timeoutMs = stepTimeoutMs(step.timeout);
    // Tokens and tool calls of earlier attempts, so the block's usage covers every attempt like the run total does.
    let earlier: AttemptTotals = { toolCalls: 0 };
    for (let attempt = 1; ; attempt++) {
      const scope = new AbortScope(frame.signal, timeoutMs);
      let result: BlockResult;
      try {
        result = await prepared.run(scope);
      } catch (error) {
        result = failure(errorMessage(error), !(error instanceof StepSetupError));
      } finally {
        scope.dispose();
      }
      result = withEarlierAttempts(result, earlier);
      earlier = { usage: usageOfOutput(result.output), toolCalls: toolCallsOfOutput(result.output) };
      if (
        result.status !== 'failure' ||
        result.control ||
        result.retryable === false ||
        attempt > maxRetries ||
        (step.type === 'agent' && this.budgetError() !== undefined)
      ) {
        return result;
      }
      logger.log('info', retryMessage(attempt, maxRetries, result.error, delaySeconds));
      if (!(await sleep(delaySeconds * 1000, frame.signal))) {
        return { status: 'cancelled', output: result.output, control: { kind: 'abort' } };
      }
    }
  }

  /** Result for a block whose signal aborted: its own timeout is a failure, anything else a cancellation. */
  private interrupted(step: Step, scope: AbortScope, output: Record<string, unknown>): BlockResult {
    if (scope.timedOut) return { status: 'failure', output, error: timeoutMessage(step.timeout) };
    return { status: 'cancelled', output, control: { kind: 'abort' } };
  }

  /** Maps how a container's children ended to the container's own result. */
  private fromChildren(
    step: Step,
    scope: AbortScope,
    flow: Flow,
    output: Record<string, unknown>,
  ): BlockResult {
    switch (flow.kind) {
      case 'next':
        return { status: 'success', output };
      case 'break':
        return { status: 'success', output, control: { kind: 'break' } };
      case 'fail':
        return { status: 'failure', output, error: flow.error, runError: flow.error };
      case 'stop':
        return {
          status: flow.outcome === 'success' ? 'success' : 'failure',
          output,
          ...(flow.error !== undefined && { error: flow.error }),
          control: flow,
        };
      case 'abort':
        return this.interrupted(step, scope, output);
    }
  }

  private async runLoop(step: LoopStep, scope: AbortScope): Promise<BlockResult> {
    const max = iterationLimit(step.maxIterations);
    const hasCondition = step.until !== undefined || step.while !== undefined;
    let iterations = 0;
    const exit = (exitReason: 'condition' | 'maxIterations' | 'break'): BlockResult => ({
      status: 'success',
      output: { iterations, exitReason },
    });

    for (;;) {
      if (scope.signal.aborted) return this.interrupted(step, scope, { iterations });
      const upcoming = { iteration: iterations + 1, index: iterations };
      if (step.while !== undefined && !checkCondition('while', step.while, this.context(upcoming))) {
        return exit('condition');
      }
      if (iterations >= max) {
        if (!hasCondition || step.onMaxIterations === 'continue') return exit('maxIterations');
        const error = `Loop '${step.id}' reached its limit of ${max} iterations without meeting its condition`;
        return {
          status: 'failure',
          output: { iterations, exitReason: 'maxIterations' },
          error,
          runError: error,
        };
      }

      iterations++;
      const loop = upcoming;
      this.emit({
        type: 'loop-iteration',
        runId: this.runId,
        stepId: step.id,
        iteration: iterations,
        maxIterations: max,
      });
      const flow = await this.executeList(step.steps ?? [], { signal: scope.signal, loop });
      if (flow.kind === 'break') return exit('break');
      if (flow.kind !== 'next') return this.fromChildren(step, scope, flow, { iterations });
      if (step.until !== undefined && checkCondition('until', step.until, this.context(loop))) {
        return exit('condition');
      }
    }
  }

  private async runIf(step: IfStep, frame: Frame, scope: AbortScope): Promise<BlockResult> {
    const result = checkCondition('condition', step.condition, this.context(frame.loop));
    const taken = (result ? step.then : step.else) ?? [];
    this.skip((result ? step.else : step.then) ?? []);
    const flow = await this.executeList(taken, {
      signal: scope.signal,
      ...(frame.loop && { loop: frame.loop }),
    });
    return this.fromChildren(step, scope, flow, { branch: result ? 'then' : 'else', result });
  }

  /** Reports every block of a branch that was not taken, recursively, as skipped. */
  private skip(list: Step[]): void {
    walkSteps(list, ({ step }) => {
      const output: StepOutput = { status: 'skipped', durationMs: 0 };
      this.steps[step.id] = output;
      this.emit({
        type: 'step-end',
        runId: this.runId,
        stepId: step.id,
        status: 'skipped',
        output,
        durationMs: 0,
        at: this.now(),
      });
    });
  }

  private emitStart(step: Step, frame: Frame, at: number, detail: string | undefined): void {
    this.emit({
      type: 'step-start',
      runId: this.runId,
      stepId: step.id,
      stepType: step.type,
      ...(frame.loop && { iteration: frame.loop.iteration }),
      ...(detail !== undefined && { detail }),
      at,
    });
  }

  private finishStep(step: Step, startedAt: number, logger: StepLogger, result: BlockResult): Flow {
    const at = this.now();
    const durationMs = at - startedAt;
    const error =
      result.status === 'success'
        ? undefined
        : (result.error ?? (result.status === 'cancelled' ? CANCELLED : 'Unknown error'));
    const output: StepOutput = {
      ...result.output,
      status: result.status,
      durationMs,
      ...(error !== undefined && { error }),
    };
    this.steps[step.id] = output;
    logger.close();
    this.emit({
      type: 'step-end',
      runId: this.runId,
      stepId: step.id,
      status: result.status,
      output,
      ...(error !== undefined && { error }),
      durationMs,
      at,
    });

    const control = result.control;
    if (control?.kind === 'abort') return { kind: 'abort' };
    if (control?.kind === 'break') return { kind: 'break' };
    if (control?.kind === 'stop') return control;
    const budgetError = step.type === 'agent' ? this.budgetError() : undefined;
    if (budgetError) return { kind: 'stop', outcome: 'failure', error: budgetError };
    if (result.status === 'cancelled') return { kind: 'abort' };
    if (result.status === 'failure' && !step.continueOnError) {
      return {
        kind: 'fail',
        error: result.runError ?? `Block '${step.id}' failed: ${result.error ?? 'unknown error'}`,
      };
    }
    return { kind: 'next' };
  }

  private addUsage(usage: Usage): void {
    this.usage.inputTokens += usage.inputTokens;
    this.usage.outputTokens += usage.outputTokens;
  }

  private budgetError(): string | undefined {
    const budget = this.options.tokenBudget ?? 0;
    const used = this.usage.inputTokens + this.usage.outputTokens;
    if (budget <= 0 || used <= budget) return undefined;
    const fix = 'Raise the token budget or set it to 0 for no limit.';
    return `Token budget exceeded: used ${used} of ${budget} tokens. ${fix}`;
  }

  private createLogger(stepId: string): StepLogger {
    let open = true;
    const streams = new Map<LogStream, MaskedStream>();
    const write = (stream: LogStream, text: string) => {
      if (text !== '') this.emit({ type: 'step-log', runId: this.runId, stepId, stream, text });
    };
    return {
      log: (stream, text) => {
        if (!open || typeof text !== 'string' || text === '') return;
        let masked = streams.get(stream);
        if (!masked) {
          masked = new MaskedStream(this.masker);
          streams.set(stream, masked);
        }
        write(stream, masked.push(text));
      },
      close: () => {
        if (!open) return;
        open = false;
        for (const [stream, masked] of streams) write(stream, masked.flush());
      },
    };
  }
}

function runOutcome(flow: Flow): { status: Exclude<RunStatus, 'running'>; error?: string } {
  switch (flow.kind) {
    case 'next':
    case 'break':
      return { status: 'success' };
    case 'fail':
      return { status: 'failure', error: flow.error };
    case 'stop':
      return flow.outcome === 'success' ? { status: 'success' } : { status: 'failure', error: flow.error };
    case 'abort':
      return { status: 'cancelled' };
  }
}

/**
 * Runs a workflow and yields its events in causal order; the generator's return value is the run summary.
 * Stopping iteration early cancels the run. Expects a schema-valid workflow; semantic problems that slip
 * through (e.g. `break` outside a loop) fail the affected block.
 */
export async function* runWorkflow(
  workflow: Workflow,
  options: RunOptions,
): AsyncGenerator<RunEvent, RunSummary> {
  const queue = new EventQueue<RunEvent>();
  const controller = new AbortController();
  const external = options.signal;
  const unlink = external ? onAbort(external, () => controller.abort(external.reason)) : () => undefined;
  const done = new WorkflowRun(workflow, options, controller.signal, (event) => queue.push(event))
    .execute()
    .finally(() => queue.close());
  // Observed later; this only keeps an early consumer exit from reporting an unhandled rejection.
  done.catch(() => undefined);

  let finished = false;
  try {
    for (;;) {
      const next = await queue.next();
      if (next.done) break;
      yield next.value;
    }
    finished = true;
    return await done;
  } finally {
    if (!finished) {
      controller.abort();
      await done.catch(() => undefined);
    }
    unlink();
  }
}
