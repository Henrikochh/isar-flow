import { useId, useState } from 'react';
import type { BlockNode, RunView, StepRunView, StepStatus } from '@isar-flow/core';
import {
  Banner,
  Button,
  Chip,
  IconButton,
  StatusGlyph,
  statusLabel,
  TextInput,
} from '../../../../components';
import { formatDuration } from '../../../../hooks';
import { sourceRunLabel } from '../../runFromHere/model';
import { useWorkflowActions, useWorkflowState } from '../../store';
import { asNumber, asString, isRecord } from '../model';
import { useNow } from '../useNow';
import { AskForm } from '../../ask/AskForm';
import { BlockMetrics } from './BlockMetrics';
import { DetailBlock } from './DetailBlock';
import { LogViewer } from './LogViewer';
import { RunFromHereButton } from './RunFromHereButton';

const DETAIL_LABELS: Record<string, string> = {
  agent: 'Sent to the agent',
  console: 'Command',
  approval: 'Message',
  stop: 'Message',
  ask: 'Question',
};

/** Blocks that wait for the user while they run; their form replaces the detail meanwhile. */
const WAITS = new Set(['approval', 'ask']);

/** "Run output" tab of a selected block. */
export function RunOutput({ block, stepId, run }: { block: BlockNode; stepId: string; run: RunView }) {
  const { approvals, asks, history } = useWorkflowState();
  const stepRun = run.steps[stepId];
  const type = asString((block.step as unknown as Record<string, unknown>).type);
  if (!stepRun) {
    return (
      <div className="wf-insp-form">
        <StatusLine status="pending" stepRun={undefined} />
        <RunFromHereButton run={run} stepId={stepId} />
        <p className="wf-insp-note">
          {run.status === 'running'
            ? 'This block has not started yet.'
            : 'This block did not run in this run.'}
        </p>
      </div>
    );
  }
  const output = isRecord(stepRun.output) ? stepRun.output : undefined;
  return (
    <div className="wf-insp-form">
      <StatusLine
        status={stepRun.status}
        stepRun={stepRun}
        label={
          stepRun.status !== 'running'
            ? undefined
            : approvals.some((a) => a.stepId === stepId)
              ? 'Waiting for your decision'
              : asks.some((a) => a.stepId === stepId)
                ? 'Waiting for your answer'
                : undefined
        }
      />
      <RunFromHereButton run={run} stepId={stepId} />
      {stepRun.reused ? (
        <p className="wf-insp-note">
          {`This block didn't run: its result comes from ${sourceRunLabel(run, history) ?? 'the run this one continues'}.`}
        </p>
      ) : null}
      {stepRun.error ? (
        <Banner tone="error" title={stepRun.status === 'cancelled' ? 'Cancelled' : 'This block failed'}>
          <span className="wf-insp-pre">{stepRun.error}</span>
        </Banner>
      ) : null}
      {type === 'approval' ? <PendingApproval stepId={stepId} /> : null}
      {type === 'ask' ? <PendingAsk stepId={stepId} /> : null}
      {stepRun.detail && DETAIL_LABELS[type] && !(WAITS.has(type) && stepRun.status === 'running') ? (
        <DetailBlock
          key={`${stepId}:${type}`}
          label={DETAIL_LABELS[type]}
          text={stepRun.detail}
          defaultOpen={type !== 'agent'}
        />
      ) : null}
      {type === 'console' ? <ConsoleOutput stepRun={stepRun} output={output} /> : null}
      {type === 'agent' ? <AgentOutput stepRun={stepRun} output={output} /> : null}
      {type === 'loop' ? <LoopOutput stepRun={stepRun} output={output} /> : null}
      {type === 'if' ? <IfOutput output={output} /> : null}
      {type === 'approval' ? <ApprovalOutput output={output} /> : null}
      {type === 'ask' ? <AskOutput output={output} /> : null}
      <BlockMetrics stepId={stepId} stepRun={stepRun} />
    </div>
  );
}

