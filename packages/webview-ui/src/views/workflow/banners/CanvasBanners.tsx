/** Messages pinned above the canvas: pending approvals, unreadable YAML, failed edits and restricted mode. */
import './banners.css';
import { useState } from 'react';
import type { ApprovalPrompt, Diagnostic } from '@isar-flow/core';
import { Banner, Button, TextInput } from '../../../components';
import { useEditor } from '../editorContext';
import { blockTitle } from '../canvas/model';
import { useWorkflowActions, useWorkflowState } from '../store';

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

function syntaxProblem(diagnostics: Diagnostic[]): Diagnostic | undefined {
  return (
    diagnostics.find((d) => d.severity === 'error' && d.code === 'yaml-syntax') ??
    diagnostics.find((d) => d.severity === 'error')
  );
}

export function CanvasBanners() {
  const { doc, approvals, opsError, trusted } = useWorkflowState();
  const { openYaml, dismissOpsError } = useWorkflowActions();
  const unreadable = doc !== null && doc.workflow === null ? syntaxProblem(doc.diagnostics) : undefined;
  const unreadableDoc = doc !== null && doc.workflow === null;

  if (!approvals.length && !unreadableDoc && !opsError && trusted) return null;
  const line = unreadable?.range ? ` (line ${unreadable.range.start.line + 1})` : '';

  return (
    <div className="wf-banners">
      {approvals.map((prompt) => (
        <ApprovalBanner key={prompt.requestId} prompt={prompt} />
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
      {!trusted ? <Banner tone="warning">Running is disabled until you trust this workspace.</Banner> : null}
    </div>
  );
}
