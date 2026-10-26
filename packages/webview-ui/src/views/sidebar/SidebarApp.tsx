import './sidebar.css';
import { useEffect, useRef, useState } from 'react';
import type { HostToSidebar, SidebarState, SidebarTab } from '@isar-flow/core';
import { Banner, EmptyState, SegmentedControl } from '../../components';
import { useHostMessages } from '../../vscode';
import { AgentsPanel } from './AgentsPanel';
import { RiverArt } from './RiverArt';
import { WorkflowsPanel } from './WorkflowsPanel';
import { send } from './model';
import { useSidebarViewState } from './viewState';

const EMPTY_CATALOG: SidebarState['catalog'] = { models: [], providers: [], loading: false };

/** Fills in lists a host might leave out, so rendering never has to guard against them. */
function normalize(state: SidebarState): SidebarState {
  return {
    ...state,
    agents: Array.isArray(state.agents) ? state.agents : [],
    workflows: Array.isArray(state.workflows) ? state.workflows : [],
    recentRuns: Array.isArray(state.recentRuns) ? state.recentRuns : [],
    activeRuns: Array.isArray(state.activeRuns) ? state.activeRuns : [],
    catalog: state.catalog ?? EMPTY_CATALOG,
    tab: state.tab === 'workflows' ? 'workflows' : 'agents',
  };
}

export function SidebarApp() {
  const [state, setState] = useState<SidebarState | null>(null);
  const [tab, setTab] = useState<SidebarTab>('agents');
  const hostTab = useRef<SidebarTab | null>(null);
  const [raised, setRaised] = useState(false);
  const view = useSidebarViewState();

  useHostMessages<HostToSidebar>((message) => {
    if (message.type !== 'state' || !message.state) return;
    const next = normalize(message.state);
    setState(next);
    // Follow the host's tab only when the host changed it, so a stale echo never undoes a click.
    if (next.tab !== hostTab.current) {
      hostTab.current = next.tab;
      setTab(next.tab);
    }
  });

  useEffect(() => {
    send({ type: 'ready' });
  }, []);

  if (!state) return <div className="sb-app" aria-busy="true" />;

  if (!state.hasWorkspace) {
    return (
      <div className="sb-app">
        <div className="sb-center">
          <EmptyState art={<RiverArt variant="folder" />} title="Open a folder to use Isar Flow">
            Agents and workflows are saved in the <span className="sb-code">.isarflow</span> folder of your workspace.
          </EmptyState>
        </div>
      </div>
    );
  }

  const selectTab = (next: SidebarTab) => {
    setTab(next);
    send({ type: 'setTab', tab: next });
  };

  return (
    <div className="sb-app" onScroll={(event) => setRaised(event.currentTarget.scrollTop > 2)}>
      <div className={raised ? 'sb-tabs sb-tabs--raised' : 'sb-tabs'}>
        <SegmentedControl<SidebarTab>
          role="tablist"
          label="Isar Flow"
          full
          value={tab}
          onChange={selectTab}
          options={[
            { value: 'agents', label: 'Agents', count: state.agents.length },
            { value: 'workflows', label: 'Workflows', count: state.workflows.length },
          ]}
        />
      </div>
      <div className="sb-body" role="tabpanel" aria-label={tab === 'agents' ? 'Agents' : 'Workflows'}>
        {state.trusted ? null : <Banner tone="warning">Running is disabled until you trust this workspace.</Banner>}
        {tab === 'agents' ? (
          <AgentsPanel agents={state.agents} catalog={state.catalog} draft={view.agentDraft} onDraftChange={view.setAgentDraft} />
        ) : (
          <WorkflowsPanel state={state} draft={view.workflowDraft} onDraftChange={view.setWorkflowDraft} />
        )}
      </div>
    </div>
  );
}