function StatusLine({
  status,
  stepRun,
  label,
}: {
  status: StepStatus;
  stepRun: StepRunView | undefined;
  label?: string;
}) {
  const running = status === 'running';
  const now = useNow(running);
  // A host clock ahead of ours would show a negative time; leave it out instead. A reused block took no time.
  const duration = running
    ? stepRun?.startedAt && now >= stepRun.startedAt
      ? now - stepRun.startedAt
      : undefined
    : stepRun?.reused
      ? undefined
      : stepRun?.durationMs;
  return (
    <div className="wf-run-status" data-status={status}>
      <StatusGlyph status={status} />
      <span className="wf-run-status-label">{label ?? statusLabel(status)}</span>
      {duration !== undefined ? <span className="wf-run-status-time">{formatDuration(duration)}</span> : null}
      <span className="wf-run-status-chips">
        {stepRun?.reused ? (
          <Chip
            tone="outline"
            icon="history"
            title="Not run: the result comes from the run this one continues."
          >
            Reused
          </Chip>
        ) : null}
        {stepRun?.iteration !== undefined ? (
          <Chip tone="outline">{`Iteration ${stepRun.iteration}`}</Chip>
        ) : null}
        {stepRun && stepRun.executions > 1 ? (
          <Chip tone="outline">{`Ran ${stepRun.executions} times`}</Chip>
        ) : null}
      </span>
    </div>
  );
}

function ConsoleOutput({
  stepRun,
  output,
}: {
  stepRun: StepRunView;
  output: Record<string, unknown> | undefined;
}) {
  const exitCode = asNumber(output?.exitCode);
  const fallback = asString(output?.output);
  const lines =
    stepRun.logs.length > 0 || fallback === ''
      ? stepRun.logs
      : fallback.split(/(?<=\n)/).map((text) => ({ stream: 'stdout' as const, text }));
  return (
    <div className="wf-insp-stack">
      {exitCode !== undefined || output?.timedOut === true ? (
        <div className="wf-insp-chips">
          {exitCode !== undefined ? (
            <Chip
              tone={exitCode === 0 ? 'success' : 'error'}
              icon={exitCode === 0 ? 'pass' : 'error'}
            >{`Exit code ${exitCode}`}</Chip>
          ) : null}
          {output?.timedOut === true ? (
            <Chip tone="warning" icon="clock">
              Timed out
            </Chip>
          ) : null}
        </div>
      ) : null}
      <LogViewer lines={lines} running={stepRun.status === 'running'} truncated={stepRun.logsTruncated} />
    </div>
  );
}

