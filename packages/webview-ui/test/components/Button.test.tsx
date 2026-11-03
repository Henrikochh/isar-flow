import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Button } from '../../src/components';

describe('Button', () => {
  it('keeps the keyboard focus while it loads and ignores clicks until it is done', () => {
    const onClick = vi.fn();
    const { rerender } = render(<Button onClick={onClick}>Test model</Button>);
    const button = screen.getByRole('button', { name: 'Test model' });
    button.focus();

    rerender(
      <Button onClick={onClick} loading>
        Test model
      </Button>,
    );
    // A disabled button would lose the focus in the browser; this one only says it is unavailable.
    expect(button).not.toHaveAttribute('disabled');
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(document.activeElement).toBe(button);
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();

    rerender(<Button onClick={onClick}>Test model</Button>);
    expect(button).not.toHaveAttribute('aria-disabled');
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('ignores clicks while aria-disabled, so a busy button can keep the focus', () => {
    const onClick = vi.fn();
    render(
      <Button aria-disabled onClick={onClick}>
        Run again
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Run again' });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('is disabled for real when asked to', () => {
    render(<Button disabled>Run</Button>);
    expect(screen.getByRole('button', { name: 'Run' })).toBeDisabled();
  });
});
