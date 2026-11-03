import { type KeyboardEvent, type ReactNode, useId, useRef, useState } from 'react';
import { Button, type ButtonVariant, IconButton } from './Button';
import { Menu, MenuItem, MenuSeparator } from './Menu';
import { Popover } from './Popover';

export type SplitButtonItem =
  | {
      label: string;
      /** Codicon name. */
      icon?: string;
      description?: ReactNode;
      disabled?: boolean;
      onSelect: () => void;
    }
  | { separator: true };

export interface SplitButtonProps {
  /** Label of the primary action. */
  children: ReactNode;
  icon?: string;
  variant?: ButtonVariant;
  onClick: () => void;
  disabled?: boolean;
  /** Why the primary action is unavailable: tooltip and accessible description. */
  disabledReason?: string;
  /** Accessible name of the menu button, e.g. "More run options". */
  moreLabel: string;
  moreDisabled?: boolean;
  moreDisabledReason?: string;
  menuLabel: string;
  items: SplitButtonItem[];
}

/** A button with a primary action and a chevron that opens a menu of related actions. */
export function SplitButton({
  children,
  icon,
  variant = 'primary',
  onClick,
  disabled,
  disabledReason,
  moreLabel,
  moreDisabled,
  moreDisabledReason,
  menuLabel,
  items,
}: SplitButtonProps) {
  const [open, setOpen] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  const reasonId = useId();
  const moreReasonId = useId();
  const mainReason = disabled ? disabledReason : undefined;
  const moreReason = moreDisabled ? moreDisabledReason : undefined;

  const onMoreKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'ArrowDown') return;
    event.preventDefault();
    setOpen(true);
  };

  return (
    <span className="if-split">
      <span className="if-split__part" title={mainReason}>
        <Button
          variant={variant}
          icon={icon}
          className="if-split__main"
          disabled={disabled}
          aria-describedby={mainReason ? reasonId : undefined}
          onClick={onClick}
        >
          {children}
        </Button>
        {mainReason ? (
          <span id={reasonId} className="if-visually-hidden">
            {mainReason}
          </span>
        ) : null}
      </span>
      <span className="if-split__part" title={moreReason}>
        <IconButton
          ref={moreRef}
          icon="chevron-down"
          label={moreLabel}
          className={`if-split__more if-split__more--${variant}`}
          aria-haspopup="menu"
          aria-expanded={open}
          disabled={moreDisabled}
          aria-describedby={moreReason ? moreReasonId : undefined}
          onClick={() => setOpen((o) => !o)}
          onKeyDown={onMoreKey}
        />
        {moreReason ? (
          <span id={moreReasonId} className="if-visually-hidden">
            {moreReason}
          </span>
        ) : null}
      </span>
      <Popover
        open={open}
        anchorRef={moreRef}
        onClose={() => setOpen(false)}
        label={menuLabel}
        role="none"
        placement="bottom-end"
        width={260}
      >
        <Menu label={menuLabel}>
          {items.map((item, index) =>
            'separator' in item ? (
              <MenuSeparator key={index} />
            ) : (
              <MenuItem
                key={index}
                leading={
                  item.icon ? <i className={`codicon codicon-${item.icon}`} aria-hidden="true" /> : undefined
                }
                description={item.description}
                disabled={item.disabled}
                // The reason of a disabled item is worth reading in full.
                wrap={item.disabled === true && item.description !== undefined}
                onSelect={() => {
                  // Back on the menu button first, so a dialog the item opens returns the focus there.
                  moreRef.current?.focus();
                  setOpen(false);
                  item.onSelect();
                }}
              >
                {item.label}
              </MenuItem>
            ),
          )}
        </Menu>
      </Popover>
    </span>
  );
}
