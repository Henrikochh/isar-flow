import { useState } from 'react';
import type { Diagnostic, Workflow, WorkflowIsolation } from '@isar-flow/core';
import { Banner, Button, SegmentedControl } from '../../../../components';
import { useWorkflowActions } from '../../store';
import { asStringList } from '../model';
import { ListEditor } from '../RowEditors';
import { Group } from '../settings/common';

/** Where a run changes files: the workspace itself, or a git worktree whose changes are reviewed and copied. */
export function IsolationSettings({
  workflow,
  issues,
}: {
  workflow: Workflow;
  issues: Map<string, Diagnostic[]>;
}) {
  const actions = useWorkflowActions();
  const [confirming, setConfirming] = useState(false);
  const isolation: WorkflowIsolation = workflow.isolation === 'worktree' ? 'worktree' : 'workspace';
  const setup = asStringList(workflow.setup);

  const toWorkspace = () => {
    setConfirming(false);
    actions.applyOps([{ op: 'updateWorkflow', set: {}, unset: ['isolation', 'setup'] }]);
  };
  const choose = (next: WorkflowIsolation) => {
    if (next === isolation) return;
    if (next === 'worktree') {
      setConfirming(false);
      actions.applyOps([{ op: 'updateWorkflow', set: { isolation: 'worktree' } }]);
    } else if (setup.length) setConfirming(true);
    else toWorkspace();
  };

  return (
    <>
      <Group label="Run in" issues={issues.get('isolation')}>
        <SegmentedControl<WorkflowIsolation>
          label="Run in"
          full
          value={isolation}
          options={[
            { value: 'workspace', label: 'Workspace' },
            { value: 'worktree', label: 'Separate worktree' },
          ]}
          onChange={choose}
        />
        <div className="if-field__hint">
          Separate worktree: the run works on a copy of this git repository, and you choose which changes to
          keep.
        </div>
        {confirming ? (
          <Banner
            tone="warning"
            actions={
              <>
                <Button size="s" variant="danger" onClick={toWorkspace}>
                  Switch to Workspace
                </Button>
                <Button size="s" variant="ghost" onClick={() => setConfirming(false)}>
                  Cancel
                </Button>
              </>
            }
          >
            Setup commands only run in a separate worktree. Switching to Workspace removes them.
          </Banner>
        ) : null}
      </Group>
      {/* Setup commands in a workspace run are shown too, so they can be removed. */}
      {isolation === 'worktree' || setup.length ? (
        <Group
          label="Setup commands"
          description={
            isolation === 'worktree'
              ? 'Run first in the worktree, for example npm ci.'
              : // The document's own warning replaces this text once validation reports it.
                issues.get('setup')?.length
                ? undefined
                : 'These only run in a separate worktree. Choose Separate worktree or remove them.'
          }
          issues={issues.get('setup')}
        >
          <ListEditor
            values={setup}
            noun="Setup command"
            addLabel="Add command"
            placeholder="npm ci"
            onCommit={(commands) =>
              actions.applyOps([
                commands.length
                  ? { op: 'updateWorkflow', set: { setup: commands } }
                  : { op: 'updateWorkflow', set: {}, unset: ['setup'] },
              ])
            }
          />
        </Group>
      ) : null}
    </>
  );
}
