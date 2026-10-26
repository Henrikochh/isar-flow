/** "Move to…": the lists a block can move to, for keyboard and screen reader users and long workflows. */
import { useMemo } from 'react';
import type { InsertTarget, Workflow } from '@isar-flow/core';
import { Menu, MenuItem, MenuLabel, Stone } from '../../../components';
import { blockTitle, buildCanvasModel } from './model';
import { type MoveTarget, moveTargets } from './moveTargets';

function describe(target: MoveTarget): string {
  if (!target.changes) return 'Already the last block here';
  if (!target.owner) return 'End of the workflow';
  if (target.list.info.slot === 'then') return 'End of Then';
  if (target.list.info.slot === 'else') return 'End of Else';
  return 'End of the loop';
}

function TargetStone({ target }: { target: MoveTarget }) {
  if (target.owner?.type) return <Stone type={target.owner.type} size="s" />;
  return (
    <span className="if-stone if-stone--s wf-stone-river" aria-hidden="true">
      <i className="codicon codicon-play" />
    </span>
  );
}

export function MoveToMenu({
  workflow,
  stepId,
  onMove,
}: {
  workflow: Workflow | null | undefined;
  stepId: string;
  onMove: (target: InsertTarget) => void;
}) {
  const model = useMemo(() => buildCanvasModel(workflow), [workflow]);
  const entry = model.byId.get(stepId);
  const targets = moveTargets(model, stepId);
  return (
    <Menu label="Move to">
      <MenuLabel>{entry ? `Move ${blockTitle(entry)} to` : 'Move to'}</MenuLabel>
      {targets.map((target) => (
        <MenuItem
          key={target.key}
          leading={<TargetStone target={target} />}
          description={describe(target)}
          disabled={!target.changes}
          onSelect={() => onMove(target.target)}
        >
          {target.owner ? blockTitle(target.owner) : 'Top level'}
        </MenuItem>
      ))}
    </Menu>
  );
}
