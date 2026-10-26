import { findTemplateExpressions } from '@isar-flow/core';

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

/** Plain text with `${{ … }}` templates shown as inline code tokens. Never renders HTML. */
export function TemplateText({ text, className }: { text: string; className?: string }) {
  return (
    <span className={className}>
      {splitTemplate(text).map((piece, i) =>
        piece.expr ? (
          <span key={i} className="wf-expr">
            {piece.text}
          </span>
        ) : (
          piece.text
        ),
      )}
    </span>
  );
}
