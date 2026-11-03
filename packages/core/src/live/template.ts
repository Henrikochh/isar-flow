import { ExpressionError, findTemplateExpressions, type TemplateMatch } from '../expr';

function templatesIn(text: string): TemplateMatch[] {
  try {
    return findTemplateExpressions(text);
  } catch (error) {
    // An unterminated template runs to the end of the text; the complete ones before it still count.
    const offset = error instanceof ExpressionError ? error.offset : undefined;
    return offset === undefined || offset <= 0 ? [] : templatesIn(text.slice(0, offset));
  }
}

/** The `${{ … }}` template whose span contains the offset (start <= offset < end). Never throws. */
export function templateAt(text: string, offset: number): TemplateMatch | undefined {
  if (typeof text !== 'string' || !text.includes('${{')) return undefined;
  return templatesIn(text).find((match) => match.start <= offset && offset < match.end);
}
