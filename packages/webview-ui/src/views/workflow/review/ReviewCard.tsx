/**
 * Review card: the files the shown run changed, pinned above the canvas. Each file can be kept or reverted
 * (worktree runs: copied into the workspace or dropped); the host applies decisions and sends the new review.
 */
import './review.css';
import { useEffect, useId, useRef, useState } from 'react';
import type { RunReview } from '@isar-flow/core';
import { Button, Chip, IconButton, Spinner } from '../../../components';
import { useWorkflowActions, useWorkflowState } from '../store';
import {
  decidedSummary,
  filesChangedTitle,
  keepBlocker,
  pendingLabel,
  revertAllBlocker,
  revertAllQuestion,
  reviewCounts,
  reviewNotes,
} from './model';
import { Reason } from './Reason';
import { ReviewRow, type Decide } from './ReviewRow';
import { useDecisionFocus } from './useDecisionFocus';

/** Asks before Revert all; Cancel, the safe answer, has the focus. Escape cancels. */
function RevertAllQuestion({
  review,
  onConfirm,
  onCancel,
}: {
  review: RunReview;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const detailId = useId();
  const cancel = useRef<HTMLButtonElement>(null);
  const question = revertAllQuestion(review);
  useEffect(() => {
    cancel.current?.focus();
  }, []);
  return (
    <div
      role="group"
      aria-labelledby={titleId}
      aria-describedby={detailId}
      className="wf-review-confirm"
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        onCancel();
      }}
    >
      <i className="codicon codicon-warning wf-review-confirm-icon" aria-hidden="true" />
      <div className="wf-review-confirm-text">
        <p id={titleId} className="wf-review-confirm-title">
          {question.title}
        </p>
        <p id={detailId} className="wf-review-confirm-detail">
          {question.detail}
        </p>
      </div>
      <div className="wf-review-confirm-actions">
        <Button variant="danger" icon="discard" disabled={review.busy === true} onClick={onConfirm}>
          {question.confirm}
        </Button>
        <Button ref={cancel} variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** Revert all (asks first) on the left, away from Keep all, the safe choice. */
function ReviewFooter({ review, onDecide }: { review: RunReview; onDecide: Decide }) {
  const busy = review.busy === true;
  const blocker = revertAllBlocker(review);
  const [question, setAsking] = useState(false);
  // The question closes by itself once nothing is left to revert (files decided one by one meanwhile).
  const asking = question && !blocker;
  const revertAll = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  // A cancelled question gives the focus back to Revert all.
  useEffect(() => {
    if (asking || !refocus.current) return;
    refocus.current = false;
    revertAll.current?.focus();
  }, [asking]);
  if (asking) {
    return (
      <footer className="wf-review-foot wf-review-foot--asking">
        <RevertAllQuestion
          review={review}
          onConfirm={() => {
            setAsking(false);
            onDecide('reverted');
          }}
          onCancel={() => {
            refocus.current = true;
            setAsking(false);
          }}
        />
      </footer>
    );
  }
  return (
    <footer className="wf-review-foot">
      <span className="wf-review-foot-start">
        <Reason reason={blocker}>
          {(blocked) => (
            <Button
              ref={revertAll}
              variant="danger"
              icon="discard"
              disabled={busy}
              {...blocked}
              onClick={() => setAsking(true)}
            >
              Revert all
            </Button>
          )}
        </Reason>
      </span>
      {busy ? (
        <span className="wf-review-busy">
          <Spinner />
          <span>Applying changes…</span>
        </span>
      ) : null}
      <Reason reason={keepBlocker(review)}>
        {(blocked) => (
          <Button
            variant="primary"
            icon="check"
            disabled={busy}
            {...blocked}
            onClick={() => onDecide('kept')}
          >
            Keep all
          </Button>
        )}
      </Reason>
    </footer>
  );
}

function ReviewCardBody({ review }: { review: RunReview }) {
  const bodyId = useId();
  const counts = reviewCounts(review);
  const done = counts.pending === 0;
  // A user's choice holds until every file is decided; then the card folds to its summary.
  const [choice, setChoice] = useState<{ done: boolean; collapsed: boolean } | null>(null);
  const collapsed = choice && choice.done === done ? choice.collapsed : done;
  const summary = decidedSummary(counts);
  const notes = reviewNotes(review);
  const actions = useWorkflowActions();
  const focus = useDecisionFocus(review);
  const decide: Decide = (decision, path) => {
    focus.expect(path ?? null);
    actions.reviewFiles(review.runId, decision, path === undefined ? undefined : [path]);
  };

  return (
    <section ref={focus.container} className="wf-review" aria-label="Review changes">
      <div className="wf-review-head">
        <i className="codicon codicon-diff wf-review-icon" aria-hidden="true" />
        <h2 className="wf-review-title if-display">{filesChangedTitle(counts.total)}</h2>
        <span className="wf-review-tags">
          {review.isolation === 'worktree' ? (
            <Chip tone="outline" icon="git-branch" title="The run worked in a separate git worktree">
              Worktree
            </Chip>
          ) : null}
          {counts.pending > 0 ? (
            <Chip tone="warning">{pendingLabel(counts.pending)}</Chip>
          ) : summary ? (
            <span className="wf-review-summary">{summary}</span>
          ) : null}
        </span>
        <IconButton
          ref={focus.toggle}
          icon={collapsed ? 'chevron-down' : 'chevron-up'}
          label={collapsed ? 'Show review' : 'Hide review'}
          aria-expanded={!collapsed}
          aria-controls={collapsed ? undefined : bodyId}
          onClick={() => setChoice({ done, collapsed: !collapsed })}
        />
      </div>
      {collapsed ? null : (
        <div id={bodyId} className="wf-review-body">
          {notes.length ? (
            <ul className="wf-review-notes">
              {notes.map((note) => (
                <li key={note.key} className="wf-review-note">
                  <i className={`codicon codicon-${note.icon} wf-review-note-icon`} aria-hidden="true" />
                  <span>{note.text}</span>
                </li>
              ))}
            </ul>
          ) : null}
          <ul className="wf-review-list" aria-label="Changed files">
            {review.files.map((file) => (
              <ReviewRow key={file.path} review={review} file={file} onDecide={decide} />
            ))}
          </ul>
          {done ? null : <ReviewFooter review={review} onDecide={decide} />}
        </div>
      )}
    </section>
  );
}

/** The review of the shown run, or nothing when that run changed no files. */
export function ReviewCard() {
  const { review } = useWorkflowState();
  // Keyed by run, so a collapsed card of one run does not hide the next run's review.
  return review ? <ReviewCardBody key={review.runId} review={review} /> : null;
}
