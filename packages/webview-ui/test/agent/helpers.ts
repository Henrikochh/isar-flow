import { act } from '@testing-library/react';
import { parseAgentText, type AgentDocumentState, type HostToAgentEditor } from '@isar-flow/core';

export { CATALOG, REVIEWER_AGENT_TEXT } from '../../harness/fixtures';

/** Messages the webview posted (recorded by src/vscode.ts when acquireVsCodeApi is missing). */
export function posted(): { type: string; [key: string]: unknown }[] {
  const w = window as unknown as { __posted?: { type: string }[] };
  return (w.__posted ??= []) as { type: string; [key: string]: unknown }[];
}

export function clearPosted(): void {
  posted().length = 0;
}

export function postedOfType(type: string) {
  return posted().filter((message) => message.type === type);
}

/** Delivers a host message to the webview synchronously. */
export function fromHost(message: HostToAgentEditor): void {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: message }));
  });
}

export function agentDoc(text: string, overrides: Partial<AgentDocumentState> = {}): AgentDocumentState {
  const parsed = parseAgentText(text);
  return {
    uri: 'file:///work/.isarflow/agents/reviewer.agent.yaml',
    id: 'reviewer',
    scope: 'workspace',
    fileName: 'reviewer.agent.yaml',
    text,
    agent: parsed.agent,
    valid: parsed.valid,
    diagnostics: parsed.diagnostics,
    usedBy: ['.isarflow/workflows/review-loop.workflow.yaml'],
    ...overrides,
  };
}
