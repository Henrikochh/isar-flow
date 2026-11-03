import type { ModelPrice, ModelPrices, ReviewCounts, ReviewFile } from '../protocol';
import { runOriginText } from '../run';
import type { RunView, StepRunView } from '../run/types';
import { executed, type ReportBlock } from './blocks';
import { code, cutChars, escapeText, fence, formatCost, formatDuration, oneLine } from './format';
import type { RunReportInput } from './types';

export interface ReportContext {
  input: RunReportInput;
  run: RunView;
  /** Workflow name as plain text. */
  name: string;
  blocks: ReportBlock[];
  formatTime: (epochMs: number) => string;
}

/** How long sections may get; smaller limits when the report has to fit into maxChars. */
export interface Limits {
  answerChars: number;
  logLines: number;
  files: number;
}

export const SHORTENED = '(shortened)';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

export function workflowName(input: RunReportInput): string {
  const candidates = [input.run.workflowName, input.workflow?.name, input.record?.workflowName];
  return (
    candidates.find((name): name is string => typeof name === 'string' && name.trim() !== '')?.trim() ??
    'Workflow'
  );
}

export const RUN_STATUS_LABELS: Record<RunView['status'], string> = {
  running: 'Running',
  success: 'Succeeded',
  failure: 'Failed',
  cancelled: 'Cancelled',
};

export function originSentence(ctx: ReportContext): string | undefined {
  return runOriginText(ctx.run.origin ?? ctx.input.record?.origin)?.sentence;
}

/** Notes every variant shows: simulated, resumed, outputs cut by the history, still running. */
export function runNotes(ctx: ReportContext): string[] {
  const { run } = ctx;
  const notes: string[] = [];
  if (run.status === 'running')
    notes.push('The run is still running; this report shows what happened so far.');
  if (run.simulated)
    notes.push('Simulated run: nothing was executed; results came from the simulation file.');
  if (run.resumedFrom) {
    notes.push(
      `Resumed from block ${code(run.resumedFrom.stepId)} of run ${escapeText(run.resumedFrom.runId)}: blocks ` +
        "before it reused that run's results.",
    );
  }
  if (Object.values(run.steps).some((step) => step.outputTrimmed)) {
    notes.push('Some block outputs were shortened to fit the run history.');
  }
  return notes;
}

function priceOf(model: string, prices: ModelPrices | undefined): ModelPrice | undefined {
  if (!isRecord(prices) || !Object.hasOwn(prices, model)) return undefined;
  const price: unknown = prices[model];
  if (!isRecord(price)) return undefined;
  const input = count(price.input);
  const output = count(price.output);
  return input === undefined || output === undefined ? undefined : { input, output };
}

/** "0.42 (estimated)", with the models that have no price; undefined when no model of the run has one. */
export function costText(run: RunView, prices: ModelPrices | undefined): string | undefined {
  let cost: number | undefined;
  const unpriced = new Set<string>();
  for (const step of Object.values(run.steps)) {
    const model = step.metrics?.model;
    const usage = step.metrics?.usage;
    if (!model || !usage || usage.inputTokens + usage.outputTokens <= 0) continue;
    const price = priceOf(model, prices);
    if (!price) unpriced.add(model);
    else
      cost = (cost ?? 0) + (usage.inputTokens * price.input + usage.outputTokens * price.output) / 1_000_000;
  }
  if (cost === undefined) return undefined;
  const missing = [...unpriced].sort();
  const detail =
    missing.length > 0 ? `estimated; no price for ${missing.map(escapeText).join(', ')}` : 'estimated';
  return `${formatCost(cost)} (${detail})`;
}

export function durationText(view: StepRunView | undefined): string | undefined {
  const ms = view?.metrics?.durationMs ?? view?.durationMs;
  return ms === undefined || view?.reused ? undefined : formatDuration(ms);
}

