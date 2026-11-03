/**
 * Messages pinned above the canvas: pending approvals and questions, unreadable YAML, failed edits, blocks without
 * ids, restricted mode and a simulated run.
 */
import './banners.css';
import { useRef, useState } from 'react';
import type { ApprovalPrompt, Diagnostic } from '@isar-flow/core';
import { Banner, Button, TextInput } from '../../../components';
import { useEditor } from '../editorContext';
import { blocksNeedingIds, blockTitle } from '../canvas/model';
import { simulatedNote } from '../simulation/copy';
import { useStartBlockers } from '../topbar/useStartBlockers';
import { useWorkflowActions, useWorkflowState } from '../store';
import { AskBanner } from './AskBanner';
import { useAskFocus } from './useAskFocus';

function ApprovalBanner({ prompt }: { prompt: ApprovalPrompt }) {
  const [comment, setComment] = useState('');
  const { answerApproval, select } = useWorkflowActions();
  const { model } = useEditor();
  const entry = model.byId.get(prompt.stepId);
  const answer = (approved: boolean) =>
    answerApproval(prompt.requestId, approved, comment.trim() || undefined);
  return (
    <Banner
      tone="success"
      title={
        <span className="wf-banner-title">
          <span>Approval needed</span>
          {entry ? (
            <button type="button" className="wf-banner-link" onClick={() => select(prompt.stepId)}>
              {blockTitle(entry)}
            </button>
          ) : null}
        </span>
      }
      actions={
        <div className="wf-approval">
          <TextInput
            className="wf-approval__comment"
            placeholder="Comment (optional)"
            aria-label="Comment"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
          />
          <Button variant="run" icon="check" onClick={() => answer(true)}>
            Approve
          </Button>
          <Button variant="danger" icon="close" onClick={() => answer(false)}>
            Reject
          </Button>
        </div>
      }
    >
      <span className="wf-banner-message">{prompt.message}</span>
    </Banner>
  );
}

/** Blocks without a usable id cannot be selected, edited or referenced; one click gives them ids. */
function MissingIdsBanner({ missing, invalid }: { missing: number; invalid: number }) {
  const { applyOps } = useWorkflowActions();
  const count = missing + invalid;
  const what = invalid > 0 ? 'no valid id' : 'no id';
  return (
    <Banner
      tone="warning"
      actions={
        <Button
          size="s"
          variant="secondary"
          icon="wand"
          onClick={() => applyOps([{ op: 'assignMissingIds' }])}
        >
          Add ids
        </Button>
      }
    >
      <span className="wf-banner-message">
        {count === 1 ? `1 block has ${what}.` : `${count} blocks have ${what}.`} Blocks need ids before they
        can be edited or referenced.
      </span>
    </Banner>
  );
}

/** A simulated run on the canvas looks finished like a real one; this says, in its own tone, that nothing ran. */
function SimulatedRunBanner({ running }: { running: boolean }) {
  const { openSimulationFile } = useWorkflowActions();
  return (
    <Banner tone="simulated" title={running ? 'Simulating' : 'Simulated run'}>
      <span className="wf-banner-message">
        {`${simulatedNote(running)} `}
        <Button variant="link" onClick={openSimulationFile}>
          Edit mocks
        </Button>
      </span>
    </Banner>
  );
}

/** Restricted Mode turns Run off; Simulate runs nothing, so the banner offers it right there. */
function RestrictedBanner() {
  const { run, runLive } = useWorkflowState();
  const { requestStart } = useWorkflowActions();
  const { simulate: blocker } = useStartBlockers();
  const canSimulate = blocker === null && !(runLive && run?.status === 'running');
  return (
    <Banner
      tone="warning"
      actions={
        canSimulate ? (
          <Button size="s" variant="secondary" icon="beaker" onClick={() => requestStart('simulate')}>
            Simulate
          </Button>
        ) : undefined
      }
    >
      Running is disabled until you trust this workspace. You can still simulate the workflow.
    </Banner>
  );
}

function syntaxProblem(diagnostics: Diagnostic[]): Diagnostic | undefined {
  return (
    diagnostics.find((d) => d.severity === 'error' && d.code === 'yaml-syntax') ??
    diagnostics.find((d) => d.severity === 'error')
  );
}

export function CanvasBanners() {
  const { doc, approvals, asks, opsError, trusted, run } = useWorkflowState();
  const { openYaml, dismissOpsError } = useWorkflowActions();
  const { model, editable } = useEditor();
  const ref = useRef<HTMLDivElement>(null);
  useAskFocus(ref, asks[0]?.requestId);
  const ids = editable ? blocksNeedingIds(model) : { missing: 0, invalid: 0 };
  const needIds = ids.missing + ids.invalid > 0;
  const unreadable = doc !== null && doc.workflow === null ? syntaxProblem(doc.diagnostics) : undefined;
  const unreadableDoc = doc !== null && doc.workflow === null;
  const simulated = run?.simulated === true;

  const waiting = approvals.length + asks.length > 0;
  if (!waiting && !unreadableDoc && !opsError && !needIds && trusted && !simulated) return null;
  const line = unreadable?.range ? ` (line ${unreadable.range.start.line + 1})` : '';

  return (
    <div className="wf-banners" ref={ref}>
      {approvals.map((prompt) => (
        <ApprovalBanner key={prompt.requestId} prompt={prompt} />
      ))}
      {asks.map((prompt) => (
        <AskBanner key={prompt.requestId} prompt={prompt} />
      ))}
      {unreadableDoc ? (
        <Banner
          tone="error"
          actions={
            <Button size="s" variant="secondary" icon="go-to-file" onClick={() => openYaml()}>
              Show in YAML
            </Button>
          }
        >
          <span className="wf-banner-message">
            <strong>The YAML can&apos;t be read:</strong>{' '}
            {unreadable
              ? unreadable.message.replace(/^YAML syntax error:\s*/i, '')
              : 'Fix the file to see the workflow again.'}
            {line}
          </span>
        </Banner>
      ) : null}
      {opsError ? (
        <Banner
          tone="error"
          title="The change could not be applied"
          actions={
            <Button size="s" variant="ghost" onClick={dismissOpsError}>
              Dismiss
            </Button>
          }
        >
          <span className="wf-banner-message">{opsError}</span>
        </Banner>
      ) : null}
      {needIds ? <MissingIdsBanner missing={ids.missing} invalid={ids.invalid} /> : null}
      {!trusted ? <RestrictedBanner /> : null}
      {simulated ? <SimulatedRunBanner running={run.status === 'running'} /> : null}
    </div>
  );
}
