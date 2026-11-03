import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useRef, useState } from 'react';
import { describe, expect, it } from 'vitest';
import { Menu, MenuItem, Popover } from '../../src/components';

function Harness({ fields = 0 }: { fields?: number }) {
  const [open, setOpen] = useState(true);
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={anchor} type="button" onClick={() => setOpen((o) => !o)}>
        Runs
      </button>
      <button type="button">Open YAML</button>
      <Popover
        open={open}
        anchorRef={anchor}
        onClose={() => setOpen(false)}
        label="Runs"
        role={fields ? 'dialog' : 'none'}
      >
        {Array.from({ length: fields }, (_, i) => (
          <input key={i} aria-label={`Field ${i + 1}`} />
        ))}
        <Menu label="Runs">
          <MenuItem onSelect={() => undefined}>Live run</MenuItem>
          <MenuItem onSelect={() => undefined}>2 h ago</MenuItem>
        </Menu>
      </Popover>
    </>
  );
}

const anchor = () => screen.getByRole('button', { name: 'Runs' });

describe('Popover', () => {
  it('closes on Tab and hands the focus back to its anchor, so the tab order continues from there', () => {
    render(<Harness />);
    const item = screen.getByRole('menuitem', { name: 'Live run' });
    item.focus();
    fireEvent.keyDown(item, { key: 'Tab' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(anchor()).toHaveFocus();
  });

  it('lets Tab move between its own fields and closes when it leaves them', () => {
    render(<Harness fields={2} />);
    const [first, second] = screen.getAllByRole('textbox');
    first.focus();
    fireEvent.keyDown(first, { key: 'Tab' });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    second.focus();
    fireEvent.keyDown(second, { key: 'Tab', shiftKey: true });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.keyDown(second, { key: 'Tab' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(anchor()).toHaveFocus();
  });

  it('closes on Shift+Tab from its first field', () => {
    render(<Harness fields={2} />);
    const [first] = screen.getAllByRole('textbox');
    first.focus();
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(anchor()).toHaveFocus();
  });

  it('closes on Escape and returns the focus to its anchor', () => {
    render(<Harness />);
    const item = screen.getByRole('menuitem', { name: '2 h ago' });
    item.focus();
    fireEvent.keyDown(item, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(anchor()).toHaveFocus();
  });
});

describe('Popover focus on open', () => {
  it('skips items that are disabled with aria-disabled', async () => {
    function Disabled() {
      const anchor = useRef<HTMLButtonElement>(null);
      return (
        <>
          <button ref={anchor} type="button">
            Actions
          </button>
          <Popover open anchorRef={anchor} onClose={() => undefined} label="Actions" role="none">
            <Menu label="Actions">
              <MenuItem disabled onSelect={() => undefined}>
                Run from here
              </MenuItem>
              <MenuItem onSelect={() => undefined}>Move to…</MenuItem>
            </Menu>
          </Popover>
        </>
      );
    }
    render(<Disabled />);
    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Move to…' })).toHaveFocus());
  });
});
