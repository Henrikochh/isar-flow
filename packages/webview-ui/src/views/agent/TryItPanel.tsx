import { useRef, useState } from 'react';
import { AgentStone, Button, IconButton, TextArea } from '../../components';
import { TranscriptView } from './TranscriptView';
import type { TryIt } from './useTryIt';

const HINT = 'Uses the saved file. Tools that edit ask first.';

function Composer({
  streaming,
  disabledReason,
  onAsk,
  onStop,
}: {
  streaming: boolean;
  disabledReason?: string;
  onAsk: (prompt: string) => boolean;
  onStop: () => void;
}) {
  const [text, setText] = useState('');
  const canSend = text.trim() !== '' && !disabledReason;
  const submit = () => {
    if (!disabledReason && onAsk(text)) setText('');
  };
  return (
    <form
      className="ag-composer"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className={disabledReason ? 'ag-composer__box ag-composer__box--disabled' : 'ag-composer__box'}>
        <TextArea
          className="ag-composer__input"
          aria-label="Message to the agent"
          aria-describedby="ag-composer-hint"
          placeholder="Ask the agent…"
          autoGrow
          minRows={2}
          maxRows={8}
          value={text}
          disabled={Boolean(disabledReason)}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <div className="ag-composer__bar">
          <p className="ag-composer__hint" id="ag-composer-hint">
            {disabledReason ? (
              <span className="ag-composer__blocked">
                <i className="codicon codicon-warning ag-small-icon" aria-hidden="true" />
                {disabledReason}
              </span>
            ) : (
              HINT
            )}
          </p>
          {streaming ? (
            <Button variant="danger" size="s" icon="debug-stop" onClick={onStop}>
              Stop
            </Button>
          ) : (
            // The button takes the river color only once there is something to send.
            <Button
              type="submit"
              variant={canSend ? 'run' : 'secondary'}
              size="s"
              icon="send"
              title="Send (Enter). Shift+Enter adds a new line."
              disabled={!canSend}
            >
              Send
            </Button>
          )}
        </div>
      </div>
    </form>
  );
}

export function TryItPanel({
  tryIt,
  agentId,
  agentName,
  model,
  disabledReason,
}: {
  tryIt: TryIt;
  agentId: string;
  agentName: string;
  /** The model that will answer, as a display name and its reference. */
  model?: { name: string; ref: string };
  disabledReason?: string;
}) {
  const panelRef = useRef<HTMLElement>(null);
  const empty = tryIt.entries.length === 0 && !tryIt.streaming;
  return (
    <aside className="ag-tryit" aria-labelledby="ag-tryit-title" ref={panelRef}>
      <div className="ag-tryit__header">
        <h2 className="ag-tryit__title" id="ag-tryit-title">
          Try it
        </h2>
        {model ? (
          <span className="ag-tryit__model" title={`Answers come from ${model.ref}`}>
            <i className="codicon codicon-sparkle ag-tryit__model-icon" aria-hidden="true" />
            {model.name}
          </span>
        ) : null}
        <IconButton
          icon="clear-all"
          label="Clear conversation"
          disabled={tryIt.entries.length === 0}
          onClick={() => {
            tryIt.clear();
            panelRef.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus();
          }}
        />
      </div>
      {empty ? (
        <div className="ag-tryit__empty">
          <span className="ag-tryit__source" aria-hidden="true" />
          <AgentStone id={agentId} name={agentName} size="l" />
          <p className="ag-tryit__empty-text">Ask the agent something to see how it responds with the current settings.</p>
        </div>
      ) : (
        <TranscriptView entries={tryIt.entries} streaming={tryIt.streaming} agentId={agentId} agentName={agentName} />
      )}
      <Composer streaming={tryIt.streaming} disabledReason={disabledReason} onAsk={tryIt.ask} onStop={tryIt.stop} />
    </aside>
  );
}
