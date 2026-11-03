import { act, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TemplateText } from '../../../src/views/workflow/canvas/TemplateText';
import { fromHost, lastContext, renderLive, shownRun } from './helpers';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const FIX = 'Fix ${{ steps.tests.exitCode }} and ${{ env.HOME }} now';

function hover(token: HTMLElement, ms = 300) {
  fireEvent.mouseEnter(token);
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe('TemplateText live values', () => {
  it('shows nothing extra without a run', () => {
    renderLive(<TemplateText text={FIX} stepId="fix" />);
    const token = screen.getByText('steps.tests.exitCode');
    expect(token).toHaveClass('wf-expr');
    expect(token).not.toHaveClass('wf-expr-live');
    hover(token, 1000);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('shows the value of the last run after a short pause', () => {
    renderLive(<TemplateText text={FIX} stepId="fix" />);
    fromHost({ type: 'lastRunContext', context: lastContext() });
    const token = screen.getByText('steps.tests.exitCode');
    expect(token).toHaveClass('wf-expr-live');
    // Not focusable: the card stays the only tab stop.
    expect(token).not.toHaveAttribute('tabindex');

    hover(token, 299);
    expect(screen.queryByRole('tooltip')).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    const tip = screen.getByRole('tooltip');
    expect(tip).toHaveTextContent('Last run');
    expect(tip).toHaveTextContent('Number');
    expect(tip.querySelector('pre')?.textContent).toBe('1');
  });

  it('closes when the pointer leaves, but not while it moves onto the card', () => {
    renderLive(<TemplateText text={FIX} stepId="fix" />);
    fromHost({ type: 'lastRunContext', context: lastContext() });
    const token = screen.getByText('steps.tests.exitCode');
    hover(token);
    fireEvent.mouseLeave(token);
    fireEvent.mouseEnter(screen.getByRole('tooltip'));
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    fireEvent.mouseLeave(screen.getByRole('tooltip'));
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('does not open when the pointer passes over quickly', () => {
    renderLive(<TemplateText text={FIX} stepId="fix" />);
    fromHost({ type: 'lastRunContext', context: lastContext() });
    const token = screen.getByText('steps.tests.exitCode');
    hover(token, 200);
    fireEvent.mouseLeave(token);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('closes on Escape and on scroll', () => {
    renderLive(<TemplateText text={FIX} stepId="fix" />);
    fromHost({ type: 'lastRunContext', context: lastContext() });
    const token = screen.getByText('steps.tests.exitCode');
    hover(token);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();

    hover(token);
    // Scrolling the value inside the card keeps it open; scrolling the canvas closes it.
    fireEvent.scroll(screen.getByRole('tooltip'));
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    fireEvent.scroll(window);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('explains values a run does not keep', () => {
    renderLive(<TemplateText text={FIX} stepId="fix" />);
    fromHost({ type: 'lastRunContext', context: lastContext() });
    hover(screen.getByText('env.HOME'));
    expect(screen.getByRole('tooltip')).toHaveTextContent("Environment values aren't saved with runs.");
  });

  it('uses the shown run and names blocks it has not reached yet', () => {
    const run = shownRun({ status: 'running' });
    delete run.steps.tests;
    renderLive(<TemplateText text={FIX} stepId="fix" />, { run, runLive: true });
    hover(screen.getByText('steps.tests.exitCode'));
    const tip = screen.getByRole('tooltip');
    expect(tip).toHaveTextContent('This run');
    expect(tip).toHaveTextContent('tests has no result in this run.');
  });

  it('closes when the text changes under it', () => {
    const { rerender } = renderLive(<TemplateText text={FIX} stepId="fix" />);
    fromHost({ type: 'lastRunContext', context: lastContext() });
    hover(screen.getByText('steps.tests.exitCode'));
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    rerender(<TemplateText text="Fix ${{ steps.review.text }}" stepId="fix" />);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('keeps clicks inside the card from reaching the block under it', () => {
    const onClick = vi.fn();
    const onPointerDown = vi.fn();
    renderLive(
      <div onClick={onClick} onPointerDown={onPointerDown}>
        <TemplateText text={FIX} stepId="fix" />
      </div>,
    );
    fromHost({ type: 'lastRunContext', context: lastContext() });
    hover(screen.getByText('steps.tests.exitCode'));
    fireEvent.pointerDown(screen.getByRole('tooltip'));
    fireEvent.click(screen.getByRole('tooltip'));
    expect(onClick).not.toHaveBeenCalled();
    expect(onPointerDown).not.toHaveBeenCalled();
  });
});
