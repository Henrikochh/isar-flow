/**
 * Drag and drop for the editor: palette items and canvas cards are draggable, insertion slots on the river
 * are the only drop targets.
 */
import { createContext, type ReactNode, useContext, useState } from 'react';
import {
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  MeasuringStrategy,
  type Modifier,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { STEP_TYPE_INFO } from '@isar-flow/core';
import { AgentStone, Stone } from '../../../components';
import { useEditor } from '../editorContext';
import { type ListInfo, targetOf } from './model';
import { canDrop, type DragItem, dropEdit, itemStepType } from './ops';

export interface SlotData {
  list: ListInfo;
  index: number;
}

const DragItemContext = createContext<DragItem | null>(null);

/** The item being dragged right now, if any. */
export function useDragItem(): DragItem | null {
  return useContext(DragItemContext);
}

let dragEndedAt = 0;

/** True right after a drag ended: the click that follows the pointer release must not change the selection. */
export function justDragged(): boolean {
  return performance.now() - dragEndedAt < 300;
}

/** Keeps the small drag preview under the pointer, wherever the drag started on a (possibly wide) block. */
const followPointer: Modifier = ({ activatorEvent, draggingNodeRect, transform }) => {
  const point = activatorEvent as { clientX?: unknown; clientY?: unknown } | null;
  if (!draggingNodeRect || typeof point?.clientX !== 'number' || typeof point.clientY !== 'number')
    return transform;
  return {
    ...transform,
    x: transform.x + point.clientX - draggingNodeRect.left - 18,
    y: transform.y + point.clientY - draggingNodeRect.top - 18,
  };
};

function itemOf(data: unknown): DragItem | null {
  return (data as { item?: DragItem | null } | undefined)?.item ?? null;
}

export function EditorDnd({ children }: { children: ReactNode }) {
  const { model, workflow, edit, editable } = useEditor();
  const [item, setItem] = useState<DragItem | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const finish = () => {
    dragEndedAt = performance.now();
    setItem(null);
  };

  const onDragStart = (event: DragStartEvent) => {
    setItem(editable ? itemOf(event.active.data.current) : null);
  };

  const onDragEnd = (event: DragEndEvent) => {
    const dragged = itemOf(event.active.data.current);
    const slot = event.over?.data.current as SlotData | undefined;
    finish();
    if (!editable || !dragged || !slot) return;
    if (!canDrop(dragged, slot.list, slot.index, model)) return;
    edit(dropEdit(dragged, targetOf(slot.list, slot.index), workflow));
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      // The canvas scrolls itself near its edges (useEdgeScroll), also for drags that start in the palette.
      autoScroll={false}
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={finish}
      accessibility={{
        screenReaderInstructions: {
          draggable:
            'Drag the block onto the river to add or move it. Without a mouse, click a block in the palette to add it after the selection.',
        },
      }}
    >
      <DragItemContext.Provider value={item}>{children}</DragItemContext.Provider>
      <DragOverlay dropAnimation={null} modifiers={[followPointer]}>
        {item ? <DragPreview item={item} /> : null}
      </DragOverlay>
    </DndContext>
  );
}

function DragPreview({ item }: { item: DragItem }) {
  const type = itemStepType(item);
  const label =
    item.kind === 'block'
      ? STEP_TYPE_INFO[item.stepType].label
      : item.kind === 'agent'
        ? item.name
        : item.title;
  return (
    <div className="wf-drag-preview" data-type={type}>
      {item.kind === 'agent' ? (
        <AgentStone id={item.agentId} name={item.name} size="s" />
      ) : type ? (
        <Stone type={type} size="s" />
      ) : null}
      <span className="wf-drag-preview__label">{label}</span>
    </div>
  );
}
