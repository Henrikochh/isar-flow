/** Unsent "New agent" / "New workflow" drafts, kept in the webview state so they survive the view being hidden. */
import { useEffect, useState } from 'react';
import type { AgentScope, WorkflowTemplateId } from '@isar-flow/core';
import { getViewState, setViewState } from '../../vscode';
import type { AgentStarter } from './model';

export interface AgentDraft {
  name: string;
  starter: AgentStarter;
  scope: AgentScope;
}

export interface WorkflowDraft {
  name: string;
  template: WorkflowTemplateId;
}

export interface SidebarViewState {
  /** Present while the "New agent" card is open. */
  agentDraft?: AgentDraft;
  /** Present while the "New workflow" card is open. */
  workflowDraft?: WorkflowDraft;
}

export const NEW_AGENT_DRAFT: AgentDraft = { name: '', starter: 'blank', scope: 'workspace' };
export const NEW_WORKFLOW_DRAFT: WorkflowDraft = { name: '', template: 'blank' };

const STARTERS: readonly string[] = ['blank', 'coder', 'reviewer'];
const SCOPES: readonly string[] = ['workspace', 'user'];
const TEMPLATES: readonly string[] = ['blank', 'review-loop', 'test-fix'];

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

const str = (value: unknown) => (typeof value === 'string' ? value : '');

/** Reads persisted state defensively: it may come from an older version of the webview. */
export function parseViewState(raw: unknown): SidebarViewState {
  const state = record(raw);
  const result: SidebarViewState = {};
  const agent = record(state?.agentDraft);
  if (agent) {
    result.agentDraft = {
      name: str(agent.name),
      starter: STARTERS.includes(str(agent.starter)) ? (agent.starter as AgentStarter) : 'blank',
      scope: SCOPES.includes(str(agent.scope)) ? (agent.scope as AgentScope) : 'workspace',
    };
  }
  const workflow = record(state?.workflowDraft);
  if (workflow) {
    result.workflowDraft = {
      name: str(workflow.name),
      template: TEMPLATES.includes(str(workflow.template)) ? (workflow.template as WorkflowTemplateId) : 'blank',
    };
  }
  return result;
}

export function useSidebarViewState() {
  const [state, setState] = useState<SidebarViewState>(() => parseViewState(getViewState()));
  useEffect(() => {
    setViewState(state);
  }, [state]);
  const setAgentDraft = (agentDraft: AgentDraft | undefined) => setState((prev) => ({ ...prev, agentDraft }));
  const setWorkflowDraft = (workflowDraft: WorkflowDraft | undefined) => setState((prev) => ({ ...prev, workflowDraft }));
  return { ...state, setAgentDraft, setWorkflowDraft };
}
