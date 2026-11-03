import { describe, expect, it } from 'vitest';
import {
  AgentSettingsSchema,
  DURATION_PATTERN,
  ProjectConfigSchema,
  projectConfigJsonSchema,
  SimulationResultSchema,
  STEP_TYPE_INFO,
  STEP_TYPES,
  StepSchema,
  WorkflowSchema,
  workflowJsonSchema,
} from '../src/schema';

const workflow = (extra: Record<string, unknown>) => ({ version: 1, name: 'W', steps: [], ...extra });

describe('ask block schema', () => {
  it('accepts a question with optional choices and default', () => {
    expect(StepSchema.safeParse({ id: 'pick', type: 'ask', question: 'Deploy?' }).success).toBe(true);
    const full = { id: 'pick', type: 'ask', question: 'Env?', choices: ['dev', 'prod'], default: 'dev' };
    expect(StepSchema.safeParse(full).success).toBe(true);
    expect(StepSchema.safeParse({ ...full, timeout: 60 }).success).toBe(true);
  });

  it('rejects an empty question, empty choices and unknown keys', () => {
    expect(StepSchema.safeParse({ id: 'a', type: 'ask', question: '' }).success).toBe(false);
    expect(StepSchema.safeParse({ id: 'a', type: 'ask' }).success).toBe(false);
    expect(StepSchema.safeParse({ id: 'a', type: 'ask', question: 'Q', choices: [] }).success).toBe(false);
    expect(StepSchema.safeParse({ id: 'a', type: 'ask', question: 'Q', choices: [''] }).success).toBe(false);
    expect(StepSchema.safeParse({ id: 'a', type: 'ask', question: 'Q', options: ['x'] }).success).toBe(false);
    expect(StepSchema.safeParse({ id: 'a', type: 'ask', question: 'Q', default: 3 }).success).toBe(false);
  });

  it('is a leaf block type with a label', () => {
    expect(STEP_TYPES).toContain('ask');
    expect(STEP_TYPE_INFO.ask).toMatchObject({ type: 'ask', label: 'Ask', container: false });
  });
});

describe('workflow triggers and expose', () => {
  it('accepts save, change and schedule triggers and expose', () => {
    const on = {
      save: { files: 'src/**/*.ts' },
      change: { files: ['docs/**', '!docs/generated/**'] },
      schedule: { every: '1h30m' },
    };
    expect(WorkflowSchema.safeParse(workflow({ on, expose: true })).success).toBe(true);
    expect(WorkflowSchema.safeParse(workflow({ on: {} })).success).toBe(true);
    expect(WorkflowSchema.safeParse(workflow({ expose: false })).success).toBe(true);
  });

  it('rejects malformed triggers', () => {
    const bad = [
      { on: { save: {} } },
      { on: { save: { files: '' } } },
      { on: { change: { files: [] } } },
      { on: { change: { files: [''] } } },
      { on: { schedule: { every: 'hourly' } } },
      { on: { schedule: { every: '15' } } },
      { on: { push: {} } },
      { on: { save: { files: 'a', glob: 'b' } } },
      { expose: 'yes' },
    ];
    for (const extra of bad)
      expect(WorkflowSchema.safeParse(workflow(extra)).success, JSON.stringify(extra)).toBe(false);
  });

  it('has a duration pattern for schedules', () => {
    for (const ok of ['90s', '15m', '1h', '1h30m', '2d']) expect(DURATION_PATTERN.test(ok), ok).toBe(true);
    for (const bad of ['', '15', 'm', '1.5h', '1 h', '-1m', '1w'])
      expect(DURATION_PATTERN.test(bad), bad).toBe(false);
  });

  it('documents the new keys in the workflow JSON schema', () => {
    const schema = workflowJsonSchema() as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties)).toEqual(expect.arrayContaining(['on', 'expose']));
  });
});

describe('agent memory setting', () => {
  it('accepts none, read and write', () => {
    for (const memory of ['none', 'read', 'write']) {
      expect(AgentSettingsSchema.safeParse({ memory }).success, memory).toBe(true);
    }
    expect(AgentSettingsSchema.safeParse({ memory: 'all' }).success).toBe(false);
  });
});

describe('simulation answers for ask blocks', () => {
  it('accepts an answer', () => {
    expect(SimulationResultSchema.safeParse({ answer: 'prod' }).success).toBe(true);
    expect(SimulationResultSchema.safeParse({ answer: 1 }).success).toBe(false);
  });
});

describe('project config (.isarflow/config.yaml)', () => {
  it('accepts OpenAI-compatible providers with the API key in an environment variable', () => {
    const config = {
      version: 1,
      providers: [
        {
          id: 'litellm',
          label: 'LiteLLM',
          baseUrl: 'http://localhost:4000/v1',
          apiKeyEnv: 'LITELLM_API_KEY',
          discoverModels: false,
          models: ['gpt-4.1'],
          headers: { 'X-Team': 'a' },
        },
        { id: 'ollama', baseUrl: 'http://localhost:11434/v1' },
      ],
    };
    expect(ProjectConfigSchema.safeParse(config).success).toBe(true);
    expect(ProjectConfigSchema.safeParse({}).success).toBe(true);
  });

  it('never accepts an API key in the file, and rejects bad ids and URLs', () => {
    const provider = { id: 'litellm', baseUrl: 'http://localhost:4000/v1' };
    expect(ProjectConfigSchema.safeParse({ providers: [{ ...provider, apiKey: 'sk-1' }] }).success).toBe(
      false,
    );
    expect(ProjectConfigSchema.safeParse({ providers: [{ ...provider, id: 'Lite LLM' }] }).success).toBe(
      false,
    );
    expect(ProjectConfigSchema.safeParse({ providers: [{ ...provider, id: 'vscode' }] }).success).toBe(false);
    expect(
      ProjectConfigSchema.safeParse({ providers: [{ ...provider, baseUrl: 'localhost:4000' }] }).success,
    ).toBe(false);
    expect(ProjectConfigSchema.safeParse({ version: 2 }).success).toBe(false);
  });

  it('has a JSON schema for the YAML extension', () => {
    const schema = projectConfigJsonSchema() as { title: string; properties: Record<string, unknown> };
    expect(schema.title).toBe('Isar Flow project config');
    expect(Object.keys(schema.properties)).toEqual(['version', 'providers']);
  });
});
