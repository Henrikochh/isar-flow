import { Fragment, type ReactNode } from 'react';

/** Names longer than this rarely fit on a card line; shorter ones only break at spaces. */
const LONG_NAME = 24;

function breakable(word: string): ReactNode {
  if (word.length <= LONG_NAME) return word;
  return word.split(/(?<=[._])/).map((part, i) => (
    <Fragment key={i}>
      {i > 0 ? <wbr /> : null}
      {part}
    </Fragment>
  ));
}

/**
 * Code (conditions, ids) that wraps at spaces first, and inside long names after dots and underscores, so a long
 * name continues on the same line as the words before it instead of breaking in the middle of a word.
 */
export function BreakableCode({
  text,
  className,
  title,
}: {
  text: string;
  className?: string;
  title?: string;
}) {
  return (
    <code className={className} title={title}>
      {text.split(/(\s+)/).map((word, i) => (
        <Fragment key={i}>{breakable(word)}</Fragment>
      ))}
    </code>
  );
}
