import { describe, expect, it } from 'vitest';
import {
  agentCapabilities,
  AgentDefinitionSchema,
  AgentSettingsSchema,
  agentJsonSchema,
  WorkflowSchema,
  workflowJsonSchema,
} from '../src/schema';
import { applyAgentUpdate, applyWorkflowOps } from '../src/yaml';

const workflow = (extra: Record<string, unknown>) => ({
  version: 1,
  name: 'Fix tests',
  ...extra,
  steps: [{ id: 'tests', type: 'console', run: 'npm test' }],
});

const agent = (extra: Record<string, unknown>) => ({ name: 'Coder', model: 'litellm/gpt-4.1', ...extra });

describe('workflow isolation and setup', () => {
  it('accepts isolation workspace and worktree with setup commands', () => {
    expect(WorkflowSchema.safeParse(workflow({ isolation: 'workspace' })).success).toBe(true);
    expect(WorkflowSchema.safeParse(workflow({ isolation: 'worktree', setup: ['npm ci'] })).success).toBe(
      true,
    );
  });

  it('rejects unknown isolation values and empty or non-string setup commands', () => {
    expect(WorkflowSchema.safeParse(workflow({ isolation: 'container' })).success).toBe(false);
    expect(WorkflowSchema.safeParse(workflow({ setup: [''] })).success).toBe(false);
    expect(WorkflowSchema.safeParse(workflow({ setup: 'npm ci' })).success).toBe(false);
    expect(WorkflowSchema.safeParse(workflow({ setup: [42] })).success).toBe(false);
  });

  it('documents the new keys in the JSON schema', () => {
    const properties = (workflowJsonSchema() as { properties: Record<string, unknown> }).properties;
    expect(properties).toHaveProperty('isolation');
    expect(properties).toHaveProperty('setup');
  });
});

describe('agent toolMode and applyPatch', () => {
  it('accepts every tool mode in agent files and inline settings', () => {
    for (const toolMode of ['auto', 'native', 'text']) {
      expect(AgentDefinitionSchema.safeParse(agent({ toolMode })).success).toBe(true);
      expect(AgentSettingsSchema.safeParse({ toolMode }).success).toBe(true);
    }
  });

  it('rejects unknown tool modes', () => {
    expect(AgentDefinitionSchema.safeParse(agent({ toolMode: 'json' })).success).toBe(false);
  });

  it('knows the applyPatch tool', () => {
    expect(AgentDefinitionSchema.safeParse(agent({ tools: ['readFile', 'applyPatch'] })).success).toBe(true);
    const properties = (agentJsonSchema() as { properties: Record<string, unknown> }).properties;
    expect(JSON.stringify(properties.tools)).toContain('applyPatch');
    expect(properties).toHaveProperty('toolMode');
  });
});

describe('canonical position of the new keys', () => {
  it('puts isolation and setup after env and before steps', () => {
    const text = 'version: 1\nname: Fix tests\nenv:\n  CI: "1"\nsteps: []\n';
    const result = applyWorkflowOps(text, [
      { op: 'updateWorkflow', set: { setup: ['npm ci'], isolation: 'worktree' } },
    ]);
    expect(result.error).toBeUndefined();
    expect(result.text).toBe(
      'version: 1\nname: Fix tests\nenv:\n  CI: "1"\nisolation: worktree\nsetup:\n  - npm ci\nsteps: []\n',
    );
  });

  it('puts toolMode right after tools in agent files', () => {
    const text = 'name: Coder\nmodel: litellm/gpt-4.1\ntools: [readFile]\npermissions: { edits: ask }\n';
    const result = applyAgentUpdate(text, { toolMode: 'text' });
    expect(result.text).toBe(
      'name: Coder\nmodel: litellm/gpt-4.1\ntools: [readFile]\ntoolMode: text\npermissions: { edits: ask }\n',
    );
  });
});

describe('agentCapabilities', () => {
  const kinds = (settings: Parameters<typeof agentCapabilities>[0]) =>
    agentCapabilities(settings).map((c) => c.text);

  it('calls agents read-only when they cannot edit files or run commands', () => {
    expect(kinds({ tools: ['readFile', 'searchText'] })).toEqual(['Read-only']);
    expect(kinds({ tools: [] })).toEqual(['Read-only']);
    expect(kinds(undefined)).toEqual(['Read-only']);
    expect(kinds(null)).toEqual(['Read-only']);
  });

  it('names edits and commands with the effective permission level ("ask" when unset)', () => {
    expect(kinds({ tools: ['editFile', 'runCommand'] })).toEqual([
      'Edits files (asks)',
      'Runs commands (asks)',
    ]);
    expect(kinds({ tools: ['applyPatch'], permissions: { edits: 'auto' } })).toEqual(['Edits files (auto)']);
    expect(
      kinds({ tools: ['writeFile', 'runCommand'], permissions: { edits: 'auto', commands: 'auto' } }),
    ).toEqual(['Edits files (auto)', 'Runs commands (auto)']);
  });

  it('ignores tools whose permission is "none" and unknown tool names', () => {
    expect(
      kinds({ tools: ['editFile', 'runCommand'], permissions: { edits: 'none', commands: 'none' } }),
    ).toEqual(['Read-only']);
    expect(kinds({ tools: ['deleteRepo', 42] as never })).toEqual(['Read-only']);
  });

  it('treats unknown permission values like the default "ask"', () => {
    expect(kinds({ tools: ['editFile'], permissions: { edits: 'sometimes' as never } })).toEqual([
      'Edits files (asks)',
    ]);
  });

  it('gives each badge a kind, level, icon and tooltip', () => {
    const [edits, commands] = agentCapabilities({
      tools: ['editFile', 'runCommand'],
      permissions: { edits: 'auto' },
    });
    expect(edits).toMatchObject({ kind: 'edits', level: 'auto', label: 'Edits files', icon: 'edit' });
    expect(edits.title).toMatch(/without asking/);
    expect(commands).toMatchObject({
      kind: 'commands',
      level: 'ask',
      label: 'Runs commands',
      icon: 'terminal',
    });
    expect(commands.title).toMatch(/after you allow/);
    const [readOnly] = agentCapabilities({ tools: ['readFile'] });
    expect(readOnly).toMatchObject({ kind: 'read-only', label: 'Read-only', icon: 'eye' });
    expect(readOnly.level).toBeUndefined();
  });
});
