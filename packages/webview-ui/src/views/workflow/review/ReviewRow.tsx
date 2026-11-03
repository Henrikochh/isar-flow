import type { ReviewFile, RunReview } from '@isar-flow/core';
import { BLOCK_ICONS } from '../../../blockMeta';
import { Chip, IconButton } from '../../../components';
import { blockTitle } from '../canvas/model';
import { cx } from '../cx';
import { useEditor } from '../editorContext';
import { useWorkflowActions } from '../store';
import { keepBlocker, revertBlocker, splitPath, STATUS_INFO } from './model';
import { Reason } from './Reason';

const count = (n: number) => n.toLocaleString('en-US');

function PathText({ path }: { path: string }) {
  const { folder, name } = splitPath(path);
  return (
    <>
      {folder ? <span className="wf-review-folder">{folder}</span> : null}
      <span className="wf-review-name">{name}</span>
    </>
  );
}

/** A block that wrote the file; selecting it reveals the block on the canvas. */
function BlockChip({ stepId }: { stepId: string }) {
  const { model } = useEditor();
  const { select } = useWorkflowActions();
  const entry = model.byId.get(stepId);
  if (!entry) {
    return (
      <Chip code title="This block is no longer in the workflow.">
        {stepId}
      </Chip>
    );
  }
  const title = blockTitle(entry);
  return (
    <button
      type="button"
      className="wf-review-block"
      aria-label={`Select block ${title}`}
      title={`Select block ${title}`}
      onClick={() => select(stepId)}
    >
      <Chip icon={entry.type ? BLOCK_ICONS[entry.type] : undefined}>{title}</Chip>
    </button>
  );
}

/** Keeps or reverts one file, or every pending file when `path` is omitted. */
export type Decide = (decision: 'kept' | 'reverted', path?: string) => void;

export function ReviewRow({
  review,
  file,
  onDecide,
}: {
  review: RunReview;
  file: ReviewFile;
  onDecide: Decide;
}) {
  const actions = useWorkflowActions();
  const status = STATUS_INFO[file.status];
  const busy = review.busy === true;

  return (
    <li
      className={cx('wf-review-row', file.decision !== 'pending' && 'wf-review-row--decided')}
      data-path={file.path}
    >
      <span className="wf-review-status" title={status.label}>
        <i
          className={`codicon codicon-${status.icon} wf-review-status-icon wf-review-status-icon--${file.status}`}
          aria-hidden="true"
        />
        <span className="if-visually-hidden">{status.label}</span>
      </span>
      {file.binary ? (
        <span className="wf-review-path" title={file.path}>
          <PathText path={file.path} />
        </span>
      ) : (
        <button
          type="button"
          className="wf-review-path wf-review-path--link"
          aria-label={`Open diff of ${file.path}`}
          title={`Open diff of ${file.path}`}
          onClick={() => actions.openReviewDiff(review.runId, file.path)}
        >
          <PathText path={file.path} />
        </button>
      )}
      <span className="wf-review-meta">
        {file.binary ? <Chip>Binary</Chip> : null}
        {!file.binary && file.additions ? (
          <span className="wf-review-add" title={`${count(file.additions)} lines added`}>
            +{count(file.additions)}
          </span>
        ) : null}
        {!file.binary && file.deletions ? (
          <span className="wf-review-del" title={`${count(file.deletions)} lines removed`}>
            −{count(file.deletions)}
          </span>
        ) : null}
        {file.stepIds.length ? (
          file.stepIds.map((id) => <BlockChip key={id} stepId={id} />)
        ) : (
          <Chip icon="terminal" tone="outline" title="Changed by a console command">
            Command
          </Chip>
        )}
      </span>
      <span className="wf-review-actions">
        {file.decision === 'kept' ? (
          <Chip tone="success" icon="check">
            Kept
          </Chip>
        ) : file.decision === 'reverted' ? (
          <Chip icon="discard">Reverted</Chip>
        ) : (
          <>
            <Reason reason={keepBlocker(review)}>
              {(blocked) => (
                <IconButton
                  icon="check"
                  label={`Keep ${file.path}`}
                  disabled={busy}
                  {...blocked}
                  onClick={() => onDecide('kept', file.path)}
                />
              )}
            </Reason>
            <Reason reason={revertBlocker(review, file)}>
              {(blocked) => (
                <IconButton
                  icon="discard"
                  label={`Revert ${file.path}`}
                  disabled={busy}
                  {...blocked}
                  onClick={() => onDecide('reverted', file.path)}
                />
              )}
            </Reason>
          </>
        )}
      </span>
      {file.error ? (
        <p className="wf-review-error">
          <i className="codicon codicon-error wf-review-error-icon" aria-hidden="true" />
          <span>{file.error}</span>
        </p>
      ) : null}
    </li>
  );
}
