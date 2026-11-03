/** Export report and Copy for PR description of a finished run, in the run summary. */
import './report.css';
import type { RunView } from '@isar-flow/core';
import { Button } from '../../../components';
import { useWorkflowActions } from '../store';
import { useCopied } from './useCopied';

export function ReportActions({ run }: { run: RunView }) {
  const { runReport } = useWorkflowActions();
  const [copied, flash] = useCopied();
  if (run.status === 'running') return null;
  return (
    <div className="wf-run-report">
      <Button size="s" variant="secondary" icon="export" onClick={() => runReport(run.runId, 'export')}>
        Export report…
      </Button>
      <Button
        size="s"
        variant="ghost"
        icon={copied ? 'check' : 'git-pull-request'}
        onClick={() => {
          runReport(run.runId, 'copyForPr');
          flash();
        }}
      >
        {copied ? 'Copied' : 'Copy for PR description'}
      </Button>
    </div>
  );
}