function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function AgentOutput({
  stepRun,
  output,
}: {
  stepRun: StepRunView;
  output: Record<string, unknown> | undefined;
}) {
  const actions = useWorkflowActions();
  const running = stepRun.status === 'running';
  const tools = stepRun.logs.filter((line) => line.stream === 'tool');
  const streamed = stepRun.logs
    .filter((line) => line.stream === 'agent')
    .map((line) => line.text)
    .join('');
  const hasJson = output !== undefined && output.json !== undefined;
  const answer = hasJson ? prettyJson(output.json) : asString(output?.text) || (running ? streamed : '');

  return (
    <div className="wf-insp-stack">
      {tools.length ? (
        <div className="wf-insp-subsection">
          <div className="wf-insp-subtitle">Tools used</div>
          <ul className="wf-tools">
            {tools.map((line, index) => (
              <li key={index} className="wf-tool">
                <i className="codicon codicon-tools" aria-hidden="true" />
                <span className="wf-tool-text">{line.text.trim()}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="wf-insp-subsection">
        <div className="wf-insp-subtitle">
          <span>{hasJson ? 'Answer (JSON)' : 'Answer'}</span>
          {answer ? (
            <IconButton icon="copy" label="Copy answer" onClick={() => actions.copy(answer)} />
          ) : null}
        </div>
        {answer ? (
          hasJson ? (
            <pre className="wf-insp-code wf-answer-json">{answer}</pre>
          ) : (
            <div className={running ? 'wf-answer wf-answer--streaming' : 'wf-answer'}>{answer}</div>
          )
        ) : (
          <p className="wf-insp-note">{running ? 'Waiting for the agent…' : 'No answer.'}</p>
        )}
      </div>
    </div>
  );
}

const EXIT_REASONS: Record<string, string> = {
  condition: 'Ended because its condition was met',
  maxIterations: 'Ended at its iteration limit',
  break: 'Left by a Break block',
};

function LoopOutput({
  stepRun,
  output,
}: {
  stepRun: StepRunView;
  output: Record<string, unknown> | undefined;
}) {
  const iterations = asNumber(output?.iterations);
  const reason = EXIT_REASONS[asString(output?.exitReason)];
  return (
    <div className="wf-insp-chips">
      {stepRun.loop ? (
        <Chip
          tone="outline"
          icon="sync"
        >{`Iteration ${stepRun.loop.iteration} of ${stepRun.loop.maxIterations}`}</Chip>
      ) : iterations !== undefined ? (
        <Chip tone="outline" icon="sync">
          {iterations === 1 ? '1 iteration' : `${iterations} iterations`}
        </Chip>
      ) : null}
      {reason ? <Chip tone="outline">{reason}</Chip> : null}
    </div>
  );
}

function IfOutput({ output }: { output: Record<string, unknown> | undefined }) {
  const branch = asString(output?.branch);
  if (!branch) return null;
  return (
    <div className="wf-insp-chips">
      <Chip tone="outline" icon="repo-forked">
        {branch === 'then' ? 'Took the Then branch' : 'Took the Else branch'}
      </Chip>
      {typeof output?.result === 'boolean' ? (
        <Chip tone="outline">{`Condition was ${output.result}`}</Chip>
      ) : null}
    </div>
  );
}

function ApprovalOutput({ output }: { output: Record<string, unknown> | undefined }) {
  if (typeof output?.approved !== 'boolean') return null;
  const comment = asString(output.comment);
  return (
    <div className="wf-insp-stack">
      <div className="wf-insp-chips">
        <Chip tone={output.approved ? 'success' : 'error'} icon={output.approved ? 'pass' : 'error'}>
          {output.approved ? 'Approved' : 'Rejected'}
        </Chip>
      </div>
      {comment ? <div className="wf-answer">{comment}</div> : null}
    </div>
  );
}

function PendingApproval({ stepId }: { stepId: string }) {
  const { approvals } = useWorkflowState();
  const actions = useWorkflowActions();
  const [comment, setComment] = useState('');
  const prompt = approvals.find((a) => a.stepId === stepId);
  if (!prompt) return null;
  return (
    <Banner
      tone="success"
      title="Approval needed"
      actions={
        <>
          <Button
            size="s"
            variant="run"
            icon="check"
            onClick={() => actions.answerApproval(prompt.requestId, true, comment || undefined)}
          >
            Approve
          </Button>
          <Button
            size="s"
            variant="danger"
            icon="close"
            onClick={() => actions.answerApproval(prompt.requestId, false, comment || undefined)}
          >
            Reject
          </Button>
        </>
      }
    >
      <div className="wf-insp-stack">
        <span className="wf-insp-pre">{prompt.message}</span>
        <TextInput
          aria-label="Comment"
          placeholder="Comment (optional)"
          value={comment}
          onChange={(event) => setComment(event.target.value)}
        />
      </div>
    </Banner>
  );
}

function AskOutput({ output }: { output: Record<string, unknown> | undefined }) {
  if (typeof output?.answer !== 'string') return null;
  return (
    <div className="wf-insp-subsection">
      <div className="wf-insp-subtitle">
        <span>Answer</span>
        {output.timedOut === true ? (
          <Chip tone="outline" icon="clock" title="Nobody answered in time, so the default was used.">
            Default used
          </Chip>
        ) : null}
      </div>
      <div className="wf-answer">{output.answer}</div>
    </div>
  );
}

/** The question of a running ask block with the same answer controls as the card above the canvas. */
function PendingAsk({ stepId }: { stepId: string }) {
  const { asks } = useWorkflowState();
  const actions = useWorkflowActions();
  const questionId = useId();
  const prompt = asks.find((a) => a.stepId === stepId);
  if (!prompt) return null;
  return (
    <Banner
      tone="success"
      icon="comment-discussion"
      title="Question"
      actions={
        <AskForm
          key={prompt.requestId}
          prompt={prompt}
          questionId={questionId}
          onAnswer={(answer) => actions.answerAsk(prompt.requestId, answer)}
        />
      }
    >
      <span id={questionId} className="wf-insp-pre wf-ask-question">
        {prompt.question}
      </span>
    </Banner>
  );
}
