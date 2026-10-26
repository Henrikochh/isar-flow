import type { HTMLAttributes, MouseEvent } from 'react';
import { useDraggable } from '@dnd-kit/core';
import { STEP_TYPE_INFO, type StepStatus } from '@isar-flow/core';
import { useEditor } from '../editorContext';
import { useCanvas } from './canvasContext';
import { type BlockEntry, blockTitle } from './model';
import { effectiveStatus } from './runOverlay';
import type { DragItem } from './ops';

export interface BlockHandle {
  /** Props for the element that is clicked, focused and dragged (card or container header). */
  props: HTMLAttributes<HTMLElement> & {
    ref: (el: HTMLElement | null) => void;
    'data-step-id'?: string;
    'data-wf-card': '';
  };
  selected: boolean;
  dragging: boolean;
  status: StepStatus | undefined;
  title: string;
}

/** Selection, keyboard focus and drag wiring shared by cards and container headers. */
export function useBlockHandle(entry: BlockEntry): BlockHandle {
  const { editable } = useEditor();
  const { selection, tabStop, select, run, openMenu } = useCanvas();
  const title = blockTitle(entry);
  const item: DragItem | null = entry.id
    ? { kind: 'move', stepId: entry.id, stepType: entry.type, title }
    : null;
  const { setNodeRef, listeners, isDragging } = useDraggable({
    id: `move:${entry.key}`,
    data: { item },
    disabled: !editable || !item,
  });
  const selected = entry.id !== undefined && entry.id === selection;
  const typeLabel = entry.type ? STEP_TYPE_INFO[entry.type].label : 'Block';
  const onClick = (event: MouseEvent) => {
    event.stopPropagation();
    if (entry.id) select(entry.id);
  };
  const onContextMenu = (event: MouseEvent) => {
    event.stopPropagation();
    if (!entry.id || !editable) return;
    event.preventDefault();
    select(entry.id);
    openMenu(entry.id, { x: event.clientX, y: event.clientY });
  };
  return {
    props: {
      ref: setNodeRef,
      ...listeners,
      role: 'button',
      tabIndex: entry.id !== undefined && entry.id === tabStop ? 0 : -1,
      'aria-pressed': selected,
      'aria-label': `${typeLabel} block ${title}`,
      'data-step-id': entry.id,
      'data-wf-card': '',
      onClick,
      onContextMenu,
    },
    selected,
    dragging: isDragging,
    status: effectiveStatus(run, entry),
    title,
  };
}
