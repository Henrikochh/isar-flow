import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { SidebarApp } from '../../src/views/sidebar/SidebarApp';
import { makeState, posted, postedOfType, renderSidebar, resetPosted, sendState } from './helpers';

beforeEach(resetPosted);

describe('SidebarApp', () => {
  it('posts ready once on mount and waits for the host state', () => {
    render(<SidebarApp />);
    expect(posted()).toEqual([{ type: 'ready' }]);
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    expect(screen.queryByText('No agents yet')).not.toBeInTheDocument();
  });

  it('shows the tabs with counts and the agents panel', () => {
    renderSidebar();
    const tabs = screen.getByRole('tablist');
    const agentsTab = within(tabs).getByRole('tab', { name: /Agents/ });
    expect(agentsTab).toHaveAttribute('aria-selected', 'true');
    expect(agentsTab).toHaveTextContent('3');
    expect(within(tabs).getByRole('tab', { name: /Workflows/ })).toHaveTextContent('3');
    expect(screen.getByRole('heading', { name: 'Agents' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Models' })).toBeInTheDocument();
  });

  it('switches tabs locally, tells the host, and ignores a stale echo of the old tab', async () => {
    const user = userEvent.setup();
    renderSidebar();
    await user.click(screen.getByRole('tab', { name: /Workflows/ }));
    expect(postedOfType('setTab')).toEqual([{ type: 'setTab', tab: 'workflows' }]);
    expect(screen.getByRole('heading', { name: 'Workflows' })).toBeInTheDocument();

    sendState(makeState({ tab: 'agents' }));
    expect(screen.getByRole('heading', { name: 'Workflows' })).toBeInTheDocument();
  });

  it('follows a tab change that comes from the host', () => {
    renderSidebar();
    sendState(makeState({ tab: 'workflows' }));
    expect(screen.getByRole('tab', { name: /Workflows/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('heading', { name: 'Recent runs' })).toBeInTheDocument();
  });

  it('supports arrow keys between tabs', async () => {
    const user = userEvent.setup();
    renderSidebar();
    screen.getByRole('tab', { name: /Agents/ }).focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: /Workflows/ })).toHaveFocus();
    expect(postedOfType('setTab')).toEqual([{ type: 'setTab', tab: 'workflows' }]);
  });

  it('asks for a folder when no workspace is open', () => {
    renderSidebar({ hasWorkspace: false });
    expect(screen.getByText('Open a folder to use Isar Flow')).toBeInTheDocument();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('shows the restricted-mode banner and disables running', () => {
    renderSidebar({ trusted: false, tab: 'workflows' });
    expect(screen.getByRole('status')).toHaveTextContent('Running is disabled until you trust this workspace.');
    expect(screen.getByRole('button', { name: 'Run Review until approved' })).toBeDisabled();
  });

  it('survives a host state with missing lists', () => {
    render(<SidebarApp />);
    const partial = { ...makeState(), agents: undefined, workflows: undefined, recentRuns: undefined } as unknown as ReturnType<typeof makeState>;
    sendState(partial);
    expect(screen.getByText('No agents yet')).toBeInTheDocument();
  });
});
