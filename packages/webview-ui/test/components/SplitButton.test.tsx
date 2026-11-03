import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SplitButton, type SplitButtonItem } from '../../src/components';

function renderSplit(
  props: Partial<Parameters<typeof SplitButton>[0]> = {},
  items: SplitButtonItem[] = [
    { label: 'Run', icon: 'play', onSelect: vi.fn() },
    { label: 'Simulate', icon: 'beaker', description: 'Use mocks; nothing runs', onSelect: vi.fn() },
    { separator: true },
    { label: 'Edit simulation mocks', icon: 'go-to-file', onSelect: vi.fn() },
  ],
) {
  const onClick = vi.fn();
  render(
    <SplitButton
      variant="run"
      icon="play"
      onClick={onClick}
      moreLabel="More run options"
      menuLabel="Run options"
      items={items}
      {...props}
    >
      Run
    </SplitButton>,
  );
  const more = screen.getByRole('button', { name: 'More run options' });
  return { onClick, items, more, primary: screen.getByRole('button', { name: 'Run' }) };
}

describe('SplitButton', () => {
  it('runs the primary action and names the menu button', () => {
    const { onClick, primary, more } = renderSplit();
    fireEvent.click(primary);
    expect(onClick).toHaveBeenCalledOnce();
    expect(primary.querySelector('.codicon-play')).not.toBeNull();
    expect(more).toHaveAttribute('aria-haspopup', 'menu');
    expect(more).toHaveAttribute('aria-expanded', 'false');
  });

  it('opens the menu with its items, descriptions and a separator', () => {
    const { more } = renderSplit();
    fireEvent.click(more);
    expect(more).toHaveAttribute('aria-expanded', 'true');
    const menu = screen.getByRole('menu', { name: 'Run options' });
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((i) => i.textContent),
    ).toEqual(['Run', 'SimulateUse mocks; nothing runs', 'Edit simulation mocks']);
    expect(within(menu).getByRole('separator')).toBeInTheDocument();
  });

  it('closes the menu, keeps the focus on the menu button and runs the item', () => {
    const { more, items } = renderSplit();
    fireEvent.click(more);
    fireEvent.click(screen.getByRole('menuitem', { name: /Simulate/ }));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect((items[1] as { onSelect: () => void }).onSelect).toHaveBeenCalledOnce();
    expect(more).toHaveFocus();
  });

  it('opens with ArrowDown, focuses the first item, and Escape returns to the menu button', async () => {
    const { more } = renderSplit();
    more.focus();
    fireEvent.keyDown(more, { key: 'ArrowDown' });
    const menu = screen.getByRole('menu', { name: 'Run options' });
    await waitFor(() => expect(within(menu).getAllByRole('menuitem')[0]).toHaveFocus());
    fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(more).toHaveFocus();
  });

  it('disables the primary action with a reason and keeps the menu usable', () => {
    const { primary, more } = renderSplit({ disabled: true, disabledReason: 'Fix the YAML first.' });
    expect(primary).toBeDisabled();
    expect(primary).toHaveAccessibleDescription('Fix the YAML first.');
    expect(more).toBeEnabled();
  });

  it('disables the menu button with its own reason', () => {
    const { more } = renderSplit({ moreDisabled: true, moreDisabledReason: 'Add a block first.' });
    expect(more).toBeDisabled();
    expect(more).toHaveAccessibleDescription('Add a block first.');
  });

  it('does not run disabled items', () => {
    const onSelect = vi.fn();
    const { more } = renderSplit({}, [
      { label: 'Run', icon: 'play', disabled: true, description: 'No trust', onSelect },
    ]);
    fireEvent.click(more);
    fireEvent.click(screen.getByRole('menuitem', { name: /Run/ }));
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });
});

describe('SplitButton items', () => {
  it('lets the reason of a disabled item wrap', () => {
    const { more } = renderSplit({}, [
      {
        label: 'Run',
        disabled: true,
        description: 'Running is disabled until you trust this workspace.',
        onSelect: vi.fn(),
      },
      { label: 'Simulate', description: 'Use mocks; nothing runs', onSelect: vi.fn() },
    ]);
    fireEvent.click(more);
    const [run, simulate] = screen.getAllByRole('menuitem');
    expect(run).toHaveClass('if-menu__item--wrap');
    expect(simulate).not.toHaveClass('if-menu__item--wrap');
  });
});
