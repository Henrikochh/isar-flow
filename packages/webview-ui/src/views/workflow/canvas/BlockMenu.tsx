/** Context menu of a block on the canvas (right-click, or Shift+F10 on the focused card). */
import { type RefObject, useEffect, useRef, useState } from 'react';
import type { InsertTarget, Workflow } from '@isar-flow/core';
import { Menu, MenuItem, MenuSeparator, Popover } from '../../../components';
import type { RunFromHereState } from '../runFromHere/model';
import { MoveToMenu } from './MoveToMenu';

export interface BlockMenuActions {
  move(stepId: string, target: InsertTarget): void;
  duplicate(stepId: string): void;
  remove(stepId: string): void;
  openYaml(stepId: string): void;
  /** Run from here: continue the shown run at the block (see runFromHereState). */
  runFromHere?(stepId: string): void;
  runFromHereState?(stepId: string): RunFromHereState;
}

export interface BlockMenuRequest {
  stepId: string;
  /** Changes on every opening, so the menu starts again at its actions. */
  seq: number;
}

const icon = (name: string) => <i className={`codicon codicon-${name}`} aria-hidden="true" />;

function BlockMenuContent({
  stepId,
  workflow,
  actions,
  onClose,
}: {
  stepId: string;
  workflow: Workflow | null | undefined;
  actions: BlockMenuActions;
  onClose: () => void;
}) {
  const [view, setView] = useState<'actions' | 'move'>('actions');
  const ref = useRef<HTMLDivElement>(null);

  // The item that was chosen is gone; focus the first target (or the first item when all are disabled).
  useEffect(() => {
    if (view !== 'move') return;
    const items = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    (items.find((item) => item.getAttribute('aria-disabled') !== 'true') ?? items[0])?.focus();
  }, [view]);

  const resume = actions.runFromHere ? (actions.runFromHereState?.(stepId) ?? { ok: true }) : null;

  const run = (action: (id: string) => void) => () => {
    onClose();
    action(stepId);
  };

  return (
    <div ref={ref}>
      {view === 'move' ? (
        <MoveToMenu
          workflow={workflow}
          stepId={stepId}
          onMove={(target) => {
            onClose();
            actions.move(stepId, target);
          }}
        />
      ) : (
        <Menu label="Block actions">
          {resume ? (
            <>
              <MenuItem
                leading={icon('run-below')}
                disabled={!resume.ok}
                description={resume.ok ? undefined : resume.reason}
                wrap={!resume.ok}
                onSelect={run((id) => actions.runFromHere?.(id))}
              >
                Run from here
              </MenuItem>
              <MenuSeparator />
            </>
          ) : null}
          <MenuItem leading={icon('move')} onSelect={() => setView('move')}>
            Move to…
          </MenuItem>
          <MenuItem leading={icon('copy')} onSelect={run(actions.duplicate)}>
            Duplicate
          </MenuItem>
          <MenuItem leading={icon('go-to-file')} onSelect={run(actions.openYaml)}>
            Show in YAML
          </MenuItem>
          <MenuSeparator />
          <MenuItem leading={icon('trash')} onSelect={run(actions.remove)}>
            Delete
          </MenuItem>
        </Menu>
      )}
    </div>
  );
}

export function BlockMenu({
  request,
  anchorRef,
  workflow,
  actions,
  onClose,
}: {
  request: BlockMenuRequest | null;
  anchorRef: RefObject<HTMLElement | null>;
  workflow: Workflow | null | undefined;
  actions: BlockMenuActions;
  onClose: () => void;
}) {
  return (
    <Popover
      open={request !== null}
      anchorRef={anchorRef}
      onClose={onClose}
      label="Block actions"
      role="none"
      width={264}
    >
      {request ? (
        <BlockMenuContent
          key={request.seq}
          stepId={request.stepId}
          workflow={workflow}
          actions={actions}
          onClose={onClose}
        />
      ) : null}
    </Popover>
  );
}
