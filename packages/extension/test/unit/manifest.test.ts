import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

interface Setting {
  type?: string;
  scope?: string;
  default?: unknown;
  minimum?: number;
  description?: string;
  markdownDescription?: string;
  additionalProperties?: {
    type?: string;
    required?: string[];
    properties?: Record<string, { type?: string; minimum?: number }>;
  };
}

interface Manifest {
  capabilities: { untrustedWorkspaces: { supported: string; restrictedConfigurations?: string[] } };
  contributes: {
    configuration: { properties: Record<string, Setting> };
    commands: { command: string; title: string; category?: string; icon?: string }[];
    menus: Record<string, { command: string; when?: string; group?: string }[]>;
  };
}

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8')) as Manifest;
const settings = manifest.contributes.configuration.properties;
const command = (id: string) => manifest.contributes.commands.find((c) => c.command === id);

describe('package.json security settings', () => {
  it('does not take model endpoints from an untrusted workspace (they would receive stored API keys)', () => {
    expect(manifest.capabilities.untrustedWorkspaces.restrictedConfigurations).toContain(
      'isarFlow.providers',
    );
  });

  it('lets only the user turn off the confirmation of console commands', () => {
    // A repository could otherwise switch the question off in its .vscode/settings.json.
    expect(settings['isarFlow.confirmCommands'].scope).toBe('application');
  });
});

describe('package.json model settings and commands', () => {
  it('has the context size for agent conversations', () => {
    expect(settings['isarFlow.agentContextTokens']).toEqual({
      type: 'number',
      default: 24000,
      minimum: 2000,
      description:
        "Context size in tokens for models that don't report one. Agent conversations are summarized at 70 % of it.",
    });
  });

  it('has model prices per 1 million tokens', () => {
    const prices = settings['isarFlow.modelPrices'];
    expect(prices).toMatchObject({ type: 'object', default: {} });
    expect(prices.additionalProperties).toMatchObject({
      type: 'object',
      required: ['input', 'output'],
      properties: { input: { type: 'number', minimum: 0 }, output: { type: 'number', minimum: 0 } },
    });
    expect(prices.markdownDescription).toContain('litellm/gpt-4.1');
    expect(prices.markdownDescription).toContain('1 million tokens');
  });

  it('says that pruning old runs removes their snapshots and worktrees', () => {
    expect(settings['isarFlow.historyLimit'].description).toMatch(/snapshots and worktrees/);
  });

  it('contributes Check setup and Test model', () => {
    expect(command('isarFlow.checkSetup')).toEqual({
      command: 'isarFlow.checkSetup',
      title: 'Check setup',
      category: 'Isar Flow',
      icon: '$(checklist)',
    });
    expect(command('isarFlow.testModel')).toEqual({
      command: 'isarFlow.testModel',
      title: 'Test model',
      category: 'Isar Flow',
      icon: '$(beaker)',
    });
    expect(manifest.contributes.menus['view/title']).toContainEqual({
      command: 'isarFlow.checkSetup',
      when: 'view == isarFlow.sidebar',
      group: 'overflow',
    });
  });
});
