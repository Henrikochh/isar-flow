/** The river canvas: scrolls both ways, zooms, and renders the workflow as one stream from Start to End. */
import { useEffect, useRef } from 'react';
import { Button, EmptyState } from '../../../components';
import { useEditor } from '../editorContext';
import { useWorkflowActions, useWorkflowState } from '../store';
import { CanvasDataProvider, useCanvas } from './canvasContext';
import { justDragged, useDragItem } from './dnd';
import { EndMarker, StartMarker } from './Markers';
import { ROOT_LIST } from './model';
import { dropEdit } from './ops';
import { cx } from '../cx';
import { RiverList, useSlot } from './River';
import { cardElement, useCanvasKeyboard } from './useCanvasKeyboard';
import { useEdgeScroll } from './useEdgeScroll';
import { useZoom } from './useZoom';
import { ZoomControl } from './ZoomControl';

/** Empty workflow: an invitation between Start and End that also accepts the first drop. */
function EmptyRiver() {
  const { editable, workflow, edit } = useEditor();
  const slot = useSlot(ROOT_LIST, 0);
  const add = (stepType: 'agent' | 'console') =>
    edit(dropEdit({ kind: 'block', stepType }, { parentId: null, slot: 'steps', index: 0 }, workflow));
  return (
    <>
      <span className="wf-line wf-line--idle wf-line--stub" aria-hidden="true" />
      <div
        ref={slot.setNodeRef}
        className={cx(
          'wf-empty-root',
          slot.allowed && 'wf-empty-root--open',
          slot.over && 'wf-empty-root--over',
        )}
        data-type={slot.allowed ? slot.dragType : undefined}
      >
        <EmptyState
          title="Add your first block"
          actions={
            editable ? (
              <>
                <Button variant="secondary" icon="sparkle" onClick={() => add('agent')}>
                  Add agent
                </Button>
                <Button variant="secondary" icon="terminal" onClick={() => add('console')}>
                  Add console command
                </Button>
              </>
            ) : null
          }
        >
          <span className="wf-empty-root__text">Drag a block from the left or click one to add it.</span>
        </EmptyState>
      </div>
      <span className="wf-line wf-line--idle wf-line--stub" aria-hidden="true" />
    </>
  );
}

function River() {
  const { model, workflow } = useEditor();
  const { run } = useCanvas();
  const empty = model.root.entries.length === 0;
  return (
    <>
      <StartMarker workflow={workflow} />
      {empty ? <EmptyRiver /> : <RiverList list={model.root} owner={null} />}
      <EndMarker run={run} />
    </>
  );
}

export function Canvas() {
  const { workflow, stale, model } = useEditor();
  const { selection, approvals } = useWorkflowState();
  const drag = useDragItem();
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const { zoom, setZoom, fit } = useZoom(scrollRef, contentRef);
  const onKeyDown = useCanvasKeyboard(scrollRef);
  useEdgeScroll(scrollRef, drag !== null);
  const centered = useRef(false);
  const { select } = useWorkflowActions();

  // Reveal the selected block (also when the host asks to focus one).
  useEffect(() => {
    if (selection)
      cardElement(scrollRef.current, selection)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [selection]);

  // A block waiting for approval needs the user: bring it into view when the request arrives.
  const seenApprovals = useRef(new Set<string>());
  useEffect(() => {
    for (const prompt of approvals) {
      if (seenApprovals.current.has(prompt.requestId)) continue;
      seenApprovals.current.add(prompt.requestId);
      cardElement(scrollRef.current, prompt.stepId)?.scrollIntoView({ block: 'center', inline: 'nearest' });
    }
  }, [approvals]);

  // When the river is wider than the canvas, start scrolled to its center line.
  useEffect(() => {
    const el = scrollRef.current;
    if (centered.current || !el || model.entries.length === 0) return;
    centered.current = true;
    if (el.scrollWidth > el.clientWidth) el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2;
  }, [model]);

  return (
    <CanvasDataProvider>
      <div className="wf-canvas-wrap">
        <div
          ref={scrollRef}
          className={cx('wf-canvas', drag && 'wf-canvas--dragging')}
          tabIndex={-1}
          aria-label="Workflow canvas"
          role="region"
          onKeyDown={onKeyDown}
          onClick={(event) => {
            // React bubbles clicks from portaled popovers (block picker) through here; only real canvas clicks clear.
            if (!scrollRef.current?.contains(event.target as Node) || justDragged()) return;
            select(null);
          }}
        >
          <div className={cx('wf-stage', model.entries.length === 0 && 'wf-stage--center')}>
            <div
              ref={contentRef}
              className={cx('wf-river', stale && 'wf-river--stale')}
              style={{ zoom }}
              inert={stale || undefined}
            >
              {workflow ? (
                <River />
              ) : stale ? (
                <EmptyState title="Nothing to show yet">
                  Fix the YAML error above to see the workflow here.
                </EmptyState>
              ) : null}
            </div>
          </div>
        </div>
        <ZoomControl zoom={zoom} onZoom={setZoom} onFit={fit} />
      </div>
    </CanvasDataProvider>
  );
}
