import { describe, expect, it } from 'vitest';
import type { Workflow, WorkflowSummary } from '@isar-flow/core';
import { checkInputs } from '../../../src/copilot/inputs';
import { lookupWorkflow, unavailableMessage } from '../../../src/copilot/lookup';
import { parseRunPrompt } from '../../../src/copilot/chatArgs';

const summary = (relativePath: string, name: string, overrides: Partial<WorkflowSummary> = {}) => ({
  uri: `file:///w/${relativePath}`,
  name,
  relativePath,
  valid: true,
  stepCount: 1,
  exposed: true,
  ...overrides,
});

const LIST: WorkflowSummary[] = [
  summary('.isarflow/workflows/release.workflow.yaml', 'Release'),
  summary('ops/release.workflow.yml', 'Release ops'),
  summary('.isarflow/workflows/deploy.workflow.yaml', 'Deploy'),
  summary('docs/deploy.workflow.yaml', 'Deploy'),
  summary('.isarflow/workflows/secret.workflow.yaml', 'Secret', { exposed: undefined }),
];

describe('lookupWorkflow', () => {
  it('finds exposed workflows by path, file name or name, ignoring case', () => {
    const found = (query: string) => {
      const result = lookupWorkflow(LIST, query);
      return result.kind === 'found' ? result.summary.relativePath : result.kind;
    };
    expect(found('.isarflow/workflows/release.workflow.yaml')).toBe(
      '.isarflow/workflows/release.workflow.yaml',
    );
    expect(found('.\\ops\\release.workflow.yml')).toBe('ops/release.workflow.yml');
    expect(found('C:/repo/w/docs/deploy.workflow.yaml')).toBe('docs/deploy.workflow.yaml');
    expect(found('RELEASE OPS')).toBe('ops/release.workflow.yml');
    expect(found('  Release ops ')).toBe('ops/release.workflow.yml');
  });

  it('lists the candidates of ambiguous names', () => {
    const result = lookupWorkflow(LIST, 'deploy');
    expect(result.kind).toBe('ambiguous');
    if (result.kind !== 'ambiguous') return;
    expect(result.candidates.map((c) => c.relativePath)).toEqual([
      '.isarflow/workflows/deploy.workflow.yaml',
      'docs/deploy.workflow.yaml',
    ]);
    expect(result.message).toBe(
      "'deploy' matches several workflows: Deploy (.isarflow/workflows/deploy.workflow.yaml), Deploy (docs/deploy.workflow.yaml). Use the workspace-relative path.",
    );
  });

  it('prefers an exact path over a file name match', () => {
    const result = lookupWorkflow(LIST, 'release.workflow.yaml');
    expect(result).toMatchObject({ kind: 'found', summary: { name: 'Release' } });
  });

  it('never finds workflows that are not exposed, nor unknown ones', () => {
    expect(lookupWorkflow(LIST, 'secret')).toEqual({
      kind: 'unavailable',
      message: unavailableMessage('secret'),
    });
    expect(lookupWorkflow(LIST, 'nothing')).toMatchObject({ kind: 'unavailable' });
    expect(lookupWorkflow(LIST, '   ')).toMatchObject({ kind: 'unavailable' });
    expect(unavailableMessage('secret')).toBe(
      "'secret' isn't available to Copilot. Set expose: true in its workflow file to allow it.",
    );
  });
});

describe('checkInputs', () => {
  const workflow = {
    version: 1,
    name: 'Release',
    inputs: {
      version: { type: 'string', required: true },
      count: { type: 'number', default: 1 },
      dryRun: { type: 'boolean' },
    },
    steps: [],
  } as Workflow;

  it('coerces the given values to the input types and keeps defaults for the run', () => {
    expect(checkInputs(workflow, { version: '1.2.0', count: '3', dryRun: 'true' })).toEqual({
      version: '1.2.0',
      count: 3,
      dryRun: true,
    });
    expect(checkInputs(workflow, { version: 2 })).toEqual({ version: '2' });
  });

  it('explains wrong types, missing required inputs and unknown names', () => {
    expect(() => checkInputs(workflow, { version: '1', count: 'many' })).toThrow(
      "Input 'count' must be a number, but got 'many'.",
    );
    expect(() => checkInputs(workflow, {})).toThrow("Input 'version' is required.");
    expect(() => checkInputs(workflow, undefined)).toThrow("Input 'version' is required.");
    expect(() => checkInputs(workflow, { version: '1', colour: 'red' })).toThrow(
      "Release has no input 'colour'. Its inputs: version, count, dryRun.",
    );
    expect(() => checkInputs({ ...workflow, inputs: undefined }, { a: 1 })).toThrow(
      "Release has no input 'a'. It has no inputs.",
    );
    expect(() => checkInputs(workflow, ['1'])).toThrow(
      'Pass inputs as an object with values by input name, e.g. { "version": "1.2.0" }.',
    );
  });

  it('accepts only yes/no words for boolean inputs, like the command line', () => {
    for (const [given, value] of [
      [false, false],
      ['No', false],
      ['off', false],
      [0, false],
      [true, true],
      [' yes ', true],
      ['1', true],
    ] as const) {
      expect(checkInputs(workflow, { version: '1', dryRun: given }).dryRun).toBe(value);
    }
    for (const given of ['nah', 'maybe', 2, { on: true }]) {
      expect(() => checkInputs(workflow, { version: '1', dryRun: given })).toThrow(
        `Input 'dryRun' must be true or false, but got '${typeof given === 'object' ? '{"on":true}' : String(given)}'.`,
      );
    }
  });
});

describe('parseRunPrompt', () => {
  it('reads the workflow and name=value inputs, with quotes', () => {
    expect(parseRunPrompt('release version=1.2.0 dryRun=true')).toEqual({
      workflow: 'release',
      inputs: { version: '1.2.0', dryRun: 'true' },
    });
    expect(parseRunPrompt('"Release ops" notes="first line, second" empty=""')).toEqual({
      workflow: 'Release ops',
      inputs: { notes: 'first line, second', empty: '' },
    });
    expect(parseRunPrompt("Release ops title='It''s here' x=a=b")).toEqual({
      workflow: 'Release ops',
      inputs: { title: 'Its here', x: 'a=b' },
    });
    expect(parseRunPrompt('  release  ')).toEqual({ workflow: 'release', inputs: {} });
  });

  it('says how to write the arguments when they are wrong', () => {
    expect(parseRunPrompt('')).toEqual({ error: 'Name a workflow: /run <workflow> [name=value …]' });
    expect(parseRunPrompt('version=1')).toEqual({ error: 'Name a workflow: /run <workflow> [name=value …]' });
    expect(parseRunPrompt('release version=1 extra')).toEqual({
      error: "Write inputs as name=value, e.g. version=1.2.0. 'extra' has no value.",
    });
    expect(parseRunPrompt('release "unclosed')).toEqual({
      error: 'A quote is not closed. Close it, then run again.',
    });
  });
});
