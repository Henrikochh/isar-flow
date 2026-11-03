import { describe, expect, it } from 'vitest';
import type { ActiveRunSummary, AgentSummary } from '@isar-flow/core';
import { WORKFLOWS } from '../../harness/fixtures';
import {
  activeRunOf,
  agentLabel,
  fileBaseName,
  fitPath,
  slugOf,
  templateOutline,
  toolCount,
  uniqueKeys,
} from '../../src/views/sidebar/model';
import { parseViewState } from '../../src/views/sidebar/viewState';

describe('sidebar model helpers', () => {
  it('makes React keys unique even when ids are missing or repeated', () => {
    expect(uniqueKeys(['a', '', 'a', undefined, 'a'], (id) => id)).toEqual(['a', '#1', 'a~1', '#3', 'a~2']);
  });

  it('labels agents from name, id or file name', () => {
    const base: Omit<AgentSummary, 'id' | 'name' | 'uri'> = {
      model: '',
      tools: [],
      scope: 'workspace',
      valid: false,
    };
    expect(agentLabel({ ...base, id: 'coder', name: ' Coder ', uri: '' })).toBe('Coder');
    expect(agentLabel({ ...base, id: 'coder', name: '', uri: '' })).toBe('coder');
    expect(agentLabel({ ...base, id: '', name: '', uri: 'file:///c%3A/a/my%20agent.agent.yaml' })).toBe(
      'my agent',
    );
    expect(fileBaseName('file:///c%3A/x/%E0%A4%A.yaml')).toBe('%E0%A4%A.yaml');
  });

  it('counts the distinct tools of an agent', () => {
    const agent = {
      tools: ['readFile', 'editFile', 'writeFile', 'readFile', 'bogus'],
    } as unknown as AgentSummary;
    expect(toolCount(agent)).toBe(4);
    expect(toolCount({ tools: undefined } as unknown as AgentSummary)).toBe(0);
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

  it('finds the newest active run of a workflow by its uri', () => {
    const [review, testFix] = WORKFLOWS;
    const active = (runId: string, workflowUri: string, startedAt: number): ActiveRunSummary => ({
      runId,
      workflowUri,
      workflowName: 'Any',
      startedAt,
    });
    expect(activeRunOf(review, [])).toBeUndefined();
    expect(activeRunOf(review, [active('run-8', testFix.uri, 1)])).toBeUndefined();
    expect(
      activeRunOf(review, [
        active('run-8', review.uri, 1),
        active('run-9', review.uri, 2),
        active('run-7', review.uri, 0),
      ])?.runId,
    ).toBe('run-9');
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
