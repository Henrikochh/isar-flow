import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

interface Manifest {
  capabilities: { untrustedWorkspaces: { supported: string; restrictedConfigurations?: string[] } };
  contributes: { configuration: { properties: Record<string, { scope?: string }> } };
}

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8')) as Manifest;
const settings = manifest.contributes.configuration.properties;

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
