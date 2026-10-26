import { describe, expect, it } from 'vitest';
import { workflowTemplate } from '@isar-flow/core';
import { summarizeWorkflow, usersOfAgent, type WorkflowRecord } from '../../../src/store/workflowIndex';

const NESTED = `version: 1
name: Nested
description: Loops and branches
steps:
  - id: plan
    type: agent
    agent: planner
    prompt: Plan
  - id: loop
    type: loop
    maxIterations: 3
    until: "\${{ true }}"
    steps:
      - id: check
        type: if
        condition: "\${{ true }}"
        then:
          - id: fix
            type: agent
            agent: coder
            prompt: Fix
        else:
          - id: inline
            type: agent
            agent: { model: a/b }
            prompt: Hi
  - id: done
    type: console
    run: echo done
`;

describe('summarizeWorkflow', () => {
  it('summarizes a valid workflow and counts nested blocks', () => {
    const record = summarizeWorkflow(NESTED, 'file:///ws/a.workflow.yaml', 'flows/a.workflow.yaml');
    expect(record.summary).toEqual({
      uri: 'file:///ws/a.workflow.yaml',
      name: 'Nested',
      description: 'Loops and branches',
      relativePath: 'flows/a.workflow.yaml',
      valid: true,
      stepCount: 6,
    });
    expect(record.agents).toEqual(['coder', 'planner']);
  });

  it('counts the blocks of the templates', () => {
    const record = summarizeWorkflow(workflowTemplate('review-loop', 'Review'), 'u', 'r.workflow.yaml');
    expect(record.summary).toMatchObject({ name: 'Review', valid: true, stepCount: 6 });
    expect(record.agents).toEqual(['coder', 'reviewer']);
  });

  it('falls back to the file name when the YAML has no usable name', () => {
    const record = summarizeWorkflow(
      'version: 1\nsteps:\n  - id: a\n    type: break\n',
      'u',
      'x/My flow.workflow.yml',
    );
    expect(record.summary).toMatchObject({ name: 'My flow', valid: false, stepCount: 1 });
    expect(record.summary.description).toBeUndefined();
  });

  it('marks unreadable files invalid without blocks', () => {
    for (const text of ['', 'steps: [unclosed\n', '- just a list\n']) {
      const record = summarizeWorkflow(text, 'u', '.isarflow/workflows/broken.workflow.yaml');
      expect(record.summary).toMatchObject({ name: 'broken', valid: false, stepCount: 0 });
      expect(record.agents).toEqual([]);
    }
  });

  it('counts blocks of schema-invalid workflows leniently', () => {
    const text =
      'version: 1\nname: Half\nsteps:\n  - id: a\n    type: agent\n    agent: coder\n  - not a block\n';
    const record = summarizeWorkflow(text, 'u', 'h.workflow.yaml');
    expect(record.summary).toMatchObject({ name: 'Half', valid: false, stepCount: 1 });
    expect(record.agents).toEqual(['coder']);
  });
});

describe('usersOfAgent', () => {
  const record = (relativePath: string, agents: string[]): WorkflowRecord => ({
    summary: {
      uri: `file:///ws/${relativePath}`,
      name: relativePath,
      relativePath,
      valid: true,
      stepCount: 1,
    },
    agents,
  });

  it('lists the relative paths of workflows that reference the agent, sorted', () => {
    const records = [record('b.workflow.yaml', ['coder']), record('a.workflow.yaml', ['coder', 'reviewer'])];
    expect(usersOfAgent(records, 'coder')).toEqual(['a.workflow.yaml', 'b.workflow.yaml']);
    expect(usersOfAgent(records, 'reviewer')).toEqual(['a.workflow.yaml']);
    expect(usersOfAgent(records, 'planner')).toEqual([]);
  });
});
