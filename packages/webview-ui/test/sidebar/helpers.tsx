import { act, render } from '@testing-library/react';
import type { HostToSidebar, SidebarState } from '@isar-flow/core';
import { AGENTS, CATALOG, RECENT_RUNS, WORKFLOWS } from '../../harness/fixtures';
import { SidebarApp } from '../../src/views/sidebar/SidebarApp';

type PostedWindow = { __posted?: unknown[] };

export function resetPosted(): void {
  (window as unknown as PostedWindow).__posted = [];
}

/** Messages the webview sent to the host (recorded by src/vscode.ts when acquireVsCodeApi is missing). */
export function posted(): { type: string; [key: string]: unknown }[] {
  return ((window as unknown as PostedWindow).__posted ?? []) as { type: string }[];
}

export function postedOfType(type: string) {
  return posted().filter((message) => message.type === type);
}

export function makeState(overrides: Partial<SidebarState> = {}): SidebarState {
  return {
    hasWorkspace: true,
    trusted: true,
    agents: [...AGENTS],
    workflows: [...WORKFLOWS],
    catalog: CATALOG,
    recentRuns: [...RECENT_RUNS],
    activeRuns: [],
    tab: 'agents',
    ...overrides,
  };
}

export function sendState(state: SidebarState): void {
  const message: HostToSidebar = { type: 'state', state };
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: message }));
  });
}

/** Renders the sidebar and delivers one host state, like the host does after `ready`. */
export function renderSidebar(overrides: Partial<SidebarState> = {}) {
  const result = render(<SidebarApp />);
  sendState(makeState(overrides));
  return result;
}