/** The block where a failed or cancelled run stopped: the history's stoppedAt, else the last failed block. */
export function stoppedAt(ctx: ReportContext): ReportBlock | undefined {
  const { blocks, input } = ctx;
  const stopped = input.record?.stoppedAt;
  const recorded = stopped ? blocks.find((block) => block.id === stopped) : undefined;
  if (recorded) return recorded;
  const state = ctx.run.status === 'cancelled' ? 'cancelled' : 'failure';
  return latest(blocks.filter((block) => block.state === state && !hasFailedChild(block, blocks)));
}

/** A container fails when a block in it fails; the block itself is the more useful answer. */
function hasFailedChild(block: ReportBlock, blocks: ReportBlock[]): boolean {
  if (block.type !== 'loop' && block.type !== 'if') return false;
  const index = blocks.indexOf(block);
  for (let i = index + 1; i < blocks.length && blocks[i].depth > block.depth; i++) {
    if (blocks[i].state === block.state) return true;
  }
  return false;
}

/** The block that started last (ties: the later one in the list). */
export function latest(blocks: ReportBlock[]): ReportBlock | undefined {
  let found: ReportBlock | undefined;
  for (const block of blocks) {
    if (!found || (block.view?.startedAt ?? 0) >= (found.view?.startedAt ?? 0)) found = block;
  }
  return found;
}

export function errorOf(block: ReportBlock): string | undefined {
  const error = block.view?.error ?? block.view?.output?.error;
  return typeof error === 'string' && error.trim() !== '' ? error.trim() : undefined;
}

/** Agent blocks with an answer, in timeline order (reused ones included: the run used their answers). */
export function agentAnswers(blocks: ReportBlock[]): ReportBlock[] {
  return blocks.filter((block) => block.type === 'agent' && answerOf(block) !== undefined);
}

/** The text or JSON answer of an agent block. */
export function answerOf(block: ReportBlock): { text: string } | { json: unknown } | undefined {
  const output = block.view?.output;
  if (!output || block.state === 'not-run' || block.state === 'skipped') return undefined;
  if (output.json !== undefined) return { json: output.json };
  return typeof output.text === 'string' && output.text.trim() !== '' ? { text: output.text } : undefined;
}

/** The last agent block that ran in this run and answered. */
export function lastAnswer(blocks: ReportBlock[]): ReportBlock | undefined {
  return latest(agentAnswers(blocks).filter(executed));
}

/** An agent answer as Markdown, cut at `max` characters; a cut never leaves a code fence open. */
export function answerMarkdown(answer: { text: string } | { json: unknown }, max: number): string {
  if ('json' in answer) {
    const json = JSON.stringify(answer.json, null, 2) ?? String(answer.json);
    if (json.length <= max) return fence(json, 'json');
    return `${fence(cutChars(json, max), 'json')}\n\n${SHORTENED}`;
  }
  const text = answer.text.replace(/\r\n?/g, '\n').trim();
  if (text.length <= max) return text;
  return `${closeFences(cutChars(text, max))}\n\n${SHORTENED}`;
}

/** Closes a code fence that the text opens but does not close. */
function closeFences(text: string): string {
  let open: string | undefined;
  for (const line of text.split('\n')) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!match) continue;
    if (open === undefined) open = match[1];
    else if (match[1][0] === open[0] && match[1].length >= open.length && match[2].trim() === '')
      open = undefined;
  }
  return open === undefined ? text : `${text}\n${open}`;
}

/** Console output of a block: the `output` text, else stdout and stderr, else the logged lines. */
function consoleText(view: StepRunView | undefined): string {
  const output = view?.output;
  if (typeof output?.output === 'string') return output.output;
  const streams = [output?.stdout, output?.stderr].filter(
    (s): s is string => typeof s === 'string' && s !== '',
  );
  if (streams.length > 0) return streams.map((s) => (/\n$/.test(s) ? s : `${s}\n`)).join('');
  return (view?.logs ?? [])
    .filter((line) => line.stream === 'stdout' || line.stream === 'stderr')
    .map((line) => line.text)
    .join('');
}

