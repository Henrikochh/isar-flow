import { forwardRef, type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { findTemplateExpressions } from '@isar-flow/core';
import { TextArea, type TextAreaProps } from '../../../components/Field';

/** Text split into plain runs and `${{ … }}` templates; unterminated templates stay plain. */
export function templateSegments(text: string): { text: string; template: boolean }[] {
  let matches: { start: number; end: number }[];
  try {
    matches = findTemplateExpressions(text);
  } catch {
    matches = [];
  }
  const segments: { text: string; template: boolean }[] = [];
  let at = 0;
  for (const match of matches) {
    if (match.start > at) segments.push({ text: text.slice(at, match.start), template: false });
    segments.push({ text: text.slice(match.start, match.end), template: true });
    at = match.end;
  }
  if (at < text.length) segments.push({ text: text.slice(at), template: false });
  return segments;
}

/**
 * Kit TextArea with `${{ … }}` templates tinted. A mirror with identical metrics sits behind the transparent
 * textarea and paints a wash under each template; the text itself stays the textarea's own.
 */
export const TemplateTextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TemplateTextArea(
  { value, onScroll, code, className, ...rest },
  forwardedRef,
) {
  const mirrorRef = useRef<HTMLDivElement>(null);
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const [scrolls, setScrolls] = useState(false);
  const text = typeof value === 'string' ? value : '';

  useLayoutEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    setScrolls(area.scrollHeight > area.clientHeight + 1);
    if (mirrorRef.current) mirrorRef.current.scrollTop = area.scrollTop;
  });

  const marks: ReactNode[] = templateSegments(text).map((segment, index) =>
    segment.template ? (
      <mark key={index} className="wf-hl-mark">
        {segment.text}
      </mark>
    ) : (
      <span key={index}>{segment.text}</span>
    ),
  );

  return (
    <div className="wf-hl">
      <div
        ref={mirrorRef}
        className={[
          'if-textarea',
          code && 'if-textarea--code',
          'wf-hl-mirror',
          scrolls && 'wf-hl-mirror--scroll',
        ]
          .filter(Boolean)
          .join(' ')}
        aria-hidden="true"
      >
        {marks}
        {/* A trailing newline in a textarea starts a new line; keep the mirror the same height. */}
        {'​'}
      </div>
      <TextArea
        {...rest}
        ref={(el) => {
          areaRef.current = el;
          if (typeof forwardedRef === 'function') forwardedRef(el);
          else if (forwardedRef) forwardedRef.current = el;
        }}
        code={code}
        value={value}
        className={['wf-hl-input', className].filter(Boolean).join(' ')}
        onScroll={(event) => {
          if (mirrorRef.current) mirrorRef.current.scrollTop = event.currentTarget.scrollTop;
          onScroll?.(event);
        }}
      />
    </div>
  );
});
