/** Left palette: block types and agents to drag onto the river or click to add after the selection. */
import './palette.css';
import { type ReactNode, useState } from 'react';
import { useDraggable } from '@dnd-kit/core';
import { STEP_TYPE_INFO, STEP_TYPES } from '@isar-flow/core';
import { AgentStone, Button, IconButton, Stone } from '../../../components';
import { cx } from '../cx';
import { useEditor } from '../editorContext';
import { type DragItem, insertionTarget, dropEdit } from '../canvas/ops';
import { useWorkflowActions, useWorkflowState } from '../store';
import { patchEditorState, readEditorState } from '../viewState';
import { ROOT_LIST } from '../canvas/model';

function PaletteItem({
  id,
  item,
  leading,
  label,
  description,
  codeDescription,
  rail,
  disabledReason,
  onInsert,
}: {
  id: string;
  item: DragItem;
  leading: ReactNode;
  label: string;
  description: string;
  codeDescription?: boolean;
  rail: boolean;
  /** Set when a click cannot insert here (e.g. Break outside a loop); dragging still works. */
  disabledReason?: string;
  onInsert: () => void;
}) {
  const { editable } = useEditor();
  const { setNodeRef, listeners, attributes, isDragging } = useDraggable({
    id,
    data: { item },
    disabled: !editable,
  });
  const hint =
    disabledReason ??
    (rail ? `${label}: ${description}` : `Click to add after the selection, or drag onto the river`);
  return (
    <li className="wf-pal-row">
      <button
        ref={setNodeRef}
        {...attributes}
        {...listeners}
        type="button"
        role="button"
        className={cx('wf-pal-item', rail && 'wf-pal-item--rail', isDragging && 'wf-pal-item--dragging')}
        title={hint}
        aria-label={rail ? label : undefined}
        aria-disabled={!editable || disabledReason ? true : undefined}
        onClick={() => {
          if (editable && !disabledReason) onInsert();
        }}
      >
        {leading}
        {rail ? null : (
          <span className="wf-pal-item__text">
            <span className="wf-pal-item__label">{label}</span>
            <span
              className={codeDescription ? 'wf-pal-item__desc wf-pal-item__desc--code' : 'wf-pal-item__desc'}
            >
              {description}
            </span>
          </span>
        )}
        {rail ? null : <i className="codicon codicon-gripper wf-pal-item__grip" aria-hidden="true" />}
      </button>
    </li>
  );
}

export function Palette() {
  const [rail, setRail] = useState(() => readEditorState().paletteCollapsed ?? window.innerWidth < 1100);
  const { agents, selection } = useWorkflowState();
  const { createAgent } = useWorkflowActions();
  const { model, workflow, edit } = useEditor();
  const selected = selection ? model.byId.get(selection) : undefined;
  // Same rule as insertionTarget: after the selection, else at the end of the workflow.
  const targetList = selected?.list.targetable ? selected.list : ROOT_LIST;
  const insert = (item: Exclude<DragItem, { kind: 'move' }>) =>
    edit(dropEdit(item, insertionTarget(model, selection), workflow));
  // A block names an agent by id, so each id is offered once: the agent that id resolves to.
  const seen = new Set<string>();
  const usable = agents.filter((agent) => {
    if (agent.shadowed || seen.has(agent.id)) return false;
    seen.add(agent.id);
    return true;
  });

  const toggle = () => {
    setRail(!rail);
    patchEditorState({ paletteCollapsed: !rail });
  };

  return (
    <aside className={cx('wf-palette', rail && 'wf-palette--rail')} aria-label="Blocks and agents">
      <div className={cx('wf-palette__head', rail && 'wf-palette__head--rail')}>
        {rail ? null : <h2 className="wf-palette__title">Blocks</h2>}
        <IconButton
          icon={rail ? 'chevron-right' : 'chevron-left'}
          label={rail ? 'Expand the palette' : 'Collapse the palette'}
          aria-expanded={!rail}
          onClick={toggle}
        />
      </div>
      <div className="wf-palette__scroll">
        <ul className="wf-pal-list" aria-label="Blocks">
          {STEP_TYPES.map((type) => {
            const info = STEP_TYPE_INFO[type];
            const blocked = type === 'break' && !targetList?.insideLoop;
            return (
              <PaletteItem
                key={type}
                id={`palette:${type}`}
                item={{ kind: 'block', stepType: type }}
                leading={<Stone type={type} />}
                label={info.label}
                description={info.description}
                rail={rail}
                disabledReason={
                  blocked
                    ? 'Select a block inside a loop to add Break after it, or drag it into a loop'
                    : undefined
                }
                onInsert={() => insert({ kind: 'block', stepType: type })}
              />
            );
          })}
        </ul>
        {rail ? (
          <hr className="wf-palette__rule" />
        ) : (
          <h2 className="wf-palette__title wf-palette__title--agents">Agents</h2>
        )}
        {usable.length ? (
          <ul className="wf-pal-list" aria-label="Agents">
            {usable.map((agent) => (
              <PaletteItem
                key={agent.id}
                id={`agent:${agent.id}`}
                item={{ kind: 'agent', agentId: agent.id, name: agent.name }}
                leading={<AgentStone id={agent.id} name={agent.name} />}
                label={agent.name}
                description={agent.model}
                codeDescription
                rail={rail}
                onInsert={() => insert({ kind: 'agent', agentId: agent.id, name: agent.name })}
              />
            ))}
          </ul>
        ) : rail ? null : (
          <p className="wf-palette__empty">
            No agents yet. Agents are reusable AI helpers with a model, instructions and tools.
          </p>
        )}
      </div>
      <div className={cx('wf-palette__foot', rail && 'wf-palette__foot--rail')}>
        {rail ? (
          <IconButton icon="add" label="New agent" onClick={createAgent} />
        ) : (
          <Button variant="ghost" size="s" icon="add" onClick={createAgent}>
            New agent
          </Button>
        )}
      </div>
    </aside>
  );
}
