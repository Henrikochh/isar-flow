import type { Diagnostic } from '@isar-flow/core';
import { Banner, Button } from '../../../components';

/** Problems that no field shows, listed at the top of a panel with a way to the YAML. */
export function IssueBanner({
  issues,
  subject,
  onShowYaml,
}: {
  issues: readonly Diagnostic[];
  /** e.g. "this block". */
  subject: string;
  onShowYaml?: () => void;
}) {
  if (issues.length === 0) return null;
  const hasError = issues.some((d) => d.severity === 'error');
  const single = issues.length === 1;
  return (
    <Banner
      tone={hasError ? 'error' : 'warning'}
      title={single ? issues[0].message : `${issues.length} problems in ${subject}`}
      actions={
        onShowYaml ? (
          <Button size="s" variant="secondary" icon="go-to-file" onClick={onShowYaml}>
            Show in YAML
          </Button>
        ) : undefined
      }
    >
      {single ? null : (
        <ul className="wf-insp-issues">
          {issues.map((issue, index) => (
            <li key={`${issue.code}:${index}`}>{issue.message}</li>
          ))}
        </ul>
      )}
    </Banner>
  );
}

/** Diagnostics shown under a custom control (the condition builder, list editors). */
export function FieldIssues({ issues }: { issues: readonly Diagnostic[] | undefined }) {
  if (!issues?.length) return null;
  return (
    <div className="wf-insp-field-issues">
      {issues.map((issue, index) => (
        <div key={`${issue.code}:${index}`} className={issue.severity === 'error' ? 'if-field__error' : 'wf-insp-warning'}>
          <i className={`codicon codicon-${issue.severity === 'error' ? 'error' : 'warning'} wf-insp-warning-icon`} aria-hidden="true" />
          <span>{issue.message}</span>
        </div>
      ))}
    </div>
  );
}
