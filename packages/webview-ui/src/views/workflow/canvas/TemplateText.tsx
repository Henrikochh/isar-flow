import { useEffect } from 'react';
import { findTemplateExpressions } from '@isar-flow/core';
import { cx } from '../cx';
import { useLiveSource } from '../live/LiveDataProvider';
import { TemplateValueTip } from '../live/TemplateValueTip';
import { useHoverTip } from '../live/useHoverTip';

type Piece = { text: string; expr: boolean };

export function splitTemplate(text: string): Piece[] {
  let matches;
  try {
    matches = findTemplateExpressions(text);
  } catch {
    return [{ text, expr: false }];
  }
  const pieces: Piece[] = [];
  let at = 0;
  for (const m of matches) {
    if (m.start > at) pieces.push({ text: text.slice(at, m.start), expr: false });
    pieces.push({ text: m.expr, expr: true });
    at = m.end;
  }
  if (at < text.length) pieces.push({ text: text.slice(at), expr: false });
  return pieces;
}

/**
 * Plain text with `${{ … }}` templates shown as inline code tokens. Never renders HTML. With a run to read from,
 * hovering a token shows its value (the card stays the only tab stop; keyboard users find values in the inspector).
 */
export function TemplateText({
  text,
  className,
  stepId,
}: {
  text: string;
  className?: string;
  stepId?: string;
}) {
  const source = useLiveSource();
  const tip = useHoverTip();
  const { close } = tip;
  // New text renders new tokens: a card open on an old one would point at nothing.
  useEffect(() => close(), [text, close]);
  return (
    <span className={className}>
      {splitTemplate(text).map((piece, i) =>
        piece.expr ? (
          <span
            key={i}
            className={cx('wf-expr', source && 'wf-expr-live')}
            onMouseEnter={source ? (event) => tip.enter(event.currentTarget, piece.text) : undefined}
            onMouseLeave={source ? tip.leave : undefined}
          >
            {piece.text}
          </span>
        ) : (
          piece.text
        ),
      )}
      {source && tip.target ? (
        <TemplateValueTip
          target={tip.target}
          stepId={stepId}
          onMouseEnter={tip.keep}
          onMouseLeave={tip.leave}
        />
      ) : null}
    </span>
  );
}
