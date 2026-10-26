/** A list of blocks on the river: segments with insertion points between the blocks. */
import { Fragment, type ReactNode, useRef, useState } from 'react';
import { useDroppable } from '@dnd-kit/core';
import type { StepType } from '@isar-flow/core';
import { cx } from '../cx';
import { useEditor } from '../editorContext';
import { BlockCard } from './BlockCard';
import { BlockPicker } from './BlockPicker';
import { useCanvas } from './canvasContext';
import { type SlotData, useDragItem } from './dnd';
import { IfBlock } from './IfBlock';
import { LoopBlock } from './LoopBlock';
import { type BlockEntry, type ListInfo, type ListModel, targetOf } from './model';
import { canDrop, dropEdit, itemStepType } from './ops';
import { type FlowState, segmentState } from './runOverlay';

/** Droppable wiring for one insertion slot of a list. */
export function useSlot(list: ListInfo, index: number) {
  const drag = useDragItem();
  const { model } = useEditor();
  const allowed = drag !== null && canDrop(drag, list, index, model);
  const data: SlotData = { list, index };
  const { setNodeRef, isOver } = useDroppable({
    id: `slot:${list.key}:${index}`,
    data,
    disabled: !allowed,
    resizeObserverConfig: { updateMeasurementsFor: [] },
  });
  return {
    drag,
    allowed,
    over: allowed && isOver,
    setNodeRef,
    dragType: drag ? itemStepType(drag) : undefined,
  };
}

/** "+" on the river that opens the block picker for this position. */
function InsertButton({ list, index }: { list: ListInfo; index: number }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const { workflow, edit } = useEditor();
  const pick = (stepType: StepType) =>
    edit(dropEdit({ kind: 'block', stepType }, targetOf(list, index), workflow));
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={cx('wf-insert', open && 'wf-insert--open')}
        aria-label="Add block here"
        title="Add block"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((o) => !o);
        }}
      >
        <i className="codicon codicon-add wf-insert__icon" aria-hidden="true" />
      </button>
      <BlockPicker
        open={open}
        anchorRef={ref}
        onClose={() => setOpen(false)}
        onPick={pick}
        insideLoop={list.insideLoop}
      />
    </>
  );
}

function Line({ state, lead }: { state: FlowState; lead?: boolean }) {
  return <span className={cx('wf-line', `wf-line--${state}`, lead && 'wf-line--lead')} aria-hidden="true" />;
}

/** River piece between two blocks. While dragging it opens into a drop slot. */
export function Segment({
  list,
  index,
  state,
  grow,
}: {
  list: ListModel;
  index: number;
  state: FlowState;
  grow?: boolean;
}) {
  const { editable } = useEditor();
  const slot = useSlot(list.info, index);
  return (
    <div
      ref={slot.setNodeRef}
      className={cx('wf-seg', slot.allowed && 'wf-seg--open', grow && 'wf-seg--grow')}
      data-type={slot.allowed ? slot.dragType : undefined}
    >
      <Line state={state} />
      <span
        className={cx('wf-slot', slot.allowed && 'wf-slot--open', slot.over && 'wf-slot--over')}
        aria-hidden="true"
      />
      <Line state={state} />
      {!slot.drag && editable && list.info.targetable ? (
        <InsertButton list={list.info} index={index} />
      ) : null}
    </div>
  );
}

/** An empty list: one dashed slot that accepts drops and opens the block picker on click. */
function EmptyLane({ list, state, grow }: { list: ListModel; state: FlowState; grow?: boolean }) {
  const { editable, workflow, edit } = useEditor();
  const slot = useSlot(list.info, 0);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const canInsert = editable && list.info.targetable;
  return (
    <div className={cx('wf-empty-lane', grow && 'wf-empty-lane--grow')}>
      <Line state={state} lead />
      <div
        ref={slot.setNodeRef}
        className="wf-empty-lane__target"
        data-type={slot.allowed ? slot.dragType : undefined}
      >
        {canInsert ? (
          <button
            ref={ref}
            type="button"
            className={cx(
              'wf-placeholder wf-placeholder--button',
              slot.allowed && 'wf-placeholder--open',
              slot.over && 'wf-placeholder--over',
            )}
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={(event) => {
              event.stopPropagation();
              setOpen((o) => !o);
            }}
          >
            <i className="codicon codicon-add" aria-hidden="true" />
            Drop a block here
          </button>
        ) : (
          <span className="wf-placeholder">Empty</span>
        )}
      </div>
      <Line state={state} />
      <BlockPicker
        open={open}
        anchorRef={ref}
        onClose={() => setOpen(false)}
        insideLoop={list.info.insideLoop}
        onPick={(stepType) => edit(dropEdit({ kind: 'block', stepType }, targetOf(list.info, 0), workflow))}
      />
    </div>
  );
}

function Block({ entry }: { entry: BlockEntry }): ReactNode {
  if (entry.type === 'loop') return <LoopBlock entry={entry} />;
  if (entry.type === 'if') return <IfBlock entry={entry} />;
  return <BlockCard entry={entry} />;
}

/**
 * Blocks of one list with a segment above each block and a trailing one. `grow` lets the trailing segment
 * stretch (If lanes of different lengths still meet at the merge).
 */
export function RiverList({
  list,
  owner,
  grow,
}: {
  list: ListModel;
  owner: BlockEntry | null;
  grow?: boolean;
}) {
  const { run } = useCanvas();
  const n = list.entries.length;
  if (n === 0) return <EmptyLane list={list} state={segmentState(run, list, 0, owner)} grow={grow} />;
  return (
    <div className={cx('wf-list', grow && 'wf-list--grow')}>
      {list.entries.map((entry, index) => (
        <Fragment key={entry.key}>
          <Segment list={list} index={index} state={segmentState(run, list, index, owner)} />
          <Block entry={entry} />
        </Fragment>
      ))}
      <Segment list={list} index={n} state={segmentState(run, list, n, owner)} grow={grow} />
    </div>
  );
}
