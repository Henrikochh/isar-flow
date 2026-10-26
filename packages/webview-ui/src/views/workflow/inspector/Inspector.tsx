import { useEffect, useRef, useState } from 'react';
import type { BlockNode, RunView } from '@isar-flow/core';
import { EmptyState, SegmentedControl, StatusGlyph } from '../../../components';
import { useWorkflowActions, useWorkflowState } from '../store';
import { BlockHeader } from './BlockHeader';
import { findBlock } from './model';
import { RunOutput } from './run/RunOutput';
import { RunSummary } from './run/RunSummary';
import { BlockSettings } from './settings/BlockSettings';
import { WorkflowPanel } from './workflow/WorkflowPanel';
// After the kit imports, so these styles win over kit defaults of equal specificity.
import './inspector.css';
import './run/run.css';

type BlockTab = 'settings' | 'output';
type WorkflowTab = 'run' | 'workflow';

interface PendingRename {
  from: string;
  to: string;
}

/**
 * Right-hand column of the workflow editor. Shows the selected block's settings (and its run output while a run
 * is on the canvas), or the workflow settings and the run summary when nothing is selected.
 */
export function Inspector() {
  const { doc, selection, run, runLive, opsError } = useWorkflowState();
  const actions = useWorkflowActions();
  const workflow = doc?.workflow ?? null;

  // A rename selects the new id at once; until the document confirms it, keep showing the block by its old id.
  const [rename, setRename] = useState<PendingRename | null>(null);
  const alias = useRef<PendingRename | null>(null);
  let block = findBlock(workflow, selection);
  if (!block && rename && selection === rename.to) block = findBlock(workflow, rename.from);

  useEffect(() => {
    if (rename && findBlock(workflow, rename.to)) setRename(null);
  }, [workflow, rename]);

  useEffect(() => {
    if (!rename || !opsError) return;
    actions.select(rename.from);
    setRename(null);
  }, [opsError]);

  const [blockTab, setBlockTab] = useState<BlockTab>('output');
  const [workflowTab, setWorkflowTab] = useState<WorkflowTab>('run');
  const runId = run?.runId;
  useEffect(() => {
    setBlockTab('output');
    setWorkflowTab('run');
  }, [runId]);

  // Keeps the panel (and its slide-in) stable when the selected block is only renamed.
  const panelKey = selection && alias.current?.to === selection ? alias.current.from : (selection ?? 'workflow');
  const asideRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (asideRef.current) asideRef.current.scrollTop = 0;
  }, [panelKey]);

  let content;
  if (!doc) {
    content = <div className="wf-insp-loading" aria-busy="true" />;
  } else if (!workflow) {
    // The canvas banner names the error and links to it; here a quiet note is enough.
    content = (
      <EmptyState title="Editing is paused">
        <span className="wf-insp-paused">Fix the YAML error to edit the workflow here again.</span>
      </EmptyState>
    );
  } else if (block && selection) {
    const stepId = block.id ?? selection;
    content = (
      <BlockPanel
        block={block}
        stepId={stepId}
        run={run}
        tab={blockTab}
        onTab={setBlockTab}
        onRename={(newId) => {
          const pending = { from: stepId, to: newId };
          alias.current = { from: alias.current?.to === stepId ? alias.current.from : stepId, to: newId };
          setRename(pending);
          actions.applyOps([{ op: 'renameStep', stepId, newId }]);
          actions.select(newId);
        }}
      />
    );
  } else if (run) {
    content = (
      <>
        <div className="wf-insp-tabs wf-insp-tabs--top">
          <SegmentedControl<WorkflowTab>
            role="tablist"
            label="Inspector view"
            full
            value={workflowTab}
            onChange={setWorkflowTab}
            options={[
              { value: 'run', label: 'Run summary' },
              { value: 'workflow', label: 'Workflow' },
            ]}
          />
        </div>
        {workflowTab === 'run' ? <RunSummary run={run} live={runLive} workflow={workflow} /> : <WorkflowPanel withHeader={false} />}
      </>
    );
  } else {
    content = <WorkflowPanel />;
  }

  return (
    <aside ref={asideRef} className="wf-inspector" aria-label="Inspector" tabIndex={-1}>
      <div key={panelKey} className="wf-insp-panel">
        {content}
      </div>
    </aside>
  );
}

function BlockPanel({
  block,
  stepId,
  run,
  tab,
  onTab,
  onRename,
}: {
  block: BlockNode;
  stepId: string;
  run: RunView | null;
  tab: BlockTab;
  onTab: (tab: BlockTab) => void;
  onRename: (newId: string) => void;
}) {
  const showOutput = run !== null && tab === 'output';
  const stepStatus = run?.steps[stepId]?.status;
  return (
    <>
      <div className="wf-insp-sticky">
        <BlockHeader block={block} stepId={stepId} onRename={onRename} />
        {run ? (
          <div className="wf-insp-tabs">
            <SegmentedControl<BlockTab>
              role="tablist"
              label="Block view"
              full
              value={tab}
              onChange={onTab}
              options={[
                { value: 'settings', label: 'Settings' },
                {
                  value: 'output',
                  label: (
                    <span className="wf-insp-tab-label">
                      {stepStatus ? <StatusGlyph status={stepStatus} /> : null}
                      Run output
                    </span>
                  ),
                },
              ]}
            />
          </div>
        ) : null}
      </div>
      {showOutput ? <RunOutput block={block} stepId={stepId} run={run} /> : <BlockSettings block={block} stepId={stepId} />}
    </>
  );
}
