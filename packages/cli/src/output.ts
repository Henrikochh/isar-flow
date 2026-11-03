import {
  type LogStream,
  type RunEvent,
  STEP_TYPE_INFO,
  type StepOutput,
  type StepStatus,
} from '@isar-flow/core';
import { formatDuration } from '@isar-flow/core/node';
import { formatCount, plural, type Style } from './format';
import type { CliOutput } from './io';

/** Colors only for a terminal, and never when NO_COLOR is set (https://no-color.org). */
export function useColor(stream: Pick<CliOutput, 'isTTY'>, env: Record<string, string | undefined>): boolean {
  return stream.isTTY === true && !env.NO_COLOR;
}

const LOG_INDENT = '    ';
const DIM_STREAMS: ReadonlySet<LogStream> = new Set(['info', 'tool']);

type Summary = Extract<RunEvent, { type: 'run-end' }>;

/**
 * Prints run events for people: a start line per block, its output indented below it, an end line with status,
 * duration, tokens and model, and a summary of the run. Blocks run one after another, so output streams as it
 * arrives. Event texts are already masked by the engine.
 */
export function createHumanReporter(write: (text: string) => void, style: Style): (event: RunEvent) => void {
  const containers: string[] = [];
  const finalStatus = new Map<string, StepStatus>();
  let line: { stepId: string; stream: LogStream } | undefined;

  const depth = () => '  '.repeat(containers.length);
  const endLine = () => {
    if (line) write('\n');
    line = undefined;
  };
  const say = (text: string) => {
    endLine();
    write(`${text}\n`);
  };

  const logText = (stepId: string, stream: LogStream, text: string) => {
    if (line && (line.stepId !== stepId || line.stream !== stream)) endLine();
    const indent = `${depth()}${LOG_INDENT}`;
    const paint = DIM_STREAMS.has(stream) ? style.dim : (part: string) => part;
    for (const [i, part] of text.split('\n').entries()) {
      if (i > 0) {
        write('\n');
        line = undefined;
      }
      if (part === '') continue;
      const start = line ? '' : indent;
      write(start + paint(part.replace(/\r(?!$)/g, `\r${indent}`)));
      line = { stepId, stream };
    }
  };

  return (event) => {
    switch (event.type) {
      case 'step-start': {
        const info = STEP_TYPE_INFO[event.stepType];
        const iteration = event.iteration === undefined ? '' : `, iteration ${event.iteration}`;
        say(`${depth()}${style.dim('▶')} ${event.stepId} (${info?.label ?? event.stepType}${iteration})`);
        if (event.stepType === 'console' && event.detail) {
          const command = event.detail.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
          const lines = command.split('\n').map((part, i) => (i === 0 ? `$ ${part}` : `  ${part}`));
          for (const part of lines) say(`${depth()}${LOG_INDENT}${style.dim(part)}`);
        }
        if (info?.container) containers.push(event.stepId);
        return;
      }
      case 'step-log':
        return logText(event.stepId, event.stream, event.text);
      case 'loop-iteration':
        return say(`${depth()}${style.dim('↻')} Iteration ${event.iteration} of ${event.maxIterations}`);
      case 'step-end': {
        if (containers[containers.length - 1] === event.stepId) containers.pop();
        finalStatus.set(event.stepId, event.status);
        return say(
          `${depth()}${endText(event.stepId, event.status, event.durationMs, event.output, event.error, style)}`,
        );
      }
      case 'run-end':
        endLine();
        return write(`\n${summaryText(event, finalStatus)}\n`);
      default:
        return;
    }
  };
}

function endText(
  stepId: string,
  status: StepStatus,
  durationMs: number,
  output: StepOutput,
  error: string | undefined,
  style: Style,
): string {
  const duration = formatDuration(durationMs);
  switch (status) {
    case 'success':
      return `${style.green('✓')} ${stepId} succeeded in ${duration}${details(output)}`;
    case 'failure':
      return `${style.red('✗')} ${stepId} failed in ${duration}${error ? `: ${error}` : ''}`;
    case 'cancelled':
      return `${style.yellow('■')} ${stepId} cancelled after ${duration}`;
    default:
      return `${style.dim('-')} ${stepId} ${status}`;
  }
}

/** Tokens and model of agents, the answer of ask blocks, the decision of approvals. */
function details(output: StepOutput): string {
  const parts: string[] = [];
  const usage = output.usage as { inputTokens?: unknown; outputTokens?: unknown } | undefined;
  if (typeof usage?.inputTokens === 'number' && typeof usage.outputTokens === 'number') {
    parts.push(`${formatCount(usage.inputTokens)} in and ${formatCount(usage.outputTokens)} out tokens`);
  }
  if (typeof output.model === 'string') parts.push(`model ${output.model}`);
  if (typeof output.answer === 'string') {
    parts.push(
      `answer: ${output.answer}${output.timedOut === true ? ', the default after the timeout' : ''}`,
    );
  }
  if (typeof output.approved === 'boolean') {
    const comment = typeof output.comment === 'string' && output.comment !== '' ? `: ${output.comment}` : '';
    parts.push(`${output.approved ? 'approved' : 'rejected'}${comment}`);
  }
  return parts.length === 0 ? '' : ` (${parts.join(', ')})`;
}

const COUNT_WORDS: [StepStatus, string][] = [
  ['success', 'succeeded'],
  ['failure', 'failed'],
  ['cancelled', 'cancelled'],
  ['skipped', 'skipped'],
];

/** "2 blocks succeeded, 1 skipped" from the last status of each block. */
function countsText(finalStatus: Map<string, StepStatus>): string {
  const values = [...finalStatus.values()];
  const counts = COUNT_WORDS.flatMap(([status, word]) => {
    const count = values.filter((value) => value === status).length;
    return count === 0 ? [] : [{ count, word }];
  });
  return counts
    .map(({ count, word }, i) =>
      i === 0 ? `${plural(count, 'block')} ${word}` : `${formatCount(count)} ${word}`,
    )
    .join(', ');
}

function summaryText(event: Summary, finalStatus: Map<string, StepStatus>): string {
  const counts = countsText(finalStatus);
  const blocks = counts === '' ? '' : ` ${counts}.`;
  const { inputTokens, outputTokens } = event.usage;
  const tokens =
    inputTokens + outputTokens > 0
      ? ` Tokens: ${formatCount(inputTokens)} in, ${formatCount(outputTokens)} out.`
      : '';
  const duration = formatDuration(event.durationMs);
  switch (event.status) {
    case 'success':
      return counts === ''
        ? `Succeeded in ${duration}.${tokens}`
        : `Succeeded in ${duration}:${blocks}${tokens}`;
    case 'failure':
      return `Failed in ${duration}: ${sentence(event.error ?? 'The run failed.')}${blocks}${tokens}`;
    case 'cancelled':
      return `Cancelled after ${duration}.${blocks}${tokens}`;
  }
}

function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}
