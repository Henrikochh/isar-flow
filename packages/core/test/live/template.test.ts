import { describe, expect, it } from 'vitest';
import { templateAt } from '../../src/live';

describe('templateAt', () => {
  const text = 'Tests exited with ${{ steps.tests.exitCode }}: ${{ tail(steps.tests.output, 5) }}.';
  const first = text.indexOf('${{');
  const firstEnd = text.indexOf('}}') + 2;
  const second = text.indexOf('${{', firstEnd);

  it('finds the template whose span contains the offset', () => {
    const expected = { expr: 'steps.tests.exitCode', start: first, end: firstEnd };
    expect(templateAt(text, first)).toEqual(expected);
    expect(templateAt(text, first + 10)).toEqual(expected);
    expect(templateAt(text, firstEnd - 1)).toEqual(expected);
    expect(templateAt(text, second + 4)).toMatchObject({ expr: 'tail(steps.tests.output, 5)' });
  });

  it('returns undefined outside templates', () => {
    expect(templateAt(text, 0)).toBeUndefined();
    expect(templateAt(text, firstEnd)).toBeUndefined();
    expect(templateAt(text, text.length)).toBeUndefined();
    expect(templateAt(text, -1)).toBeUndefined();
    expect(templateAt('no templates here', 3)).toBeUndefined();
  });

  it('ignores }} inside string literals', () => {
    const quoted = "${{ 'a }} b' }} after";
    expect(templateAt(quoted, 8)).toEqual({ expr: "'a }} b'", start: 0, end: quoted.indexOf(' after') });
  });

  it('never throws for unterminated templates', () => {
    const broken = 'ok ${{ inputs.a }} then ${{ steps.b';
    expect(templateAt(broken, broken.length - 2)).toBeUndefined();
    expect(templateAt(broken, 5)).toMatchObject({ expr: 'inputs.a' });
    expect(templateAt('${{', 1)).toBeUndefined();
  });
});
