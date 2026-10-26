import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BreakableCode } from '../../../src/views/workflow/canvas/BreakableCode';

describe('BreakableCode', () => {
  it('lets long names wrap after dots and underscores, keeping the text as it is', () => {
    const text = 'steps.regression_suite_with_coverage.exitCode != 0';
    const { container } = render(<BreakableCode text={text} />);
    const code = container.querySelector('code') as HTMLElement;
    expect(code.textContent).toBe(text);
    // steps.|regression_|suite_|with_|coverage.|exitCode
    expect(code.querySelectorAll('wbr')).toHaveLength(5);
  });

  it('leaves names that fit on a line alone, so lines break at spaces', () => {
    const { container } = render(
      <BreakableCode text="tests.exitCode = 0 and review.json.approved is true" />,
    );
    expect(container.querySelectorAll('wbr')).toHaveLength(0);
  });
});