/** The last lines of a console block's output, with a line that says whether lines were left out. */
export function outputTail(view: StepRunView | undefined, maxLines: number): string | undefined {
  const lines = consoleText(view).replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n');
  if (lines.length === 1 && lines[0].trim() === '') return undefined;
  if (maxLines <= 0) return `Output: ${lines.length === 1 ? '1 line' : `${lines.length} lines`} ${SHORTENED}`;
  if (lines.length <= maxLines) return `Output:\n\n${fence(lines.join('\n'))}`;
  const tail = lines.slice(-maxLines);
  return `Last ${tail.length} of ${lines.length} lines of the output ${SHORTENED}:\n\n${fence(tail.join('\n'))}`;
}

export function exitCodeOf(view: StepRunView | undefined): number | undefined {
  const exitCode = view?.output?.exitCode;
  return typeof exitCode === 'number' ? exitCode : undefined;
}

/** "3 kept, 1 reverted, 2 pending", from the history counts or the review. */
export function reviewSummary(ctx: ReportContext): string | undefined {
  const counts = reviewCounts(ctx);
  if (!counts) return undefined;
  const parts = [
    counts.kept > 0 && `${counts.kept} kept`,
    counts.reverted > 0 && `${counts.reverted} reverted`,
    counts.pending > 0 && `${counts.pending} pending`,
  ].filter((part): part is string => typeof part === 'string');
  return parts.length > 0 ? parts.join(', ') : undefined;
}

function reviewCounts(ctx: ReportContext): ReviewCounts | undefined {
  const { review, record } = ctx.input;
  if (record?.review) return record.review;
  if (!review) return undefined;
  const of = (decision: ReviewFile['decision']) => review.files.filter((f) => f.decision === decision).length;
  const pending = of('pending') + (review.omittedPending ?? 0);
  return {
    total: review.files.length + (review.omitted ?? 0),
    kept: of('kept'),
    reverted: of('reverted'),
    pending,
  };
}

/** "+12 −3", or "binary". */
export function changesText(file: ReviewFile): string {
  if (file.binary || file.additions === undefined || file.deletions === undefined) return 'binary';
  return `+${file.additions} −${file.deletions}`;
}

export const FILE_STATUS_LABELS: Record<ReviewFile['status'], string> = {
  added: 'Added',
  modified: 'Modified',
  deleted: 'Deleted',
};

export const DECISION_LABELS: Record<ReviewFile['decision'], string> = {
  pending: 'Pending',
  kept: 'Kept',
  reverted: 'Reverted',
};

/** A question or message (one line, at most 500 characters) as escaped Markdown. */
export function promptText(view: StepRunView | undefined): string | undefined {
  const detail = view?.detail;
  return typeof detail === 'string' && detail.trim() !== ''
    ? escapeText(cutChars(oneLine(detail), 500))
    : undefined;
}

/** "staging (default used)" for ask blocks; undefined without an answer. */
export function askAnswer(view: StepRunView | undefined): string | undefined {
  const answer = view?.output?.answer;
  if (typeof answer !== 'string') return undefined;
  const text = answer.trim() === '' ? '(empty)' : escapeText(cutChars(oneLine(answer), 500));
  return view?.output?.timedOut === true ? `${text} (default used)` : text;
}

/** "Approved" / "Rejected. Comment: …"; undefined without a decision. */
export function approvalDecision(view: StepRunView | undefined): string | undefined {
  const approved = view?.output?.approved;
  if (typeof approved !== 'boolean') return undefined;
  const decision = approved ? 'Approved' : 'Rejected';
  const comment = view?.output?.comment;
  return typeof comment === 'string' && comment.trim() !== ''
    ? `${decision}. Comment: ${escapeText(cutChars(oneLine(comment), 500))}`
    : decision;
}
