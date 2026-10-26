import { useCallback, useReducer } from 'react';
import {
  type AgentDefinition,
  type AgentDocumentState,
  applyAgentUpdate,
  parseAgentText,
} from '@isar-flow/core';
import { reconcilePending } from '../../optimistic';

interface DocumentState {
  host: AgentDocumentState | null;
  /** Texts the sent, unconfirmed updates produce, oldest first. */
  pending: string[];
  /** The host document with the unconfirmed updates applied. */
  shown: AgentDocumentState | null;
}

type DocumentAction =
  | { type: 'host'; doc: AgentDocumentState }
  | { type: 'local'; set: Partial<AgentDefinition>; unset?: string[] }
  | { type: 'failed' };

/** The agent file as the host would send it for `text` (without its model availability warnings). */
function documentFor(base: AgentDocumentState, text: string): AgentDocumentState {
  const parsed = parseAgentText(text);
  const valid = parsed.valid && !parsed.diagnostics.some((d) => d.severity === 'error');
  return { ...base, text, agent: parsed.agent, valid, diagnostics: parsed.diagnostics };
}

function reducer(state: DocumentState, action: DocumentAction): DocumentState {
  switch (action.type) {
    case 'host': {
      const pending = reconcilePending(state.pending, state.host?.text, action.doc.text);
      const latest = pending[pending.length - 1];
      return {
        host: action.doc,
        pending,
        shown: latest === undefined ? action.doc : documentFor(action.doc, latest),
      };
    }
    case 'local': {
      const current = state.shown;
      if (!current) return state;
      const result = applyAgentUpdate(current.text, action.set as Record<string, unknown>, action.unset);
      if (result.error !== undefined || result.text === current.text) return state;
      return { ...state, pending: [...state.pending, result.text], shown: documentFor(current, result.text) };
    }
    case 'failed':
      return { ...state, pending: [], shown: state.host };
  }
}

const EMPTY: DocumentState = { host: null, pending: [], shown: null };

/**
 * The agent document shown in the editor: the host's, with the updates it has not confirmed yet applied, so
 * quick changes build on each other (see optimistic.ts).
 */
export function useAgentDocument() {
  const [state, dispatch] = useReducer(reducer, EMPTY);
  const receive = useCallback((doc: AgentDocumentState) => dispatch({ type: 'host', doc }), []);
  const applyLocally = useCallback(
    (set: Partial<AgentDefinition>, unset?: string[]) => dispatch({ type: 'local', set, unset }),
    [],
  );
  const revert = useCallback(() => dispatch({ type: 'failed' }), []);
  return { doc: state.shown, receive, applyLocally, revert };
}
