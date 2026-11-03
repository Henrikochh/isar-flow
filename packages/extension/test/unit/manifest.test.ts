import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { simulationJsonSchema } from '@isar-flow/core';

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
  capabilities: {
    untrustedWorkspaces: { supported: string; description?: string; restrictedConfigurations?: string[] };
  };
  contributes: {
    configuration: { properties: Record<string, Setting> };
    commands: { command: string; title: string; category?: string; icon?: string }[];
    menus: Record<string, { command: string; when?: string; group?: string; alt?: string }[]>;
    yamlValidation: { fileMatch: string; url: string }[];
  };
}

const packageDir = path.join(__dirname, '../..');
const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8')) as Manifest;
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

describe('package.json simulation', () => {
  it('contributes Simulate workflow', () => {
    expect(command('isarFlow.simulateWorkflow')).toEqual({
      command: 'isarFlow.simulateWorkflow',
      title: 'Simulate workflow',
      category: 'Isar Flow',
      icon: '$(beaker)',
    });
  });

  it('validates simulation files with the generated schema', () => {
    const url = './schemas/simulation.schema.json';
    expect(manifest.contributes.yamlValidation).toEqual(
      expect.arrayContaining([
        { fileMatch: '**/.isarflow/simulations/*.sim.yaml', url },
        { fileMatch: '**/.isarflow/simulations/*.sim.yml', url },
      ]),
    );
    const schema: unknown = JSON.parse(fs.readFileSync(path.join(packageDir, url), 'utf8'));
    // scripts/schemas.mjs writes it on every build; a stale copy means the build was not run.
    expect(schema).toEqual(simulationJsonSchema());
    expect(schema).toMatchObject({ title: 'Isar Flow simulation mocks' });
  });

  it('generates the simulation schema with the other schemas', () => {
    const script = fs.readFileSync(path.join(packageDir, 'scripts/schemas.mjs'), 'utf8');
    expect(script).toContain('simulationJsonSchema');
    expect(script).toContain("'simulation.schema.json'");
  });

  it('contributes Open simulation file', () => {
    expect(command('isarFlow.openSimulationFile')).toEqual({
      command: 'isarFlow.openSimulationFile',
      title: 'Open simulation file',
      category: 'Isar Flow',
    });
  });

  it('offers Simulate next to Run: Alt-click on the Run button and the explorer menu', () => {
    const { menus } = manifest.contributes;
    expect(menus['editor/title'].find((m) => m.command === 'isarFlow.runWorkflow')).toMatchObject({
      alt: 'isarFlow.simulateWorkflow',
    });
    expect(menus['explorer/context']).toContainEqual({
      command: 'isarFlow.simulateWorkflow',
      when: 'resourceFilename =~ /\\.workflow\\.ya?ml$/',
      group: 'isarFlow@1',
    });
  });

  it('says that workflows can be simulated in Restricted Mode', () => {
    expect(manifest.capabilities.untrustedWorkspaces.description).toBe(
      'Workflows and agents can be viewed, edited and simulated, but not run, in Restricted Mode.',
    );
  });
});

describe('package.json run from here', () => {
  it('contributes Run from here in the palette and the YAML context menu of workflows', () => {
    expect(command('isarFlow.runFromHere')).toEqual({
      command: 'isarFlow.runFromHere',
      title: 'Run from here',
      category: 'Isar Flow',
      icon: '$(debug-continue)',
    });
    expect(manifest.contributes.menus['editor/context']).toContainEqual({
      command: 'isarFlow.runFromHere',
      when: 'resourceFilename =~ /\\.workflow\\.ya?ml$/',
      group: 'isarFlow@1',
    });
  });
});
