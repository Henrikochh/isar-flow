import { useEffect, useRef, useState } from 'react';
import type { AgentSummary } from '@isar-flow/core';
import { AgentStone, Chip, IconButton } from '../../components';
import { ConfirmStrip } from './ConfirmStrip';
import { agentLabel, agentReach, fileBaseName, plural, send } from './model';

export function AgentRow({ agent }: { agent: AgentSummary }) {
  const [confirming, setConfirming] = useState(false);
  const deleteRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  const label = agentLabel(agent);
  const model = typeof agent.model === 'string' ? agent.model.trim() : '';
  const reach = agentReach(agent);
  const uri = typeof agent.uri === 'string' ? agent.uri : '';

  useEffect(() => {
    if (!confirming && returnFocus.current) {
      returnFocus.current = false;
      deleteRef.current?.focus();
    }
  }, [confirming]);

  const open = () => {
    if (uri) send({ type: 'openAgent', uri });
  };

  if (confirming) {
    return (
      <ConfirmStrip
        title={`Delete ${label}?`}
        confirmLabel="Delete agent"
        onConfirm={() => {
          setConfirming(false);
          send({ type: 'deleteAgent', uri });
        }}
        onCancel={() => {
          returnFocus.current = true;
          setConfirming(false);
        }}
      >
        This deletes <span className="sb-code">{fileBaseName(uri) || 'the agent file'}</span>. Workflows that use it
        stop working until you pick another agent.
      </ConfirmStrip>
    );
  }

  return (
    <div className={agent.shadowed ? 'sb-row sb-row--dimmed' : 'sb-row'}>
      <button type="button" className="sb-row__main" onClick={open} title={agent.description || undefined}>
        <AgentStone id={agent.id || label} name={label} />
        <span className="sb-row__body">
          <span className="sb-row__title">
            <span className="sb-row__name">{label}</span>
            {agent.valid === false ? (
              <i className="codicon codicon-warning sb-warn" role="img" aria-label="Has problems" title="This agent file has problems. Open it to fix them." />
            ) : null}
          </span>
          {model ? <span className="sb-row__code">{model}</span> : <span className="sb-row__muted">No model set</span>}
          <span className="sb-row__chips">
            <Chip icon="tools" title={reach.tools ? undefined : 'This agent only answers; it cannot read or change files.'}>
              {reach.tools ? plural(reach.tools, 'tool') : 'No tools'}
            </Chip>
            {reach.edits ? (
              <Chip tone="outline" icon="edit" title="Has tools that change files">
                Edits files
              </Chip>
            ) : null}
            {reach.commands ? (
              <Chip tone="outline" icon="terminal" title="Has a tool that runs shell commands">
                Runs commands
              </Chip>
            ) : null}
            {agent.scope === 'user' ? (
              <Chip icon="account" title="User agent: available in all your workspaces">
                User
              </Chip>
            ) : null}
            {agent.shadowed ? (
              <Chip tone="warning" icon="eye-closed" title="A workspace agent with the same id is used instead">
                Hidden
              </Chip>
            ) : null}
          </span>
        </span>
      </button>
      <div className="sb-row__overlay">
        <IconButton icon="go-to-file" label={`Open ${label}`} onClick={open} />
        <IconButton ref={deleteRef} icon="trash" label={`Delete ${label}`} onClick={() => setConfirming(true)} disabled={!uri} />
      </div>
    </div>
  );
}
