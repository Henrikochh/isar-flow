/**
 * Persisted UI state of the workflow editor shell (zoom, palette, remembered run inputs). Stored under its own
 * key and merged into the webview state, so other parts of the view (e.g. the inspector) keep theirs.
 */
import { getViewState, setViewState } from '../../vscode';

export interface EditorViewState {
  zoom?: number;
  paletteCollapsed?: boolean;
  /** Last run inputs per workflow URI. */
  runInputs?: Record<string, Record<string, unknown>>;
}

const KEY = 'workflowEditor';

function readAll(): Record<string, unknown> {
  const state = getViewState<unknown>();
  return typeof state === 'object' && state !== null && !Array.isArray(state)
    ? (state as Record<string, unknown>)
    : {};
}

export function readEditorState(): EditorViewState {
  const value = readAll()[KEY];
  return typeof value === 'object' && value !== null ? (value as EditorViewState) : {};
}

export function patchEditorState(patch: Partial<EditorViewState>): void {
  const all = readAll();
  setViewState({ ...all, [KEY]: { ...readEditorState(), ...patch } });
}
