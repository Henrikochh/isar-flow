import { useEffect, useId, useRef, useState } from 'react';
import {
  type BlockNode,
  collectStepIds,
  STEP_ID_PATTERN,
  STEP_TYPE_INFO,
  type Workflow,
} from '@isar-flow/core';
import { IconButton, Popover, Stone, TextInput } from '../../../components';
import { MoveToMenu } from '../canvas/MoveToMenu';
import { useWorkflowActions, useWorkflowState } from '../store';
import { DraftInput } from './fields';
import { FieldIssues } from './Issues';
import { asString, blockIssues, blockTitle, isRecord, isStepType } from './model';
import { setOrUnset, useStepUpdate } from './settings/common';

/** Problem with a new block id, or undefined when it can be used. */
export function idProblem(
  text: string,
  currentId: string,
  workflow: Workflow | null | undefined,
): string | undefined {
  const id = text.trim();
  if (id === '') return 'Enter an id. Other blocks use it to read this block’s outputs.';
  if (!STEP_ID_PATTERN.test(id)) return 'Ids start with a letter or _ and use only letters, digits, _ and -.';
  if (id !== currentId && collectStepIds(workflow).includes(id))
    return `Another block already uses the id '${id}'.`;
  return undefined;
}

export function BlockHeader({
  block,
  stepId,
  onRename,
}: {
  block: BlockNode;
  stepId: string;
  onRename: (newId: string) => void;
}) {
  const { doc } = useWorkflowState();
  const actions = useWorkflowActions();
  const update = useStepUpdate(stepId);
  const step = isRecord(block.step) ? (block.step as unknown as Record<string, unknown>) : {};
  const type = isStepType(step.type) ? step.type : undefined;
  const issues = blockIssues(doc?.diagnostics ?? [], block, ['id', 'name']).byField;

  return (
    <header className="wf-insp-head" data-type={type}>
      <div className="wf-insp-head-row">
        {type ? (
          <Stone type={type} size="l" />
        ) : (
          <span className="if-stone if-stone--l wf-insp-stone-unknown" aria-hidden="true">
            <i className="codicon codicon-question" />
          </span>
        )}
        <div className="wf-insp-head-titles">
          <div className="wf-insp-head-name-row">
            <DraftInput
              className="wf-insp-name"
              aria-label="Block name"
              placeholder={stepId}
              value={asString(step.name)}
              onCommit={(name) => setOrUnset(update, 'name', name.trim())}
            />
            <div className="wf-insp-head-actions">
              <MoveButton stepId={stepId} workflow={doc?.workflow} />
              <IconButton
                icon="copy"
                label="Duplicate"
                onClick={() => actions.applyOps([{ op: 'duplicateStep', stepId }])}
              />
              <IconButton icon="go-to-file" label="Show in YAML" onClick={() => actions.openYaml(stepId)} />
              <IconButton
                icon="trash"
                label="Delete"
                className="wf-insp-delete"
                onClick={() => {
                  actions.applyOps([{ op: 'deleteStep', stepId }]);
                  actions.select(null);
                }}
              />
            </div>
          </div>
          <div className="wf-insp-head-meta">
            <span className="wf-insp-head-type">{type ? STEP_TYPE_INFO[type].label : 'Unknown block'}</span>
            <ParentLink block={block} />
          </div>
        </div>
      </div>
      <IdField id={stepId} workflow={doc?.workflow} onRename={onRename} />
      <FieldIssues issues={[...(issues.get('id') ?? []), ...(issues.get('name') ?? [])]} />
    </header>
  );
}

/** "Move to…": the keyboard-friendly way to put the block into another list. */
function MoveButton({ stepId, workflow }: { stepId: string; workflow: Workflow | null | undefined }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const { applyOps } = useWorkflowActions();
  return (
    <>
      <IconButton
        ref={ref}
        icon="move"
        label="Move to…"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      />
      <Popover
        open={open}
        anchorRef={ref}
        onClose={() => setOpen(false)}
        label="Move to"
        role="none"
        placement="bottom-end"
        width={264}
      >
        <MoveToMenu
          workflow={workflow}
          stepId={stepId}
          onMove={(target) => {
            setOpen(false);
            applyOps([{ op: 'moveStep', stepId, target }]);
            ref.current?.focus();
          }}
        />
      </Popover>
    </>
  );
}

const SLOT_LABELS: Record<string, string> = { steps: 'in', then: 'in Then of', else: 'in Else of' };

/** Where the block sits: its container (loop body or if branch); click selects the container. */
function ParentLink({ block }: { block: BlockNode }) {
  const actions = useWorkflowActions();
  const parent = block.ancestors[block.ancestors.length - 1];
  if (!parent) return null;
  const slot = String(block.path[block.path.length - 2]);
  const type = isStepType(parent.step.type) ? parent.step.type : undefined;
  const title = blockTitle(parent.step) || 'a block without id';
  return (
    <button
      type="button"
      className="wf-insp-parent"
      disabled={!parent.id}
      title={parent.id ? `Select ${title}` : undefined}
      onClick={() => parent.id && actions.select(parent.id)}
    >
      <span>{SLOT_LABELS[slot] ?? 'in'}</span>
      {type ? <Stone type={type} size="s" /> : null}
      <span className="wf-insp-parent-name">{title}</span>
    </button>
  );
}

function IdField({
  id,
  workflow,
  onRename,
}: {
  id: string;
  workflow: Workflow | null | undefined;
  onRename: (newId: string) => void;
}) {
  const [text, setText] = useState(id);
  const inputId = useId();
  // Enter commits and the following blur must not send the same rename again.
  const sent = useRef<string | null>(null);
  useEffect(() => {
    setText(id);
    sent.current = null;
  }, [id]);
  const problem = text === id ? undefined : idProblem(text, id, workflow);

  const commit = () => {
    const next = text.trim();
    if (next === id || next === sent.current || idProblem(next, id, workflow)) return;
    sent.current = next;
    onRename(next);
  };

  return (
    <div className="wf-insp-id">
      <div className="wf-insp-id-row">
        <label className="wf-insp-id-label" htmlFor={inputId}>
          Id
        </label>
        <TextInput
          id={inputId}
          code
          className="wf-insp-id-input"
          value={text}
          invalid={Boolean(problem)}
          aria-describedby={problem ? `${inputId}-error` : undefined}
          onChange={(event) => setText(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commit();
            if (event.key === 'Escape') {
              event.stopPropagation();
              setText(id);
            }
          }}
        />
      </div>
      {problem ? (
        <div className="if-field__error" id={`${inputId}-error`}>
          <i className="codicon codicon-error" aria-hidden="true" />
          <span>{problem}</span>
        </div>
      ) : null}
    </div>
  );
}
