import { type CSSProperties, useLayoutEffect, useRef } from 'react';
import { AgentStone, Spinner } from '../../components';
import { groupTurns, metaParts, STOPPED_META, type TranscriptEntry } from './transcript';

interface AgentIdentity {
  agentId: string;
  agentName: string;
}

function Meta({ meta }: { meta: string }) {
  if (meta === STOPPED_META) {
    return (
      <div className="ag-meta">
        <i className="codicon codicon-debug-stop ag-small-icon" aria-hidden="true" />
        <span>Stopped</span>
      </div>
    );
  }
  return (
    <div className="ag-meta">
      {metaParts(meta).map((part, index) => (
        <span key={index} className={part.includes('/') ? 'ag-meta__model' : 'ag-meta__part'}>
          {part}
        </span>
      ))}
    </div>
  );
}

function ToolRow({ entry, pending }: { entry: TranscriptEntry; pending: boolean }) {
  const failed = entry.role === 'error';
  const title = [entry.tool, entry.text, entry.meta].filter(Boolean).join(' ');
  return (
    <div className={failed ? 'ag-tool-row ag-tool-row--failed' : 'ag-tool-row'} title={title}>
      {pending ? (
        <Spinner label={`Running ${entry.tool}`} />
      ) : (
        <i className={`codicon codicon-${failed ? 'error' : 'tools'} ag-tool-row__icon`} aria-hidden="true" />
      )}
      <span className="ag-tool-row__call">
        <span className="ag-tool-row__name">{entry.tool}</span>
        {entry.text ? <span className="ag-tool-row__detail">{entry.text}</span> : null}
      </span>
      {entry.meta ? <span className="ag-tool-row__result">{entry.meta}</span> : null}
    </div>
  );
}

/** JSON answers (common for workflow agents) read better in the code font. */
function looksLikeJson(text: string): boolean {
  return /^\s*[[{]/.test(text);
}

/**
 * Code answers keep their indentation when a long line wraps: each line hangs at its own indent plus two
 * columns. The leading spaces stay in the text, so copying gives back the original.
 */
function CodeLines({ text, caret }: { text: string; caret: boolean }) {
  const lines = text.split('\n');
  return lines.map((line, index) => {
    const indent = (line.match(/^[ \t]*/)?.[0] ?? '').replace(/\t/g, '  ').length;
    return (
      <span key={index} className="ag-code-line" style={{ '--ag-hang': `${indent + 2}ch` } as CSSProperties}>
        {line || '​'}
        {caret && index === lines.length - 1 ? <span className="ag-caret" aria-hidden="true" /> : null}
      </span>
    );
  });
}

function Entry({ entry, live }: { entry: TranscriptEntry; live: boolean }) {
  if (entry.tool !== undefined && (entry.role === 'tool' || entry.role === 'error')) {
    return <ToolRow entry={entry} pending={live && entry.meta === undefined} />;
  }
  if (entry.role === 'error') {
    return (
      <div className="ag-error" role="alert">
        <i className="codicon codicon-error ag-error__icon" aria-hidden="true" />
        <span className="ag-error__text">{entry.text}</span>
      </div>
    );
  }
  const open = live && entry.meta === undefined;
  return (
    <>
      {entry.text || open ? (
        looksLikeJson(entry.text) ? (
          <div className="ag-answer ag-answer--code">
            <CodeLines text={entry.text} caret={open} />
          </div>
        ) : (
          <div className="ag-answer">
            {entry.text}
            {open ? <span className="ag-caret" aria-hidden="true" /> : null}
          </div>
        )
      ) : null}
      {entry.meta ? <Meta meta={entry.meta} /> : null}
    </>
  );
}

function AgentTurn({
  entries,
  live,
  agentId,
  agentName,
}: { entries: TranscriptEntry[]; live: boolean } & AgentIdentity) {
  const last = entries[entries.length - 1];
  const busy = last && (last.role === 'agent' || (last.tool !== undefined && last.meta === undefined));
  return (
    <div className="ag-turn">
      <div className="ag-turn__gutter" aria-hidden="true">
        <AgentStone id={agentId} name={agentName} size="s" />
        <span className={live ? 'ag-turn__stream ag-turn__stream--live' : 'ag-turn__stream'} />
      </div>
      <div className="ag-turn__body">
        <div className="ag-turn__name">{agentName}</div>
        {entries.map((entry, index) => (
          <Entry key={index} entry={entry} live={live && index === entries.length - 1} />
        ))}
        {live && !busy ? (
          <div className="ag-waiting">
            <span>Waiting for the model</span>
            <span className="ag-caret" aria-hidden="true" />
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Scrolls to the newest message unless the reader scrolled up to look at older ones. */
function useStickToBottom<T>(dependency: T) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [dependency]);
  const onScroll = () => {
    const el = ref.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };
  return { ref, onScroll };
}

export function TranscriptView({
  entries,
  streaming,
  agentId,
  agentName,
}: { entries: TranscriptEntry[]; streaming: boolean } & AgentIdentity) {
  const scroll = useStickToBottom(entries);
  const turns = groupTurns(entries);
  const lastTurn = turns[turns.length - 1];

  return (
    <div
      ref={scroll.ref}
      className="ag-transcript"
      role="log"
      aria-label="Conversation"
      aria-busy={streaming}
      onScroll={scroll.onScroll}
    >
      {turns.map((turn) =>
        turn.kind === 'user' ? (
          <div key={turn.start} className="ag-user">
            <div className="ag-user__bubble">{turn.entries[0].text}</div>
          </div>
        ) : (
          <AgentTurn
            key={turn.start}
            entries={turn.entries}
            live={streaming && turn === lastTurn}
            agentId={agentId}
            agentName={agentName}
          />
        ),
      )}
      {streaming && lastTurn?.kind !== 'agent' ? (
        <AgentTurn entries={[]} live agentId={agentId} agentName={agentName} />
      ) : null}
    </div>
  );
}
