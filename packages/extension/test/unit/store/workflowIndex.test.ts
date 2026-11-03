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

  it('marks workflows Copilot may run and those that read the editor, and lists their triggers', () => {
    const text = [
      'version: 1',
      'name: Release',
      'description: Ships it',
      'on:',
      '  save: { files: "src/*.ts" }',
      '  schedule: { every: 1h }',
      'expose: true',
      'steps:',
      '  - id: explain',
      '    type: console',
      '    run: echo "${{ editor.selection }}"',
      '',
    ].join('\n');
    const record = summarizeWorkflow(text, 'u', 'release.workflow.yaml');
    expect(record.summary).toMatchObject({ name: 'Release', valid: true, exposed: true, usesEditor: true });
    expect(record.summary.triggers).toEqual([
      { kind: 'save', label: 'On save: src/*.ts', files: ['src/*.ts'] },
      expect.objectContaining({ kind: 'schedule', every: '1h', everyMs: 3_600_000 }),
    ]);
  });

  it('leaves the Package C fields out when they do not apply', () => {
    const text =
      'version: 1\nname: Plain\nexpose: false\nsteps:\n  - id: a\n    type: console\n    run: echo hi\n';
    const { summary } = summarizeWorkflow(text, 'u', 'plain.workflow.yaml');
    expect(summary).not.toHaveProperty('exposed');
    expect(summary).not.toHaveProperty('triggers');
    expect(summary).not.toHaveProperty('usesEditor');
  });

  it('lists the triggers of workflows with problems, which do not fire then', () => {
    const text = 'version: 1\nname: Broken\non:\n  change: { files: ["docs/**"] }\nsteps: 3\n';
    const { summary } = summarizeWorkflow(text, 'u', 'broken.workflow.yaml');
    expect(summary.valid).toBe(false);
    expect(summary.triggers).toEqual([{ kind: 'change', label: 'On change: docs/**', files: ['docs/**'] }]);
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
