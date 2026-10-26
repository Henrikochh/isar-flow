import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Button, Dialog } from '../../src/components';

function renderDialog(onClose = vi.fn()) {
  render(
    <>
      <button type="button">Behind the dialog</button>
      <Dialog title="Run Nightly" onClose={onClose} footer={<Button>Run workflow</Button>}>
        <input aria-label="task" />
      </Dialog>
    </>,
  );
  return onClose;
}

describe('Dialog', () => {
  it('is named by its title and starts with the focus on its first field', () => {
    renderDialog();
    expect(screen.getByRole('dialog', { name: 'Run Nightly' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'task' })).toHaveFocus();
  });

  it('keeps Tab and Shift+Tab inside the dialog', async () => {
    const user = userEvent.setup();
    renderDialog();
    const dialog = screen.getByRole('dialog');
    for (let i = 0; i < 5; i++) {
      await user.tab();
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
    }
    for (let i = 0; i < 5; i++) {
      await user.tab({ shift: true });
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
    }
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    const onClose = renderDialog();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
  });
});
