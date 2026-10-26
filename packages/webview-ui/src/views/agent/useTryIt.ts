import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentEditorToHost, TryItEvent } from '@isar-flow/core';
import { getViewState, post, setViewState } from '../../vscode';
import {
  applyTryItEvent,
  conversationHistory,
  readTranscript,
  stopTurn,
  type TranscriptEntry,
} from './transcript';

const send = (message: AgentEditorToHost) => post(message);

export interface TryIt {
  entries: TranscriptEntry[];
  streaming: boolean;
  /** Sends a prompt; returns false when nothing was sent (empty text or an answer is still streaming). */
  ask(prompt: string): boolean;
  stop(): void;
  clear(): void;
  handleEvent(event: TryItEvent): void;
}

/** Try it conversation state, persisted in the webview state so it survives the editor being hidden. */
export function useTryIt(): TryIt {
  const [entries, setEntries] = useState<TranscriptEntry[]>(() => readTranscript(getViewState()));
  const [streaming, setStreaming] = useState(false);
  // Events that arrive after Stop or Clear belong to an answer the user no longer wants.
  const accepting = useRef(false);
  const entriesRef = useRef(entries);
  entriesRef.current = entries;

  useEffect(() => {
    const previous = getViewState<Record<string, unknown>>() ?? {};
    setViewState({ ...previous, tryIt: { messages: entries } });
  }, [entries]);

  const handleEvent = useCallback((event: TryItEvent) => {
    if (!accepting.current) return;
    setEntries((current) => applyTryItEvent(current, event));
    if (event.type === 'done' || event.type === 'error') {
      accepting.current = false;
      setStreaming(false);
    }
  }, []);

  const ask = useCallback((prompt: string) => {
    const text = prompt.trim();
    if (!text || accepting.current) return false;
    send({ type: 'tryIt', prompt: text, history: conversationHistory(entriesRef.current) });
    accepting.current = true;
    setStreaming(true);
    setEntries((current) => [...current, { role: 'user', text }]);
    return true;
  }, []);

  const stop = useCallback(() => {
    if (!accepting.current) return;
    send({ type: 'cancelTryIt' });
    accepting.current = false;
    setStreaming(false);
    setEntries(stopTurn);
  }, []);

  const clear = useCallback(() => {
    if (accepting.current) send({ type: 'cancelTryIt' });
    accepting.current = false;
    setStreaming(false);
    setEntries([]);
  }, []);

  return { entries, streaming, ask, stop, clear, handleEvent };
}
