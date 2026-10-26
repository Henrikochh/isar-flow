/** Shared helpers for the workflow editor shell and canvas tests. */
import { act, render } from '@testing-library/react';
import {
  parseWorkflowText,
  workflowTemplate,
  type HostToWorkflowEditor,
  type Workflow,
  type WorkflowDocumentState,
} from '@isar-flow/core';
import { vi } from 'vitest';
import { AGENTS, CATALOG } from '../../../harness/fixtures';
import { WorkflowApp } from '../../../src/views/workflow/WorkflowApp';

export const REVIEW_TEXT = workflowTemplate('review-loop', 'Review until approved');

export function docFor(text: string, overrides: Partial<WorkflowDocumentState> = {}): WorkflowDocumentState {
  const parsed = parseWorkflowText(text);
  return {
    uri: 'file:///work/review-loop.workflow.yaml',
    fileName: 'review-loop.workflow.yaml',
    text,
    workflow: parsed.workflow,
    valid: parsed.valid && !parsed.diagnostics.some((d) => d.severity === 'error'),
    diagnostics: parsed.diagnostics,
    ...overrides,
  };
}

export function reviewWorkflow(): Workflow {
  return parseWorkflowText(REVIEW_TEXT).workflow as Workflow;
}

/** Delivers a host message to the webview like VS Code does. */
export function host(message: HostToWorkflowEditor): void {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: message }));
  });
}

type Posted = { type: string; [key: string]: unknown };

export function posted(): Posted[] {
  return ((window as unknown as { __posted?: Posted[] }).__posted ?? []) as Posted[];
}

export function postedOps(): unknown[] {
  return posted()
    .filter((m) => m.type === 'ops')
    .flatMap((m) => m.ops as unknown[]);
}

export function clearPosted(): void {
  (window as unknown as { __posted?: unknown[] }).__posted = [];
}

/** jsdom lacks layout APIs the canvas uses to reveal blocks. */
export function stubLayout(): void {
  Element.prototype.scrollIntoView = vi.fn();
}

/** Renders the editor and sends the usual startup messages. */
export function renderEditor(
  doc: WorkflowDocumentState = docFor(REVIEW_TEXT),
  options: { trusted?: boolean } = {},
) {
  clearPosted();
  const utils = render(<WorkflowApp />);
  host({ type: 'document', doc });
  host({ type: 'catalog', agents: AGENTS, catalog: CATALOG });
  host({ type: 'trust', trusted: options.trusted ?? true });
  return utils;
}

export function card(container: HTMLElement, id: string): HTMLElement {
  const el = Array.from(container.querySelectorAll<HTMLElement>('[data-wf-card]')).find(
    (e) => e.dataset.stepId === id,
  );
  if (!el) throw new Error(`No card for ${id}`);
  return el;
}
