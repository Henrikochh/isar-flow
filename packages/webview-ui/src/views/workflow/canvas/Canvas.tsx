/** The river canvas: scrolls both ways, zooms, and renders the workflow as one stream from Start to End. */
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button, EmptyState } from '../../../components';
import { useEditor } from '../editorContext';
import { runFromHereState } from '../runFromHere/model';
import { useWorkflowActions, useWorkflowState } from '../store';
import { BlockMenu, type BlockMenuActions, type BlockMenuRequest } from './BlockMenu';
import { CanvasDataProvider, useCanvas } from './canvasContext';
import { justDragged, useDragItem } from './dnd';
import { EndMarker, StartMarker } from './Markers';
import { ROOT_LIST } from './model';
import { dropEdit } from './ops';
import { cx } from '../cx';
import { RiverList, useSlot } from './River';
import { cardElement, useCanvasKeyboard } from './useCanvasKeyboard';
import { useCenterLine } from './useCenterLine';
import { useEdgeScroll } from './useEdgeScroll';
import { useFollowRun } from './useFollowRun';
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
  const { triggers } = useWorkflowState();
  const empty = model.root.entries.length === 0;
  return (
    <>
      <StartMarker workflow={workflow} run={run} triggers={triggers} />
      {empty ? <EmptyRiver /> : <RiverList list={model.root} owner={null} />}
      <EndMarker run={run} />
    </>
  );
}

/** State of the block menu: which block it is for and what it is anchored to (the pointer or the card). */
function useBlockMenu(scrollRef: RefObject<HTMLElement | null>) {
  const [request, setRequest] = useState<BlockMenuRequest | null>(null);
  const anchorRef = useRef<HTMLElement | null>(null);
  const pointRef = useRef<HTMLSpanElement>(null);
  const seq = useRef(0);

  const open = useCallback(
    (stepId: string, at?: { x: number; y: number }) => {
      const point = pointRef.current;
      if (at && point) {
        point.style.left = `${at.x}px`;
        point.style.top = `${at.y}px`;
        anchorRef.current = point;
      } else {
        anchorRef.current = cardElement(scrollRef.current, stepId);
      }
      seq.current += 1;
      setRequest({ stepId, seq: seq.current });
    },
    [scrollRef],
  );

  // Escape or a click elsewhere: the block keeps the focus, as after any other menu.
  const close = () => {
    if (request) cardElement(scrollRef.current, request.stepId)?.focus();
    setRequest(null);
  };

  const point = createPortal(
    <span ref={pointRef} className="wf-menu-point" aria-hidden="true" />,
    document.body,
  );
  return { request, anchorRef, open, close, point };
}

export function Canvas() {
  const { workflow, stale, model } = useEditor();
  const { selection, approvals, asks, run, trusted, doc } = useWorkflowState();
  const drag = useDragItem();
  const scrollRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const { zoom, setZoom, fit } = useZoom(scrollRef, contentRef);
  useCenterLine(scrollRef, stageRef);
  const menu = useBlockMenu(scrollRef);
  const { onKeyDown, blockActions } = useCanvasKeyboard(scrollRef, menu.open);
  useEdgeScroll(scrollRef, drag !== null);
  useFollowRun(scrollRef);
  const { select, requestResume } = useWorkflowActions();
  const docValid = doc?.valid ?? false;
  const menuActions = useMemo<BlockMenuActions>(
    () => ({
      ...blockActions,
      runFromHereState: (stepId) => runFromHereState(run, trusted, docValid, stepId),
      runFromHere: (stepId) => {
        if (run) requestResume(run.runId, stepId);
      },
    }),
    [blockActions, run, trusted, docValid, requestResume],
  );

  // Reveal the selected block (also when the host asks to focus one).
  useEffect(() => {
    if (selection)
      cardElement(scrollRef.current, selection)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [selection]);

  // A block waiting for an approval or an answer needs the user: bring it into view when the request arrives.
  const seenRequests = useRef(new Set<string>());
  useEffect(() => {
    for (const prompt of [...approvals, ...asks]) {
      if (seenRequests.current.has(prompt.requestId)) continue;
      seenRequests.current.add(prompt.requestId);
      cardElement(scrollRef.current, prompt.stepId)?.scrollIntoView({ block: 'center', inline: 'nearest' });
    }
  }, [approvals, asks]);

  return (
    <CanvasDataProvider openMenu={menu.open}>
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
          <div ref={stageRef} className={cx('wf-stage', model.entries.length === 0 && 'wf-stage--center')}>
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
        {menu.point}
        <BlockMenu
          request={menu.request}
          anchorRef={menu.anchorRef}
          workflow={workflow}
          actions={menuActions}
          onClose={menu.close}
        />
      </div>
    </CanvasDataProvider>
  );
}
