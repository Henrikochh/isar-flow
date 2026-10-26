/**
 * Typed bridge to the extension host. In the browser harness `acquireVsCodeApi` is provided by the mock host.
 */
import { useEffect, useRef } from 'react';

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare global {
  interface Window {
    acquireVsCodeApi?: () => VsCodeApi;
  }
}

let api: VsCodeApi | undefined;

function getApi(): VsCodeApi {
  if (!api) {
    api = window.acquireVsCodeApi
      ? window.acquireVsCodeApi()
      : {
          // Fallback for unit tests: record messages on window for assertions.
          postMessage: (message) => {
            const w = window as unknown as { __posted?: unknown[] };
            (w.__posted ??= []).push(message);
          },
          getState: () => undefined,
          setState: () => undefined,
        };
  }
  return api;
}

/** Posts a message to the extension host. */
export function post<T extends { type: string }>(message: T): void {
  getApi().postMessage(message);
}

/** Persisted per-webview UI state (selection, collapsed panels) that survives the view being hidden. */
export function getViewState<T>(): T | undefined {
  return getApi().getState() as T | undefined;
}

export function setViewState<T>(state: T): void {
  getApi().setState(state);
}

/** Subscribes to messages from the extension host for the lifetime of the component. */
export function useHostMessages<T extends { type: string }>(handler: (message: T) => void): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const listener = (event: MessageEvent) => {
      const data = event.data as T | undefined;
      if (data && typeof data === 'object' && typeof data.type === 'string') ref.current(data);
    };
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }, []);
}

/** The view this webview should render, set by the host as `<body data-view="…">`. */
export function currentView(): 'sidebar' | 'workflow' | 'agent' {
  const view = document.body.dataset.view;
  return view === 'workflow' || view === 'agent' ? view : 'sidebar';
}
