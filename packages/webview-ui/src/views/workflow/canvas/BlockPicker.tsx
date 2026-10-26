import type { RefObject } from 'react';
import { STEP_TYPE_INFO, STEP_TYPES, type StepType } from '@isar-flow/core';
import { Menu, MenuItem, Popover, Stone } from '../../../components';

/** Compact list of block types, opened from an insertion point on the river. */
export function BlockPicker({
  open,
  anchorRef,
  onClose,
  onPick,
  insideLoop,
}: {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  onPick: (type: StepType) => void;
  /** Break is only offered inside a loop. */
  insideLoop: boolean;
}) {
  return (
    <Popover
      open={open}
      anchorRef={anchorRef}
      onClose={onClose}
      label="Add block"
      role="none"
      placement="bottom"
      width={268}
    >
      <Menu label="Add block">
        {STEP_TYPES.map((type) => {
          const info = STEP_TYPE_INFO[type];
          const blocked = type === 'break' && !insideLoop;
          return (
            <MenuItem
              key={type}
              leading={<Stone type={type} size="s" />}
              description={blocked ? 'Only inside a loop' : info.description}
              disabled={blocked}
              onSelect={() => {
                onClose();
                onPick(type);
              }}
            >
              {info.label}
            </MenuItem>
          );
        })}
      </Menu>
    </Popover>
  );
}
