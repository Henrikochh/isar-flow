import { describe, expect, it } from 'vitest';
import { applyWorkflowOps, rewriteExpressionReferences, rewriteStepReferences } from '../../src/yaml';

const renames = new Map([['tests', 'checks']]);

describe('rewriteExpressionReferences', () => {
  it('rewrites dotted and bracketed references, also with spaces inside the brackets', () => {
    expect(rewriteExpressionReferences("steps.tests.exitCode == 0 && steps[ 'tests' ].ok", renames)).toBe(
      "steps.checks.exitCode == 0 && steps[ 'checks' ].ok",
    );
    expect(rewriteExpressionReferences('steps["tests"].output', renames)).toBe('steps["checks"].output');
  });

  it('follows the lexer: dashes join identifiers, string literals are not references', () => {
    expect(rewriteExpressionReferences('steps.tests-x.ok || steps.tests - 1', renames)).toBe(
      'steps.tests-x.ok || steps.checks - 1',
    );
    expect(rewriteExpressionReferences('contains(x, \'steps.tests\') || "a\\"steps.tests"', renames)).toBe(
      'contains(x, \'steps.tests\') || "a\\"steps.tests"',
    );
    expect(rewriteExpressionReferences('mysteps.tests || x.steps.tests || a-steps.tests', renames)).toBe(
      'mysteps.tests || x.steps.tests || a-steps.tests',
    );
  });

  it('only renames exact ids', () => {
    expect(rewriteExpressionReferences('steps.tests_2.ok', renames)).toBe('steps.tests_2.ok');
    expect(rewriteExpressionReferences('steps.tests.ok', new Map())).toBe('steps.tests.ok');
  });
});

describe('rewriteStepReferences', () => {
  it('rewrites inside templates only', () => {
    expect(rewriteStepReferences('see steps.tests: ${{ steps.tests.output }}', renames)).toBe(
      'see steps.tests: ${{ steps.checks.output }}',
    );
    expect(rewriteStepReferences('${{ "}}" + steps.tests.ok }} ${{steps.tests.ok}}', renames)).toBe(
      '${{ "}}" + steps.checks.ok }} ${{steps.checks.ok}}',
    );
  });

  it('leaves text with an unterminated template unchanged', () => {
    expect(rewriteStepReferences('${{ steps.tests.ok', renames)).toBe('${{ steps.tests.ok');
    const text =
      'version: 1\nname: x\nsteps:\n  - id: tests\n    type: console\n    run: echo ${{ steps.tests.ok\n';
    expect(applyWorkflowOps(text, [{ op: 'renameStep', stepId: 'tests', newId: 'checks' }])).toEqual({
      text: text.replace('id: tests', 'id: checks'),
    });
  });
});
