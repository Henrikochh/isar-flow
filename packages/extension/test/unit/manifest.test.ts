import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { projectConfigJsonSchema, simulationJsonSchema } from '@isar-flow/core';

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
  activationEvents?: string[];
  capabilities: {
    untrustedWorkspaces: { supported: string; description?: string; restrictedConfigurations?: string[] };
  };
  contributes: Record<string, unknown> & {
    configuration: { properties: Record<string, Setting> };
    commands: { command: string; title: string; category?: string; icon?: string }[];
    menus: Record<string, { command: string; when?: string; group?: string; alt?: string }[]>;
    yamlValidation: { fileMatch: string; url: string }[];
    languageModelTools?: Record<string, unknown>[];
    chatParticipants?: Record<string, unknown>[];
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

describe('package.json everyday use (Package C)', () => {
  it('contributes the Package C commands in the Isar Flow category', () => {
    expect(command('isarFlow.runWorkflowOnSelection')).toEqual({
      command: 'isarFlow.runWorkflowOnSelection',
      title: 'Run workflow on selection',
      category: 'Isar Flow',
      icon: '$(play)',
    });
    expect(command('isarFlow.exportRunReport')).toEqual({
      command: 'isarFlow.exportRunReport',
      title: 'Export run report',
      category: 'Isar Flow',
    });
    expect(command('isarFlow.copyRunForPr')).toEqual({
      command: 'isarFlow.copyRunForPr',
      title: 'Copy run for PR description',
      category: 'Isar Flow',
    });
    expect(command('isarFlow.showTriggers')).toEqual({
      command: 'isarFlow.showTriggers',
      title: 'Show triggers',
      category: 'Isar Flow',
    });
    expect(command('isarFlow.openMemory')).toEqual({
      command: 'isarFlow.openMemory',
      title: 'Open project memory',
      category: 'Isar Flow',
    });
  });

  it('offers Run workflow on selection in the editor context menu when text is selected', () => {
    const { menus } = manifest.contributes;
    expect(menus['editor/context']).toContainEqual({
      command: 'isarFlow.runWorkflowOnSelection',
      when: 'editorHasSelection && !isInDiffEditor',
      group: 'isarFlow@2',
    });
    expect(menus.commandPalette).toContainEqual({
      command: 'isarFlow.openMemory',
      when: 'workspaceFolderCount > 0',
    });
    const paletteIds = menus.commandPalette.map((entry) => entry.command);
    for (const id of [
      'isarFlow.runWorkflowOnSelection',
      'isarFlow.exportRunReport',
      'isarFlow.copyRunForPr',
    ]) {
      expect(paletteIds).not.toContain(id);
    }
  });

  it('has the setting that turns triggers off', () => {
    expect(settings['isarFlow.triggers.enabled']).toEqual({
      type: 'boolean',
      default: true,
      scope: 'window',
      markdownDescription:
        "Start workflows from their `on:` triggers (save, file change, schedule) while VS Code is open. Triggers only run in trusted workspaces and after you approved the workflow's commands once.",
    });
  });

  it('contributes the two Copilot tools', () => {
    expect(manifest.contributes.languageModelTools).toEqual([
      {
        name: 'isarflow_listWorkflows',
        displayName: 'List Isar Flow workflows',
        toolReferenceName: 'isarflowWorkflows',
        canBeReferencedInPrompt: true,
        userDescription: 'Lists the workflows Copilot may run.',
        modelDescription:
          'Lists the Isar Flow workflows of this workspace that the user allows Copilot to run, with their names, paths, descriptions and inputs. Call it before isarflow_runWorkflow.',
        tags: ['isarflow'],
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'isarflow_runWorkflow',
        displayName: 'Run an Isar Flow workflow',
        toolReferenceName: 'isarflowRun',
        canBeReferencedInPrompt: true,
        userDescription: 'Runs a workflow and returns its summary.',
        modelDescription:
          'Runs one Isar Flow workflow locally in VS Code and waits until it has finished. Returns the status, the outputs of its blocks and the files it changed. Only workflows listed by isarflow_listWorkflows can be run; the user confirms each run.',
        tags: ['isarflow'],
        inputSchema: {
          type: 'object',
          properties: {
            workflow: {
              type: 'string',
              description: 'Workflow name or workspace-relative path, as listed by isarflow_listWorkflows.',
            },
            inputs: {
              type: 'object',
              description: 'Input values by input name.',
              additionalProperties: true,
            },
          },
          required: ['workflow'],
        },
      },
    ]);
  });

  it('contributes the @isarflow chat participant with list, run and status', () => {
    expect(manifest.contributes.chatParticipants).toEqual([
      {
        id: 'isarFlow.chat',
        name: 'isarflow',
        fullName: 'Isar Flow',
        description: 'Run your local workflows',
        commands: [
          { name: 'list', description: 'List the workflows Copilot may run' },
          { name: 'run', description: 'Run a workflow: /run <workflow> [name=value …]' },
          { name: 'status', description: 'Show running and recent runs' },
        ],
      },
    ]);
  });

  it('validates .isarflow/config.yaml with the generated project config schema', () => {
    const url = './schemas/config.schema.json';
    expect(manifest.contributes.yamlValidation).toContainEqual({ fileMatch: '.isarflow/config.yaml', url });
    const schema: unknown = JSON.parse(fs.readFileSync(path.join(packageDir, url), 'utf8'));
    expect(schema).toEqual(projectConfigJsonSchema());
    const script = fs.readFileSync(path.join(packageDir, 'scripts/schemas.mjs'), 'utf8');
    expect(script).toContain('projectConfigJsonSchema');
    expect(script).toContain("'config.schema.json'");
  });

  it('contributes no MCP server, mode or transport', () => {
    const contributionKeys = Object.keys(manifest.contributes).map((key) => key.toLowerCase());
    expect(contributionKeys.filter((key) => key.includes('mcp'))).toEqual([]);
    expect((manifest.activationEvents ?? []).filter((event) => /mcp/i.test(event))).toEqual([]);
    expect(JSON.stringify(manifest.contributes)).not.toMatch(/mcp/i);
  });
});
