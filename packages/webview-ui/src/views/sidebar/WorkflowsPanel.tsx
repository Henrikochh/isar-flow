import { useRef } from 'react';
import type { SidebarState } from '@isar-flow/core';
import { Button, EmptyState, Section } from '../../components';
import { NewWorkflowCard } from './NewWorkflowCard';
import { RecentRuns } from './RecentRuns';
import { RiverArt } from './RiverArt';
import { WorkflowRow } from './WorkflowRow';
import { send, uniqueKeys, workflowRunState } from './model';
import { useNow } from './useNow';
import { NEW_WORKFLOW_DRAFT, type WorkflowDraft } from './viewState';
import './workflows.css';

export function WorkflowsPanel({
  state,
  draft,
  onDraftChange,
}: {
  state: Pick<SidebarState, 'workflows' | 'recentRuns' | 'activeRuns' | 'trusted'>;
  draft: WorkflowDraft | undefined;
  onDraftChange: (draft: WorkflowDraft | undefined) => void;
}) {
  const now = useNow();
  const newRef = useRef<HTMLButtonElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const { workflows, recentRuns } = state;
  const keys = uniqueKeys(workflows, (workflow) => workflow.uri);

  const open = () => (draft ? nameRef.current?.focus() : onDraftChange(NEW_WORKFLOW_DRAFT));
  const close = () => {
    onDraftChange(undefined);
    newRef.current?.focus();
  };

  return (
    <>
      <Section
        title="Workflows"
        actions={
          <Button ref={newRef} size="s" icon="add" aria-label="New workflow" aria-expanded={draft !== undefined} onClick={open}>
            New
          </Button>
        }
      >
        {draft ? (
          <NewWorkflowCard
            inputRef={nameRef}
            draft={draft}
            workflows={workflows}
            onChange={onDraftChange}
            onCancel={close}
            onCreate={({ name, template }) => {
              send({ type: 'createWorkflow', name, template });
              close();
            }}
          />
        ) : null}
        {workflows.length > 0 ? (
          <ul className="sb-list" aria-label="Workflows">
            {workflows.map((workflow, index) => (
              <li key={keys[index]}>
                <WorkflowRow workflow={workflow} run={workflowRunState(workflow, state)} trusted={state.trusted} now={now} />
              </li>
            ))}
          </ul>
        ) : draft ? null : (
          <EmptyState
            art={<RiverArt variant="workflows" />}
            title="No workflows yet"
            actions={
              <Button variant="primary" icon="add" onClick={open}>
                Create workflow
              </Button>
            }
          >
            Chain agents, console commands, loops and conditions.
          </EmptyState>
        )}
      </Section>
      {workflows.length > 0 || recentRuns.length > 0 ? <RecentRuns runs={recentRuns} now={now} /> : null}
    </>
  );
}
