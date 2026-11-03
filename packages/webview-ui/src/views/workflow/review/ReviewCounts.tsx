import type { ReviewCounts as Counts } from '@isar-flow/core';
import { Chip } from '../../../components';
import { decidedSummary, pendingLabel } from './model';

/**
 * Review state of a past run for history lists: a warning chip while files wait for a decision, else what was
 * decided as plain text (the list decides its color, so it keeps contrast on hover and selection).
 */
export function ReviewCounts({ counts }: { counts: Counts | undefined }) {
  if (!counts || counts.total === 0) return null;
  if (counts.pending > 0) return <Chip tone="warning">{pendingLabel(counts.pending)}</Chip>;
  const summary = decidedSummary(counts);
  return summary ? <span>{summary}</span> : null;
}
