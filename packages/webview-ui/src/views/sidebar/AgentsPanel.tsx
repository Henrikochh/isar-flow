import { useRef } from 'react';
import type { AgentSummary, MemoryFileState, ModelCatalog } from '@isar-flow/core';
import { Button, EmptyState, Section } from '../../components';
import { AgentRow } from './AgentRow';
import { MemoryRows } from './MemoryRows';
import { ModelsSection } from './ModelsSection';
import { NewAgentCard } from './NewAgentCard';
import { RiverArt } from './RiverArt';
import { send, uniqueKeys } from './model';
import { NEW_AGENT_DRAFT, type AgentDraft } from './viewState';

export function AgentsPanel({
  agents,
  catalog,
  memory = [],
  draft,
  onDraftChange,
}: {
  agents: readonly AgentSummary[];
  catalog: ModelCatalog;
  /** `.isarflow/memory.md` of each workspace folder, which the agents read. */
  memory?: MemoryFileState[];
  draft: AgentDraft | undefined;
  onDraftChange: (draft: AgentDraft | undefined) => void;
}) {
  const newRef = useRef<HTMLButtonElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const keys = uniqueKeys(agents, (agent) => agent.uri || agent.id);

  const open = () => (draft ? nameRef.current?.focus() : onDraftChange(NEW_AGENT_DRAFT));
  const close = () => {
    onDraftChange(undefined);
    newRef.current?.focus();
  };

  return (
    <>
      <Section
        title="Agents"
        actions={
          <Button
            ref={newRef}
            size="s"
            icon="add"
            aria-label="New agent"
            aria-expanded={draft !== undefined}
            onClick={open}
          >
            New
          </Button>
        }
      >
        {draft ? (
          <NewAgentCard
            inputRef={nameRef}
            draft={draft}
            agents={agents}
            onChange={onDraftChange}
            onCancel={close}
            onCreate={({ name, scope, starter }) => {
              send({ type: 'createAgent', name, scope, starter });
              close();
            }}
          />
        ) : null}
        {agents.length > 0 ? (
          <ul className="sb-list" aria-label="Agents">
            {agents.map((agent, index) => (
              <li key={keys[index]}>
                <AgentRow agent={agent} />
              </li>
            ))}
          </ul>
        ) : draft ? null : (
          <EmptyState
            art={<RiverArt variant="agents" />}
            title="No agents yet"
            actions={
              <Button variant="primary" icon="add" onClick={open}>
                Create agent
              </Button>
            }
          >
            Agents are reusable AI helpers with a model, instructions and tools.
          </EmptyState>
        )}
        <MemoryRows memory={memory} />
      </Section>
      <ModelsSection catalog={catalog} />
    </>
  );
}
