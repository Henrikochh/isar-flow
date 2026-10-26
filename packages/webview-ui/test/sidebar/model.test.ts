import { describe, expect, it } from 'vitest';
import type { AgentSummary } from '@isar-flow/core';
import { RECENT_RUNS, WORKFLOWS } from '../../harness/fixtures';
import { agentLabel, agentReach, fileBaseName, fitPath, slugOf, templateOutline, uniqueKeys, workflowRunState } from '../../src/views/sidebar/model';
import { parseViewState } from '../../src/views/sidebar/viewState';

describe('sidebar model helpers', () => {
  it('makes React keys unique even when ids are missing or repeated', () => {
    expect(uniqueKeys(['a', '', 'a', undefined, 'a'], (id) => id)).toEqual(['a', '#1', 'a~1', '#3', 'a~2']);
  });

  it('labels agents from name, id or file name', () => {
    const base: Omit<AgentSummary, 'id' | 'name' | 'uri'> = { model: '', tools: [], scope: 'workspace', valid: false };
    expect(agentLabel({ ...base, id: 'coder', name: ' Coder ', uri: '' })).toBe('Coder');
    expect(agentLabel({ ...base, id: 'coder', name: '', uri: '' })).toBe('coder');
    expect(agentLabel({ ...base, id: '', name: '', uri: 'file:///c%3A/a/my%20agent.agent.yaml' })).toBe('my agent');
    expect(fileBaseName('file:///c%3A/x/%E0%A4%A.yaml')).toBe('%E0%A4%A.yaml');
  });

  it('derives what an agent may do from its tools', () => {
    const agent = { tools: ['readFile', 'editFile', 'writeFile', 'readFile', 'bogus'] } as unknown as AgentSummary;
    expect(agentReach(agent)).toEqual({ tools: 4, edits: true, commands: false });
    expect(agentReach({ tools: undefined } as unknown as AgentSummary)).toEqual({ tools: 0, edits: false, commands: false });
  });

  it('fits paths by dropping whole leading folders, never half a folder name', () => {
    const path = '.isarflow/workflows/review-loop.workflow.yaml';
    expect(fitPath(path, 60)).toBe(path);
    expect(fitPath(path, path.length)).toBe(path);
    expect(fitPath(path, 40)).toBe('…/workflows/review-loop.workflow.yaml');
    expect(fitPath('a/b/c/d/file.yaml', 15)).toBe('…/c/d/file.yaml');
    expect(fitPath('a/b/c/d/file.yaml', 14)).toBe('…/d/file.yaml');
    // No folder fits: the bare file name (CSS cuts its end if needed).
    expect(fitPath(path, 30)).toBe('review-loop.workflow.yaml');
    expect(fitPath(path, 10)).toBe('review-loop.workflow.yaml');
    expect(fitPath('broken.workflow.yaml', 5)).toBe('broken.workflow.yaml');
  });

  it('slugs names the way file names are usually derived', () => {
    expect(slugOf('  Docs Writer! ')).toBe('docs-writer');
  });

  it('finds the active run of a workflow by uri, run id or running record', () => {
    const [review] = WORKFLOWS;
    const live = { ...RECENT_RUNS[0], runId: 'run-live', status: 'running' as const };
    expect(workflowRunState(review, { activeRuns: [], recentRuns: RECENT_RUNS })).toEqual({ running: false });
    expect(workflowRunState(review, { activeRuns: [review.uri], recentRuns: RECENT_RUNS })).toEqual({ running: true, runId: undefined, startedAt: undefined });
    expect(workflowRunState(review, { activeRuns: [review.uri], recentRuns: [live, ...RECENT_RUNS] }).runId).toBe('run-live');
    expect(workflowRunState(review, { activeRuns: ['run-live'], recentRuns: [live] }).running).toBe(true);
    expect(workflowRunState(WORKFLOWS[1], { activeRuns: [review.uri], recentRuns: [live] }).running).toBe(false);
  });

  it('outlines templates from the real template YAML', () => {
    expect(templateOutline('blank')).toEqual([]);
    const testFix = templateOutline('test-fix');
    expect(testFix.map((node) => node.type)).toEqual(['loop']);
    expect(testFix[0].children.map((node) => node.type)).toEqual(['console', 'if']);
    expect(templateOutline('review-loop').map((node) => node.type)).toEqual(['agent', 'loop']);
  });

  it('reads persisted drafts defensively', () => {
    expect(parseViewState(undefined)).toEqual({});
    expect(parseViewState({ agentDraft: { name: 5, starter: 'wizard', scope: 'user' } })).toEqual({
      agentDraft: { name: '', starter: 'blank', scope: 'user' },
    });
    expect(parseViewState({ workflowDraft: { name: 'X', template: 'review-loop' } })).toEqual({
      workflowDraft: { name: 'X', template: 'review-loop' },
    });
  });
});
